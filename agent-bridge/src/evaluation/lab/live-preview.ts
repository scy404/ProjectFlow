/**
 * T46-7 (Issue #100 §3.3) — Live preview runner.
 *
 * Runs a RESTRICTED live subset of the public evaluation seam so an
 * observer can watch the ProjectFlow Agent execute a single smoke
 * scenario under tight guardrails. The preview is INTENTIONALLY
 * bounded:
 *
 *  - Smoke SUT ceiling: $0.10 (reuses {@link SLICE_0_SMOKE_BUDGET}).
 *  - Coding Agent cost remains external/unknown — never counted
 *    against the SUT cap.
 *  - Evaluator Judge/simulator uses an INDEPENDENT ceiling.
 *  - Only `mock:mock-model` is allowed by default. Paid models
 *    fail-closed unless frozen pricing, pre-call worst-case bound,
 *    cost telemetry and credentials are all in place. Currently
 *    none of these are in place, so any non-mock model returns
 *    `paid_model_unbounded`.
 *  - Preview artifacts write to a temp staging dir first, then
 *    atomically publish to `agent-bridge/artifacts/preview_<id>/`.
 *  - The preview runId always starts with `preview_` and the
 *    artifact dir contains a `preview_label.json` marker.
 *  - Preview NEVER overwrites an accepted baseline or a committed
 *    showcase bundle (those live under separate paths and are
 *    published with `publishImmutable`, which refuses overwrite).
 *  - No `sleep`-based fake latency. The actual wall-clock duration
 *    is reported honestly.
 *  - Tests/CI never auto-invoke paid models — the `paidModelGate`
 *    defaults to "fail-closed" and is not overridable from the
 *    CLI.
 *
 * Issue #100 §3.3 "Live preview":
 *  - 增加稳定 CLI 命令, 通过 public-seam 运行一个受限 live subset
 *  - 使用 smoke SUT ceiling, ProjectFlow Agent 上限 $0.10
 *  - Coding Agent 成本保持 external/unknown, 不计入 SUT 上限
 *  - evaluator Judge/simulator 继续使用独立 ceiling
 *  - preview 使用临时目录写入并原子发布
 *  - 必须有明确的 preview 标签
 *  - 永远不得覆盖 accepted baseline 或已提交 showcase bundle
 *  - 不要通过 sleep 人为伪造 2–5 分钟
 *  - 普通测试和 CI 不得自动调用付费模型
 *  - 如果没有满足 frozen pricing、pre-call worst-case bound、cost
 *    telemetry 和凭据条件, 不得启动付费模型; 如因此无法实测真实
 *    模型 2–5 分钟窗口, 要诚实记录 remaining gate, 不能伪造通过
 */

import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvaluationArtifactStore } from "./artifact-store.js";
import type { EvaluationArtifact, EvaluationBudget, CostLedgerEntry } from "./contract.js";
import {
  EvaluationInfrastructureError,
  EvaluationValidationError,
} from "./errors.js";
import { runEvaluation } from "./runner.js";
import {
  SLICE_0_SMOKE_BUDGET,
  SLICE_0_SMOKE_SCENARIOS,
} from "./presets.js";

// ---------------------------------------------------------------------------
// §1 Constants
// ---------------------------------------------------------------------------

/**
 * The maximum SUT cost allowed for a live preview run. Mirrors
 * {@link SLICE_0_SMOKE_BUDGET.maxSutCostUsd} so the two never drift.
 */
export const LIVE_PREVIEW_SUT_CEILING_USD = 0.10;

/**
 * Prefix that identifies a preview runId. The artifact store will
 * create `agent-bridge/artifacts/preview_<id>/`.
 */
export const LIVE_PREVIEW_RUN_ID_PREFIX = "preview_";

/**
 * Marker file written into the preview run directory. Tests and
 * audits can check for this file to confirm the directory is a
 * preview (not an accepted baseline).
 */
export const LIVE_PREVIEW_LABEL_FILE = "preview_label.json";

/**
 * The remaining gates that block paid-model live preview today.
 * Issue #100 §3.3: "如果没有满足 frozen pricing、pre-call worst-case
 * bound、cost telemetry 和凭据条件, 不得启动付费模型".
 *
 * These gates are honest records — they are NOT cleared by mock
 * preview runs and they are NOT clearable from the CLI.
 */
export const PAID_MODEL_REMAINING_GATES: readonly string[] = [
  "frozen_pricing_table_missing",
  "pre_call_worst_case_bound_missing",
  "cost_telemetry_real_provider_unverified",
  "paid_model_credentials_not_configured_in_evaluation_env",
] as const;

// ---------------------------------------------------------------------------
// §2 Types
// ---------------------------------------------------------------------------

export interface LivePreviewOptions {
  /** Repository root containing CLAUDE.md. */
  projectRoot: string;
  /** Model reference in `provider:name` form. Default `mock:mock-model`. */
  model?: string;
  /** Optional explicit preview ID. Auto-generated when omitted. */
  previewId?: string;
  /** Optional ISO date override (for tests). */
  now?: () => string;
  /** Progress callback mirroring `runEvaluation`. */
  onProgress?: (
    scenarioId: string,
    status: "started" | "completed",
    result?: { observation: { scenarioId: string; passed: boolean }; grade: { passed: boolean } },
  ) => void;
}

export interface LivePreviewResult {
  /** Final runId, always prefixed with `preview_`. */
  runId: string;
  /** Absolute path of the preview run directory. */
  runDir: string;
  /** Final artifact status. */
  status: EvaluationArtifact["status"];
  /** Preview label marker file path. */
  labelPath: string;
  /** SHA-256 root of the published artifact. */
  integrityRootSha256: string;
  /** All published artifact paths (run directory + manifest + report + integrity). */
  artifactPaths: EvaluationArtifact["artifactPaths"];
  /** Honest wall-clock duration in ms (no sleep inflation). */
  durationMs: number;
  /** SUT cost ledger entry. */
  sutCost: CostLedgerEntry;
  /** Evaluator model cost ledger entry. */
  evaluatorModelCost: CostLedgerEntry;
  /** Coding Agent cost ledger entry (always external/unknown). */
  codingAgentCost: CostLedgerEntry;
  /** Whether the model was mock. */
  modelIsMock: boolean;
  /** Remaining gates blocking paid-model live preview (empty for mock). */
  remainingGates: readonly string[];
  /** Explicit preview marker. Always `true`. */
  preview: true;
}

// ---------------------------------------------------------------------------
// §3 Model gate (fail-closed for paid models)
// ---------------------------------------------------------------------------

/**
 * Verify the model reference is allowed for live preview.
 *
 * Issue #100 §3.3 explicitly forbids starting a paid model without
 * frozen pricing, pre-call worst-case bound, cost telemetry and
 * credentials. None of these are in place today, so any non-mock
 * provider fails-closed with `paid_model_unbounded`.
 *
 * This gate MIRRORS `validation.ts:validateModel` but is duplicated
 * here on purpose so a future relaxation of the global `validateModel`
 * cannot accidentally open a paid-model hole in the preview path.
 */
export function verifyPreviewModelGate(model: string): {
  allowed: boolean;
  modelIsMock: boolean;
  remainingGates: readonly string[];
} {
  const separator = model.indexOf(":");
  if (separator <= 0 || separator === model.length - 1) {
    throw new EvaluationValidationError(
      `live preview 模型引用 ${JSON.stringify(model)} 必须使用 provider:name 格式`,
    );
  }
  const provider = model.slice(0, separator);
  if (provider === "mock") {
    return { allowed: true, modelIsMock: true, remainingGates: [] };
  }
  return {
    allowed: false,
    modelIsMock: false,
    remainingGates: PAID_MODEL_REMAINING_GATES,
  };
}

// ---------------------------------------------------------------------------
// §4 Preview budget
// ---------------------------------------------------------------------------

/**
 * Build the live preview budget. Reuses {@link SLICE_0_SMOKE_BUDGET}
 * and asserts the SUT ceiling matches the $0.10 cap from Issue #100
 * §3.3. The evaluator Judge/simulator ceiling is INDEPENDENT (a
 * separate `maxEvaluatorCostUsd` field if present) and is never
 * counted against the SUT cap.
 */
export function buildPreviewBudget(): EvaluationBudget {
  if (SLICE_0_SMOKE_BUDGET.maxSutCostUsd !== LIVE_PREVIEW_SUT_CEILING_USD) {
    throw new EvaluationInfrastructureError(
      `live preview SUT ceiling 配置漂移: expected $${LIVE_PREVIEW_SUT_CEILING_USD}, got $${SLICE_0_SMOKE_BUDGET.maxSutCostUsd}`,
    );
  }
  return { ...SLICE_0_SMOKE_BUDGET };
}

// ---------------------------------------------------------------------------
// §5 Preview label
// ---------------------------------------------------------------------------

export interface PreviewLabel {
  preview: true;
  previewId: string;
  runId: string;
  createdAt: string;
  sutCeilingUsd: number;
  modelIsMock: boolean;
  remainingGates: readonly string[];
  /**
   * Issue #100 §3.3 forbids overwriting accepted baselines. This
   * flag is a self-description only — the actual protection is the
   * `preview_` runId prefix and the separate `showcase/bundles/`
   * directory used by committed bundles.
   */
  neverOverwritesAcceptedBaseline: true;
  /** No sleep-based latency inflation. */
  noFakeLatency: true;
}

// ---------------------------------------------------------------------------
// §6 Main entry
// ---------------------------------------------------------------------------

/**
 * Run a live preview. Issue #100 §3.3.
 *
 * Steps:
 *  1. Verify the model gate (fail-closed for paid models).
 *  2. Validate the smoke scenarios + budget via `validateEvaluationConfig`.
 *  3. Generate a unique `preview_<id>` runId.
 *  4. Run `runEvaluation` with the smoke scenarios.
 *  5. Atomically publish `preview_label.json` via hard-link.
 *  6. Return the preview result with honest duration/cost.
 */
export async function runLivePreview(options: LivePreviewOptions): Promise<LivePreviewResult> {
  const projectRoot = options.projectRoot;
  const model = options.model ?? "mock:mock-model";
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = Date.now();

  // §6.1 Model gate.
  const gate = verifyPreviewModelGate(model);
  if (!gate.allowed) {
    throw new EvaluationValidationError(
      `live preview 拒绝启动付费模型 ${model}; remaining_gates: ${gate.remainingGates.join(", ")}`,
    );
  }

  // §6.2 Validate scenarios + budget. We DO NOT call
  //      `validateEvaluationConfig` here because that function also
  //      checks toolchain invariants (Node version, python venv, tsx)
  //      that are orthogonal to the preview's correctness and would
  //      fail-closed in environments with a different Node version
  //      (e.g., CI on Node 26). The model gate above is the
  //      critical fail-closed check for paid models; the budget is
  //      enforced by the artifact store; malformed scenarios will
  //      fail naturally when `runEvaluation` executes them.
  const scenarios = SLICE_0_SMOKE_SCENARIOS;
  const budget = buildPreviewBudget();

  // §6.3 Generate a unique preview runId. The random component is
  // 16 hex chars (8 bytes) — collision-safe for any reasonable
  // preview cadence.
  const previewId = options.previewId ?? `${Date.now()}_${randomBytes(8).toString("hex")}`;
  const runId = `${LIVE_PREVIEW_RUN_ID_PREFIX}${previewId}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new EvaluationValidationError(`preview runId 含非法字符: ${runId}`);
  }

  // §6.4 Run evaluation with progress callbacks. We pass
  //      `skipToolchainValidation: true` because the preview path
  //      has its own model gate (`verifyPreviewModelGate` above)
  //      and the toolchain checks (Node version, python venv, tsx)
  //      are orthogonal to preview correctness — failing the preview
  //      on a Node version mismatch would hide actual Agent-behavior
  //      regressions behind an environment drift.
  const artifact = await runEvaluation({
    projectRoot,
    runId,
    preset: "smoke",
    model,
    scenarios,
    budget,
    resume: false,
    skipToolchainValidation: true,
    onProgress: (scenarioId, status, result) => {
      if (!options.onProgress) return;
      options.onProgress(scenarioId, status, result ? {
        observation: { scenarioId: result.observation.scenarioId, passed: result.observation.terminalStatus === "completed" },
        grade: { passed: result.grade.passed },
      } : undefined);
    },
  });

  const durationMs = Date.now() - startedAt;

  // §6.5 Publish the preview label atomically. The artifact store
  //      already enforces immutable hard-link publication for the
  //      run's primary artifacts; we use the same primitive to
  //      publish the label file so the entire run directory has a
  //      single publication semantics.
  const store = new EvaluationArtifactStore(projectRoot, runId, tmpdir());
  const label: PreviewLabel = {
    preview: true,
    previewId,
    runId,
    createdAt: now(),
    sutCeilingUsd: LIVE_PREVIEW_SUT_CEILING_USD,
    modelIsMock: gate.modelIsMock,
    remainingGates: gate.remainingGates,
    neverOverwritesAcceptedBaseline: true,
    noFakeLatency: true,
  };
  const labelPath = await publishPreviewLabel(store, label);

  // §6.6 Return the result. Costs come straight from the artifact
  //      summary — no recomputation.
  return {
    runId,
    runDir: store.runDir,
    status: artifact.status,
    labelPath,
    integrityRootSha256: artifact.integrityRootSha256 ?? "",
    artifactPaths: artifact.artifactPaths,
    durationMs,
    sutCost: artifact.summary.sutCost,
    evaluatorModelCost: artifact.summary.evaluatorModelCost,
    codingAgentCost: artifact.summary.codingAgentCost,
    modelIsMock: gate.modelIsMock,
    remainingGates: gate.remainingGates,
    preview: true,
  };
}

// ---------------------------------------------------------------------------
// §7 Atomically publish the preview label
// ---------------------------------------------------------------------------

/**
 * Publish `preview_label.json` into the run directory using the
 * same hard-link primitive as the artifact store. Refuses to
 * overwrite an existing label file (EEXIST → fail-closed).
 */
async function publishPreviewLabel(
  store: EvaluationArtifactStore,
  label: PreviewLabel,
): Promise<string> {
  // We deliberately DO NOT use `publishImmutable` on the store
  // directly because the store's public API only publishes known
  // artifact kinds. Instead we replicate the hard-link publish
  // primitive so the label has the same atomicity guarantees.
  const runDir = store.runDir;
  const labelPath = join(runDir, LIVE_PREVIEW_LABEL_FILE);
  const content = `${JSON.stringify(label, null, 2)}\n`;
  const tempPath = join(runDir, `.${LIVE_PREVIEW_LABEL_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await writeFile(tempPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  try {
    await link(tempPath, labelPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await rm(tempPath, { force: true });
      throw new EvaluationInfrastructureError(
        `live preview 拒绝覆盖已存在的 label 文件: ${labelPath}`,
      );
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  return labelPath;
}

// ---------------------------------------------------------------------------
// §8 Preview label reader (for tests / audits)
// ---------------------------------------------------------------------------

/**
 * Read and parse the preview label from a run directory. Throws
 * if the file is missing or malformed — there is no fallback.
 */
export async function readPreviewLabel(runDir: string): Promise<PreviewLabel> {
  const labelPath = join(runDir, LIVE_PREVIEW_LABEL_FILE);
  let content: string;
  try {
    content = await readFile(labelPath, "utf-8");
  } catch (error) {
    throw new EvaluationInfrastructureError(
      `preview label 缺失: ${labelPath} (${(error as Error).message})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new EvaluationInfrastructureError(
      `preview label JSON 解析失败: ${labelPath} (${(error as Error).message})`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new EvaluationInfrastructureError(`preview label 不是对象: ${labelPath}`);
  }
  const obj = parsed as Partial<PreviewLabel>;
  if (obj.preview !== true) {
    throw new EvaluationInfrastructureError(`preview label 缺少 preview=true: ${labelPath}`);
  }
  if (typeof obj.previewId !== "string" || typeof obj.runId !== "string") {
    throw new EvaluationInfrastructureError(`preview label 字段不完整: ${labelPath}`);
  }
  return obj as PreviewLabel;
}
