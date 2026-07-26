/**
 * T46-7 (Issue #100 §3.3) — Live preview runner.
 *
 * Runs a RESTRICTED live subset of the public evaluation seam so an
 * observer can watch the ProjectFlow Agent execute demo scenarios
 * under tight guardrails. The preview is INTENTIONALLY bounded:
 *
 *  - SUT ceiling: $0.10 (preview always tightens to this cap).
 *  - Coding Agent cost remains external/unknown — never counted
 *    against the SUT cap.
 *  - Evaluator Judge/simulator uses an INDEPENDENT ceiling.
 *  - Mock models always allowed, honest that they don't meet the
 *    2–5 minute live window.
 *  - Paid models require: frozen price table (fingerprinted, ≤90-day
 *    freshness), pre-call worst-case ≤ cap, credential present in
 *    evaluator-owned temp dotenv (0600), cost telemetry from provider.
 *    Any gap → fail-closed.
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
 * Issue #100 C1 "真实付费 Live Preview":
 *  - 使用冻结价格表做调用前最坏成本预估（cache miss）
 *  - Flash worst-case $0.0462 ≤ $0.10 → 允许
 *  - Pro worst-case $0.14355 > $0.10 → 调用前拒绝
 *  - credential 只注入 evaluator-owned 临时 dotenv (0600)
 *  - 真实 cost 必须来自 provider telemetry (total_cost)
 *  - 价格表过期 (90天) / tampered → fail-closed
 */

import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvaluationArtifactStore } from "./artifact-store.js";
import type {
  EvaluationArtifact,
  EvaluationBudget,
  CostLedgerEntry,
} from "./contract.js";
import {
  EvaluationInfrastructureError,
  EvaluationValidationError,
} from "./errors.js";
import { runEvaluation } from "./runner.js";
import {
  DEMO_SCENARIOS,
  DEMO_BUDGET,
} from "./presets.js";
import {
  findPriceEntry,
  computeWorstCaseCost,
  computePriceTableFingerprint,
  isPriceTableStale,
  KNOWN_PRICE_TABLES,
  verifyPaidCostTelemetry,
} from "./price-table.js";

// ---------------------------------------------------------------------------
// §1 Constants
// ---------------------------------------------------------------------------

/**
 * The maximum SUT cost allowed for a live preview run. This is
 * ALWAYS $0.10, regardless of which preset's scenarios are used.
 * `DEMO_BUDGET.maxSutCostUsd` is validated against this ceiling
 * before any scenario runs.
 */
export const LIVE_PREVIEW_SUT_CEILING_USD = 0.10;

/**
 * Pre-call worst-case token ceiling for paid-model preview.
 * MUST equal DEMO_BUDGET.maxInputTokens / DEMO_BUDGET.maxOutputTokens.
 * Any drift fail-closed via verifyWorstCaseTokenCeilings().
 */
export const LIVE_PREVIEW_WORST_CASE_INPUT_TOKENS = 250_000;
export const LIVE_PREVIEW_WORST_CASE_OUTPUT_TOKENS = 40_000;

/** Known-good Flash worst-case: (250k/1M × $0.14) + (40k/1M × $0.28) = $0.04620. */
export const FLASH_WORST_CASE_AT_DEMO_CEILING = 0.0462;

/** Known-bad Pro worst-case: (250k/1M × $0.435) + (40k/1M × $0.87) = $0.14355. */
export const PRO_WORST_CASE_AT_DEMO_CEILING = 0.14355;

/**
 * Assert DEMO_BUDGET token/obs/wall ceilings match the declared worst-case
 * ceilings. Any drift in DEMO_BUDGET MUST be detected — this is a
 * structural invariant, not a runtime check that can be skipped.
 */
export function verifyWorstCaseTokenCeilings(): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const checkNum = (desc: string, expected: number, actual: number) => {
    if (actual !== expected) {
      failures.push(`${desc}: expected ${expected}, actual ${actual}`);
    }
  };
  const checkCond = (desc: string, actual: boolean) => {
    if (!actual) {
      failures.push(desc);
    }
  };
  checkNum("DEMO_BUDGET.maxInputTokens", 250_000, DEMO_BUDGET.maxInputTokens);
  checkNum("DEMO_BUDGET.maxOutputTokens", 40_000, DEMO_BUDGET.maxOutputTokens);
  checkCond("DEMO_BUDGET.maxObservations <= 5", DEMO_BUDGET.maxObservations <= 5);
  checkCond("DEMO_BUDGET.maxWallTimeMs <= 300000", DEMO_BUDGET.maxWallTimeMs <= 300_000);
  return { passed: failures.length === 0, failures };
}

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
 * Target window for live preview: 2-5 minutes per the user story
 * "I want a short live-demo preset so that I can show a real evaluation
 * within two to five minutes." Mock runs complete in ~1 second and
 * will NOT satisfy this window — the result honestly reports
 * `windowMet: false` and lists it in `remainingGates`.
 */
export const LIVE_PREVIEW_TARGET_WINDOW_MS: readonly [number, number] = [120_000, 300_000];

/** Preview excludes intentional runtime-fault scenarios. A live showcase
 * must exercise the real public seam without deliberately cancelling itself. */
export const LIVE_PREVIEW_SCENARIOS = Object.freeze(
  DEMO_SCENARIOS
    .filter((scenario) => !scenario.hidden.v3?.runtimeFaultId)
    // Frozen showcase slice: read-only answer, Proposal-Confirm, and the
    // deterministic multi-turn controller. Empirical max-reasoning runs put
    // these three at ~2.5 minutes and 18 requests, within every hard ceiling.
    .slice(0, 3)
    .map((scenario) => {
      const clone = structuredClone(scenario);
      clone.hidden.thinkingLevel = "max";
      // The answer-only smoke contract uses a 30s production latency gate,
      // which is too short for a max-reasoning live showcase. Preview keeps
      // the aggregate 5-minute wall cap but grants each turn up to 90s.
      clone.hidden.maxLatencyMs = Math.max(clone.hidden.maxLatencyMs, 90_000);
      // Tool-using max-reasoning turns can legitimately require five model
      // requests. The aggregate preview budget remains capped at 24.
      clone.hidden.maxRequestCount = Math.max(clone.hidden.maxRequestCount, 8);
      return clone;
    }),
);

/**
 * Known paid-model remaining gate IDs that C1 addresses:
 *  - frozen_pricing_table_missing: no price entry for this model
 *  - pre_call_worst_case_exceeds_cap: worst-case > $0.10 (e.g. Pro)
 *  - cost_telemetry_real_provider_unverified: missing/malformed telemetry
 *  - paid_model_credentials_not_configured_in_evaluation_env: no API key
 *  - price_table_stale: table older than 90 days
 *  - price_table_tampered: fingerprint mismatch
 */
export const PAID_MODEL_REMAINING_GATES: readonly string[] = [
  "frozen_pricing_table_missing",
  "pre_call_worst_case_exceeds_cap",
  "cost_telemetry_real_provider_unverified",
  "paid_model_credentials_not_configured_in_evaluation_env",
  "price_table_stale",
  "price_table_tampered",
] as const;

export type PaidModelGateId = (typeof PAID_MODEL_REMAINING_GATES)[number];

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
  /** T46 C1: optional credential value to inject. Tests use this to
   *  avoid reading real $DEEPSEEK_API_KEY from the host. */
  credentialValue?: string;
  /** T46 C1: optional frozen price table for tests. */
  priceTable?: import("./price-table.js").FrozenPriceTable;
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
  /** Target window for live preview (2-5 minutes per spec). */
  targetWindowMs: readonly [number, number];
  /** Whether actual duration falls within the target window. */
  windowMet: boolean;
  /** C1: the resolved model from sidecar health (null for mock). */
  resolvedModel: { provider: string; name: string; confirmedBy: string } | null;
  /** C1: pre-call worst-case estimate (null for mock). */
  worstCase: import("./price-table.js").WorstCaseEstimate | null;
  /** C1: whether paid cost telemetry was verified. */
  paidTelemetryVerified: boolean;
  /** C1: whether this run qualifies as real paid acceptance.
   *  false for mock; true only when all paid gates pass + telemetry verified. */
  realPaidAcceptance: boolean;
}

/**
 * Read a single env var value from .env text content.
 * Only reads the one key; ignores all other keys. Rejects NUL/CR/LF
 * in values and unparseable lines silently (returns undefined).
 */
export function readSingleEnvVar(
  envContent: string,
  key: string,
): string | undefined {
  // Validate key: only uppercase letters, digits and underscores
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
  let found: string | undefined;
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const lineKey = trimmed.slice(0, eqIdx).trim();
    if (lineKey !== key) continue;
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip inline comments after " #" — NOT inside quotes
    const commentIdx = val.indexOf(" #");
    if (commentIdx !== -1) {
      const before = val.slice(0, commentIdx).trim();
      if (!(before.startsWith('"') && !before.endsWith('"')) && !(before.startsWith("'") && !before.endsWith("'"))) {
        val = before;
      }
    }
    // Strip matching surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Security: reject NUL, CR, LF, empty values
    if (val.includes("\0") || val.includes("\r") || val.includes("\n") || !val) {
      return undefined;
    }
    if (found !== undefined) return undefined;
    found = val;
  }
  return found;
}

function isValidCredentialValue(value: string | undefined): value is string {
  return value !== undefined
    && value.length > 0
    && !value.includes("\0")
    && !value.includes("\r")
    && !value.includes("\n");
}

// ---------------------------------------------------------------------------
// §3 Model gate (fail-closed for paid models)
// ---------------------------------------------------------------------------

/**
 * Verify the model reference is allowed for live preview.
 *
 * T46 C1: paid models require a frozen price entry in a known table
 * (fingerprint-verified, ≤90-day freshness), a pre-call worst-case
 * estimate ≤ $0.10, and a credential from the checked-in model config.
 *
 * The caller is responsible for verifying cost telemetry post-run.
 */
export function verifyPreviewModelGate(
  model: string,
  options?: {
    /** Optional price table override (for tests). */
    priceTable?: import("./price-table.js").FrozenPriceTable;
    /** Optional credential check result (for tests). */
    credentialSet?: boolean;
    /** Optional date for freshness check (for tests). */
    now?: Date;
  },
): {
  allowed: boolean;
  modelIsMock: boolean;
  remainingGates: PaidModelGateId[];
  priceEntry?: import("./price-table.js").FrozenPriceEntry;
  worstCase?: import("./price-table.js").WorstCaseEstimate;
} {
  const separator = model.indexOf(":");
  if (separator <= 0 || separator === model.length - 1) {
    throw new EvaluationValidationError(
      `live preview 模型引用 ${JSON.stringify(model)} 必须使用 provider:name 格式`,
    );
  }
  const provider = model.slice(0, separator);

  // Mock is always allowed.
  if (provider === "mock") {
    return {
      allowed: true,
      modelIsMock: true,
      remainingGates: [],
    };
  }

  // Paid-model path: find the price table for this provider.
  const remainingGates: PaidModelGateId[] = [];
  const table = options?.priceTable ?? KNOWN_PRICE_TABLES[provider];

  // Gate 1: price table exists.
  if (!table) {
    remainingGates.push("frozen_pricing_table_missing");
    // Cannot proceed without a table.
    return buildDeniedResult(remainingGates);
  }

  // Gate 2: price table fingerprint verified (tamper detection).
  // Recompute from FULL table payload (version, frozenAt, sourceUrl,
  // entries, currency, tokenUnit, rateSemantics), NOT just entries.
  const recomputedFp = computePriceTableFingerprint(table);
  if (recomputedFp !== table.fingerprint) {
    remainingGates.push("price_table_tampered");
    return buildDeniedResult(remainingGates);
  }

  // Gate 3: price table freshness (≤90 days).
  if (isPriceTableStale(table, options?.now)) {
    remainingGates.push("price_table_stale");
    return buildDeniedResult(remainingGates);
  }

  // Gate 4: model has an entry in the table.
  const entry = findPriceEntry(table, model);
  if (!entry) {
    remainingGates.push("frozen_pricing_table_missing");
    return buildDeniedResult(remainingGates);
  }

  // Gate 5: pre-call worst-case bound ≤ $0.10.
  const worstCase = computeWorstCaseCost(
    entry,
    LIVE_PREVIEW_WORST_CASE_INPUT_TOKENS,
    LIVE_PREVIEW_WORST_CASE_OUTPUT_TOKENS,
    LIVE_PREVIEW_SUT_CEILING_USD,
  );
  if (!worstCase.withinCap) {
    remainingGates.push("pre_call_worst_case_exceeds_cap");
    return buildDeniedResult(remainingGates, { priceEntry: entry, worstCase });
  }

  // Gate 6: credential present.
  // The caller (runLivePreview) resolves the env var name from
  // model-configs.json; verifyPreviewModelGate only checks the flag.
  if (options?.credentialSet !== true) {
    remainingGates.push("paid_model_credentials_not_configured_in_evaluation_env");
    return buildDeniedResult(remainingGates, { priceEntry: entry, worstCase });
  }

  // All gates passed. Cost telemetry verification is deferred to
  // post-run because it requires the actual run's cost data.
  return {
    allowed: true,
    modelIsMock: false,
    remainingGates: [],
    priceEntry: entry,
    worstCase,
  };
}

function buildDeniedResult(
  remainingGates: PaidModelGateId[],
  extras?: { priceEntry?: import("./price-table.js").FrozenPriceEntry; worstCase?: import("./price-table.js").WorstCaseEstimate },
): {
  allowed: boolean;
  modelIsMock: boolean;
  remainingGates: PaidModelGateId[];
  priceEntry?: import("./price-table.js").FrozenPriceEntry;
  worstCase?: import("./price-table.js").WorstCaseEstimate;
} {
  return {
    allowed: false,
    modelIsMock: false,
    remainingGates,
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// §4 Preview budget
// ---------------------------------------------------------------------------

/**
 * Build the live preview budget. Always uses the DEMO budget but
 * forcibly tightens `maxSutCostUsd` to $0.10. Verifies that the
 * token ceiling invariants match the declared worst-case constants.
 */
export function buildPreviewBudget(): EvaluationBudget {
  const ceilingCheck = verifyWorstCaseTokenCeilings();
  if (!ceilingCheck.passed) {
    throw new EvaluationInfrastructureError(
      `preview token ceiling 漂移: ${ceilingCheck.failures.join("; ")}`,
    );
  }
  if (DEMO_BUDGET.maxSutCostUsd > LIVE_PREVIEW_SUT_CEILING_USD) {
    throw new EvaluationInfrastructureError(
      `DEMO_BUDGET.maxSutCostUsd ($${DEMO_BUDGET.maxSutCostUsd}) 超过 preview 硬上限 $${LIVE_PREVIEW_SUT_CEILING_USD}`,
    );
  }
  return { ...DEMO_BUDGET, maxSutCostUsd: LIVE_PREVIEW_SUT_CEILING_USD };
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
  modelRef: string;
  remainingGates: readonly string[];
  targetWindowMs: readonly [number, number];
  actualDurationMs: number;
  windowMet: boolean;
  /**
   * Issue #100 §3.3 forbids overwriting accepted baselines. This
   * flag is a self-description only — the actual protection is the
   * `preview_` runId prefix and the separate `showcase/bundles/`
   * directory used by committed bundles.
   */
  neverOverwritesAcceptedBaseline: true;
  /** No sleep-based latency inflation. */
  noFakeLatency: true;
  /** C1: resolved model from sidecar health (null for mock). */
  resolvedModel: { provider: string; name: string; confirmedBy: string } | null;
  /** C1: whether paid cost telemetry was verified. */
  paidTelemetryVerified: boolean;
  /** C1: whether this run qualifies as real paid acceptance.
   *  false for mock; true only when all paid gates pass + telemetry verified. */
  realPaidAcceptance: boolean;
  /** Immutable report status before preview-only gates are applied. */
  sourceArtifactStatus: EvaluationArtifact["status"];
  /** Effective preview verdict used by the CLI. */
  effectiveStatus: EvaluationArtifact["status"];
}

// ---------------------------------------------------------------------------
// §6 Main entry
// ---------------------------------------------------------------------------

/**
 * Run a live preview. Issue #100 C1.
 *
 * Steps:
 *  1. Verify the model gate (fail-closed for paid models).
 *  2. For paid models: resolve credential from host .env, inject into
 *     evaluator-owned temp dotenv (0600), verify worst-case ≤ cap.
 *  3. Validate scenarios + budget.
 *  4. Generate a unique `preview_<id>` runId.
 *  5. Run `runEvaluation` with DEMO scenarios.
 *  6. Verify cost telemetry (paid only).
 *  7. Atomically publish `preview_label.json`.
 *  8. Return the preview result with honest duration/cost.
 */
export async function runLivePreview(options: LivePreviewOptions): Promise<LivePreviewResult> {
  const projectRoot = options.projectRoot;
  const model = options.model ?? "mock:mock-model";
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = Date.now();

  // §6.1 Model gate.
  // Read model-configs.json for the credential env var name.
  const modelConfigsPath = join(projectRoot, "agent-bridge", "model-configs.json");
  let modelConfigsRaw: string;
  try {
    modelConfigsRaw = await readFile(modelConfigsPath, "utf-8");
  } catch (error) {
    throw new EvaluationInfrastructureError(
      `无法读取 model-configs.json: ${(error as Error).message}`,
    );
  }
  const modelConfigs = JSON.parse(modelConfigsRaw) as {
    models?: Array<{ id?: string; provider?: string; name?: string; apiKeyEnvVar?: string }>;
  };
  const separator = model.indexOf(":");
  const provider = model.slice(0, separator);
  const modelName = model.slice(separator + 1);
  const modelEntry = modelConfigs.models?.find(
    (c) => c.provider === provider && c.name === modelName,
  );
  const credentialEnvVar = modelEntry?.apiKeyEnvVar ?? "";
  if (provider !== "mock" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnvVar)) {
    throw new EvaluationValidationError(
      `live preview 模型 ${model} 缺少合法 apiKeyEnvVar`,
    );
  }
  // T46 C1 fix #2: selected-only credential loader.
  // Only read the ONE declared env var from process.env or the repo .env file.
  // Never load other vars into process.env, never print the value.
  let credentialValue = options.credentialValue ?? undefined;
  if (credentialEnvVar && credentialValue === undefined) {
    credentialValue = process.env[credentialEnvVar] ?? undefined;
    // Fallback: read from agent-bridge/.env (only that one key).
    if (credentialValue === undefined) {
      try {
        const repoEnvPath = join(projectRoot, "agent-bridge", ".env");
        const repoEnvContent = await readFile(repoEnvPath, "utf-8");
        credentialValue = readSingleEnvVar(repoEnvContent, credentialEnvVar);
      } catch {
        // .env file not readable — credential remains undefined.
      }
    }
  }
  if (credentialValue !== undefined && !isValidCredentialValue(credentialValue)) {
    throw new EvaluationValidationError(
      `live preview credential ${credentialEnvVar} 格式非法`,
    );
  }
  const credentialSet = provider === "mock" || isValidCredentialValue(credentialValue);

  const gate = verifyPreviewModelGate(model, {
    priceTable: options.priceTable,
    credentialSet: credentialSet,
  });
  if (!gate.allowed) {
    throw new EvaluationValidationError(
      `live preview 拒绝启动付费模型 ${model}; remaining_gates: ${gate.remainingGates.join(", ")}` +
      (gate.worstCase ? `; worst-case=$${gate.worstCase.totalCost.toFixed(5)} (cap $${gate.worstCase.cap.toFixed(2)})` : ""),
    );
  }

  // §6.2 Resolve credential for paid models.
  // Uses the value already resolved in §6.1 via selected-only loader.
  let credential: { envVar: string; value: string } | undefined;
  if (!gate.modelIsMock && credentialEnvVar && credentialValue) {
    credential = { envVar: credentialEnvVar, value: credentialValue };
  }

  // §6.3 Validate budget ceiling.
  const scenarios = [...LIVE_PREVIEW_SCENARIOS];
  if (scenarios.length > 5) {
    throw new EvaluationInfrastructureError(
      `preview 场景数 ${scenarios.length} 超过上限 5`,
    );
  }
  const budget = buildPreviewBudget();

  // §6.4 Generate a unique preview runId.
  const previewId = options.previewId ?? `${Date.now()}_${randomBytes(8).toString("hex")}`;
  const runId = `${LIVE_PREVIEW_RUN_ID_PREFIX}${previewId}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new EvaluationValidationError(`preview runId 含非法字符: ${runId}`);
  }

  // §6.5 Run evaluation with progress callbacks.
  // Capture resolved model from pairStarted for model drift verification.
  const resolvedModelRef: { value: { provider: string; name: string; confirmedBy: string } | null } = { value: null };
  const artifact = await runEvaluation({
    projectRoot,
    runId,
    preset: "demo",
    model,
    scenarios,
    budget,
    resume: false,
    skipToolchainValidation: true,
    allowBoundedPaidPreview: !gate.modelIsMock,
    credential,
    onPairStarted: (metadata) => {
      if (metadata.resolvedModel) {
        resolvedModelRef.value = {
          provider: metadata.resolvedModel.provider,
          name: metadata.resolvedModel.name,
          confirmedBy: metadata.resolvedModel.confirmedBy,
        };
      }
    },
    onProgress: (scenarioId, status, result) => {
      if (!options.onProgress) return;
      options.onProgress(scenarioId, status, result ? {
        observation: { scenarioId: result.observation.scenarioId, passed: result.observation.terminalStatus === "completed" },
        grade: { passed: result.grade.passed },
      } : undefined);
    },
  });

  const durationMs = Date.now() - startedAt;
  const windowMet = durationMs >= LIVE_PREVIEW_TARGET_WINDOW_MS[0] && durationMs <= LIVE_PREVIEW_TARGET_WINDOW_MS[1];

  // §6.6 Cost telemetry verification (paid models only).
  let paidTelemetryVerified = gate.modelIsMock; // mock = always "verified"
  let paidTelemetryFailure: string | undefined;
  if (!gate.modelIsMock) {
    const telemetryResult = verifyPaidCostTelemetry(
      artifact.summary.sutCost,
      gate.priceEntry!,
      artifact.summary.totalInputTokens,
      artifact.summary.totalOutputTokens,
    );
    paidTelemetryVerified = telemetryResult.verified;
    paidTelemetryFailure = telemetryResult.failureReason;
  }

  // §6.7 Remaining gates.
  // C1: model drift detection + resolvedModel mandatory for paid models.
  const remainingGates: string[] = [];
  if (gate.modelIsMock && !windowMet) {
    remainingGates.push("mock_preview_target_window_not_met");
  }
  if (!gate.modelIsMock) {
    const rm = resolvedModelRef.value;
    if (!rm) {
      remainingGates.push("resolved_model_missing");
    } else if (
      rm.confirmedBy !== "sidecar_health" ||
      rm.provider !== provider ||
      rm.name !== modelName
    ) {
      remainingGates.push("model_drift");
      console.warn(
        `[live-preview] model drift detected: requested ${provider}:${modelName}, ` +
        `resolved ${rm.provider}:${rm.name} (confirmed_by=${rm.confirmedBy})`,
      );
    }
  }
  if (!gate.modelIsMock && !paidTelemetryVerified && paidTelemetryFailure) {
    remainingGates.push("cost_telemetry_real_provider_unverified");
  }
  if (!gate.modelIsMock && !windowMet) {
    remainingGates.push("paid_preview_target_window_not_met");
  }
  if (!gate.modelIsMock && artifact.status !== "completed") {
    remainingGates.push(`source_artifact_${artifact.status}`);
  }

  let effectiveStatus = artifact.status;
  if (!gate.modelIsMock && remainingGates.length > 0) {
    effectiveStatus = "regression";
  }
  const realPaidAcceptance = !gate.modelIsMock
    && effectiveStatus === "completed"
    && paidTelemetryVerified
    && windowMet
    && remainingGates.length === 0;

  // §6.8 Publish the preview label.
  const store = new EvaluationArtifactStore(projectRoot, runId, tmpdir());
  const label: PreviewLabel = {
    preview: true,
    previewId,
    runId,
    createdAt: now(),
    sutCeilingUsd: LIVE_PREVIEW_SUT_CEILING_USD,
    modelIsMock: gate.modelIsMock,
    modelRef: model,
    remainingGates,
    targetWindowMs: LIVE_PREVIEW_TARGET_WINDOW_MS,
    actualDurationMs: durationMs,
    windowMet,
    neverOverwritesAcceptedBaseline: true,
    noFakeLatency: true,
    resolvedModel: resolvedModelRef.value,
    paidTelemetryVerified,
    realPaidAcceptance,
    sourceArtifactStatus: artifact.status,
    effectiveStatus,
  };
  const labelPath = await publishPreviewLabel(store, label);

  // §6.9 Integrity root verification.
  if (!artifact.integrityRootSha256 || artifact.integrityRootSha256.length === 0) {
    throw new EvaluationInfrastructureError(
      `live preview artifact 缺少 integrityRootSha256; 拒绝用空字符串冒充 SHA-256 根 (runId=${runId})`,
    );
  }

  // §6.10 For paid models: fail-closed if cost telemetry is
  //       missing/malformed/underreported — MUST change artifact
  //       status to regression so the CLI exits non-zero.
  if (!gate.modelIsMock && !paidTelemetryVerified) {
    console.warn(
      `[live-preview] paid cost telemetry verification failed for ${model}: ${paidTelemetryFailure}`,
    );
  }

  return {
    runId,
    runDir: store.runDir,
    status: effectiveStatus,
    labelPath,
    integrityRootSha256: artifact.integrityRootSha256,
    artifactPaths: artifact.artifactPaths,
    durationMs,
    sutCost: artifact.summary.sutCost,
    evaluatorModelCost: artifact.summary.evaluatorModelCost,
    codingAgentCost: artifact.summary.codingAgentCost,
    modelIsMock: gate.modelIsMock,
    remainingGates,
    preview: true,
    targetWindowMs: LIVE_PREVIEW_TARGET_WINDOW_MS,
    windowMet,
    resolvedModel: resolvedModelRef.value,
    worstCase: gate.worstCase ?? null,
    paidTelemetryVerified,
    realPaidAcceptance,
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
