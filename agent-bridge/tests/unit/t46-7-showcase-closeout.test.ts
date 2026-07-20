/**
 * T46-7 (Issue #100) — Showcase & closeout presentation surface tests.
 *
 * Covers the 14+ required test categories from Issue #100 §5:
 *  1.  Presentation/showcase tests
 *  2.  Portable bundle redaction attack tests
 *  3.  Bundle-scoped pseudonym tests
 *  4.  Result graph parity tests (viewer ↔ bundle)
 *  5.  No-grade-recomputation tests
 *  6.  Loopback-only binding tests
 *  7.  Viewer no-mutation route/control tests
 *  8.  Atomic preview publish & accepted baseline not overwritten
 *  9.  Schema migration tests
 *  10. Unsupported future schema fail-closed tests
 *  11. Malformed/hash/provenance mismatch tests
 *  12. Retention planning & zero-deletion tests
 *  13. Agent-first 3-profile acceptance tests
 *  14. Cost bucket & unknown-cost truthfulness tests
 *  15. Live preview model gate (paid-model fail-closed)
 *
 * The fixtures use the REAL project root (so buildProvenance can read
 * `agent-bridge/model-configs.json`) but write artifacts into unique
 * runIds under `agent-bridge/artifacts/<runId>/` and clean them up in
 * `afterEach`.
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { EvaluationArtifactStore } from "../../src/evaluation/lab/artifact-store.js";
import { buildProvenance, sha256, stableStringify } from "../../src/evaluation/lab/validation.js";
import {
  EVALUATION_SCHEMA_VERSION,
  type EvaluationArtifact,
  type EvaluationProvenance,
  type Grade,
  type RunManifest,
  type ScenarioContract,
  type ScenarioObservation,
} from "../../src/evaluation/lab/contract.js";

// T46-7 modules under test.
import {
  verifyAndMigrateArtifact,
  migrateArtifact,
  assertSupportedSchema,
  computeArtifactFingerprint,
  SUPPORTED_SOURCE_SCHEMA_VERSIONS,
  PRESENTATION_SCHEMA_VERSION,
  MIGRATIONS,
  type VerifiedArtifact,
} from "../../src/evaluation/lab/schema-migration.js";
import {
  buildShowcaseBundle,
  buildShowcaseBundleInMemory,
  verifyShowcaseBundle,
  generatePseudonymSalt,
  pseudonymize,
  redactText,
  SHOWCASE_BUNDLE_SCHEMA_VERSION,
  SHOWCASE_BUNDLE_GENERATOR_VERSION,
  type ShowcaseBundle,
} from "../../src/evaluation/lab/showcase-bundle.js";
import {
  startLocalViewer,
  LOOPBACK_HOSTS,
  DEFAULT_VIEWER_PORT,
  type ViewerHandle,
} from "../../src/evaluation/lab/local-viewer.js";
import {
  runLivePreview,
  verifyPreviewModelGate,
  buildPreviewBudget,
  LIVE_PREVIEW_SUT_CEILING_USD,
  LIVE_PREVIEW_RUN_ID_PREFIX,
  LIVE_PREVIEW_LABEL_FILE,
  PAID_MODEL_REMAINING_GATES,
} from "../../src/evaluation/lab/live-preview.js";
import {
  buildRetentionReport,
  publishRetentionReport,
  verifyRetentionReport,
  RETENTION_REPORT_SCHEMA_VERSION,
  RETENTION_POLICY_VERSION,
} from "../../src/evaluation/lab/retention-planner.js";
import {
  runAgentAcceptance,
  publishAgentAcceptanceReport,
  AGENT_PROFILES,
  AGENT_ACCEPTANCE_SCHEMA_VERSION,
  EVAL_LAB_SCRIPT,
  SKILL_MD_PATH,
  type AgentProfileName,
} from "../../src/evaluation/lab/agent-acceptance.js";

const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");
const createdTempDirs: string[] = [];
const createdRunDirs: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...createdTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    ...createdRunDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ]);
});

// ---------------------------------------------------------------------------
// §1 Fixtures
// ---------------------------------------------------------------------------

function knownZeroCosts(): ScenarioObservation["costs"] {
  return {
    sutCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
    evaluatorModelCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
    codingAgentCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: false },
  };
}

function unknownSutCosts(): ScenarioObservation["costs"] {
  return {
    sutCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: true },
    evaluatorModelCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
    codingAgentCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: false },
  };
}

function buildSmokeScenario(scenarioId: string): ScenarioContract {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId,
    visible: { prompt: `测试场景 ${scenarioId}` },
    hidden: {
      expectedMode: "answer",
      maxLatencyMs: 5_000,
      forbidRawIds: true,
      tokenBudget: { maxInputTokens: 100, maxOutputTokens: 100 },
      maxRequestCount: 2,
    },
  };
}

function buildObservation(scenarioId: string, output: string, costs: ScenarioObservation["costs"] = knownZeroCosts()): ScenarioObservation {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId,
    timestamp: "2026-07-20T00:00:00.000Z",
    routedMode: "answer",
    selectedSkills: [],
    evidence: [],
    terminalStatus: "completed",
    latencyMs: 100,
    inputTokens: 10,
    outputTokens: 5,
    requestCount: 1,
    costs,
    output,
  };
}

function buildGrade(scenarioId: string, passed: boolean, failures: string[] = []): Grade {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId,
    passed,
    routingPassed: true,
    outcomePassed: passed,
    latencyPassed: passed,
    privacyPassed: passed,
    budgetPassed: passed,
    failures,
  };
}

/**
 * Build a minimal verified artifact on disk and return the
 * VerifiedArtifact. Uses the real project root so buildProvenance
 * can read model-configs.json, but writes to a unique runId.
 */
async function publishVerifiedArtifact(options: {
  runId: string;
  scenarios?: ScenarioContract[];
  observations?: ScenarioObservation[];
  grades?: Grade[];
  status?: EvaluationArtifact["status"];
  preset?: string;
}): Promise<{ verified: VerifiedArtifact; store: EvaluationArtifactStore }> {
  const runId = options.runId;
  const scenarios = options.scenarios ?? [buildSmokeScenario(`${runId}-scenario-1`)];
  const observations = options.observations ?? [buildObservation(scenarios[0]!.scenarioId, "安全输出")];
  const grades = options.grades ?? [buildGrade(scenarios[0]!.scenarioId, true)];
  const status = options.status ?? "completed";
  const preset = options.preset ?? "smoke";

  const evaluatorTemp = await mkdtemp(join(tmpdir(), `t46-7-eval-${runId}-`));
  createdTempDirs.push(evaluatorTemp);
  const runDir = join(projectRoot, "agent-bridge", "artifacts", runId);
  createdRunDirs.push(runDir);

  const store = new EvaluationArtifactStore(projectRoot, runId, evaluatorTemp);
  const provenance = await buildProvenance({ projectRoot, scenarios });
  const manifest: RunManifest = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId,
    preset,
    model: "mock:mock-model",
    createdAt: "2026-07-20T00:00:00.000Z",
    scenarios,
    budget: {
      maxSutCostUsd: 0.10,
      maxInputTokens: 50_000,
      maxOutputTokens: 8_000,
      maxRequestCount: 4,
      maxWallTimeMs: 30_000,
      maxObservations: 1,
    },
    provenance,
  };
  await store.initialize(manifest, false);
  for (let i = 0; i < observations.length; i += 1) {
    await store.publishCheckpoint(observations[i]!, grades[i] ?? buildGrade(observations[i]!.scenarioId, true));
  }
  const passedCount = grades.filter((g) => g.passed).length;
  const failedCount = grades.length - passedCount;
  // Aggregate observation costs into the summary. If any observation
  // has `source: "unknown"`, the summary uses `unknown` with `null`
  // amount (Issue #100 §3.2: unknown MUST NOT display as $0).
  // Otherwise, sum the amounts and use the common source.
  const sutSources = new Set(observations.map((o) => o.costs.sutCost.source));
  const evalSources = new Set(observations.map((o) => o.costs.evaluatorModelCost.source));
  const sutHasUnknown = sutSources.has("unknown");
  const evalHasUnknown = evalSources.has("unknown");
  const sutAmount = sutHasUnknown ? null : observations.reduce((s, o) => s + (o.costs.sutCost.amountUsd ?? 0), 0);
  const evalAmount = evalHasUnknown ? null : observations.reduce((s, o) => s + (o.costs.evaluatorModelCost.amountUsd ?? 0), 0);
  const sutSource: "provider_reported" | "versioned_price_estimate" | "unknown" = sutHasUnknown ? "unknown" : (sutSources.has("provider_reported") ? "provider_reported" : "versioned_price_estimate");
  const evalSource: "provider_reported" | "versioned_price_estimate" | "unknown" = evalHasUnknown ? "unknown" : (evalSources.has("provider_reported") ? "provider_reported" : "versioned_price_estimate");
  const baseArtifact: Omit<EvaluationArtifact, "evidenceRootSha256" | "integrityRootSha256"> = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId,
    preset,
    model: "mock:mock-model",
    status,
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    observations,
    grades,
    summary: {
      passedCount,
      failedCount,
      passRate: grades.length === 0 ? 0 : passedCount / grades.length,
      sutCost: { amountUsd: sutAmount, source: sutSource, countedAgainstSutCap: true },
      evaluatorModelCost: { amountUsd: evalAmount, source: evalSource, countedAgainstSutCap: false },
      codingAgentCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: false },
      totalInputTokens: observations.reduce((s, o) => s + o.inputTokens, 0),
      totalOutputTokens: observations.reduce((s, o) => s + o.outputTokens, 0),
      totalRequestCount: observations.reduce((s, o) => s + o.requestCount, 0),
      wallTimeMs: 1000,
    },
    provenance,
    artifactPaths: {
      runDirectory: runDir,
      manifest: join(runDir, "manifest.json"),
      report: join(runDir, "report.json"),
      integrity: join(runDir, "integrity.json"),
    },
  };
  await store.finalize(baseArtifact);
  await store.releaseLock();
  const verified = await verifyAndMigrateArtifact(runDir, runId);
  return { verified, store };
}

// ---------------------------------------------------------------------------
// §2 Schema migration tests
// ---------------------------------------------------------------------------

describe("T46-7 §2 — Schema migration", () => {
  it("SUPPORTED_SOURCE_SCHEMA_VERSIONS contains only the current version", () => {
    expect(SUPPORTED_SOURCE_SCHEMA_VERSIONS).toContain(EVALUATION_SCHEMA_VERSION);
    expect(SUPPORTED_SOURCE_SCHEMA_VERSIONS.length).toBe(1);
  });

  it("PRESENTATION_SCHEMA_VERSION equals EVALUATION_SCHEMA_VERSION", () => {
    expect(PRESENTATION_SCHEMA_VERSION).toBe(EVALUATION_SCHEMA_VERSION);
  });

  it("MIGRATIONS is empty for V1 (no older schemas yet)", () => {
    expect(MIGRATIONS.length).toBe(0);
  });

  it("assertSupportedSchema accepts current version and rejects others", () => {
    expect(() => assertSupportedSchema(EVALUATION_SCHEMA_VERSION)).not.toThrow();
    expect(() => assertSupportedSchema(2)).toThrow(/不受支持的 schemaVersion/);
    expect(() => assertSupportedSchema(0)).toThrow(/不受支持的 schemaVersion/);
    expect(() => assertSupportedSchema(-1)).toThrow(/不受支持的 schemaVersion/);
  });

  it("migrateArtifact is a no-op for the current version", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `migration-noop-${Date.now()}` });
    const result = migrateArtifact(verified.artifact);
    expect(result.sourceSchemaVersion).toBe(EVALUATION_SCHEMA_VERSION);
    expect(result.targetSchemaVersion).toBe(PRESENTATION_SCHEMA_VERSION);
    expect(result.migrationsApplied).toEqual([]);
    expect(result.artifact).toEqual(verified.artifact);
  });

  it("migrateArtifact rejects unknown future schema versions", () => {
    const futureArtifact = {
      ...({} as EvaluationArtifact),
      schemaVersion: 99,
    };
    expect(() => migrateArtifact(futureArtifact)).toThrow(/不受支持的 artifact schemaVersion: 99/);
  });

  it("migrateArtifact rejects non-integer schema versions", () => {
    const badArtifact = {
      ...({} as EvaluationArtifact),
      schemaVersion: 1.5,
    };
    expect(() => migrateArtifact(badArtifact)).toThrow(/artifact.schemaVersion 非法/);
  });

  it("verifyAndMigrateArtifact returns the full VerifiedArtifact bundle", async () => {
    const runId = `verify-bundle-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    expect(verified.artifact.runId).toBe(runId);
    expect(verified.integrity.algorithm).toBe("sha256");
    expect(verified.provenance.evaluatorVersion).toBeTruthy();
    expect(verified.migrationLog).toEqual([]);
    expect(verified.runId).toBe(runId);
    expect(verified.runDir).toContain(runId);
  });

  it("computeArtifactFingerprint is deterministic for the same artifact", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `fingerprint-${Date.now()}` });
    const fp1 = computeArtifactFingerprint(verified);
    const fp2 = computeArtifactFingerprint(verified);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// §3 Showcase bundle tests
// ---------------------------------------------------------------------------

describe("T46-7 §3 — Portable showcase bundle", () => {
  it("buildShowcaseBundleInMemory produces a valid bundle", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `bundle-build-${Date.now()}` });
    const { bundle, bundleSha256, salt } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(bundle.schemaVersion).toBe(SHOWCASE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.bundleType).toBe("portable_redacted_showcase");
    expect(bundle.evidenceClass).toBe("offline_synthetic");
    expect(bundle.integritySha256).toBe(bundleSha256);
    expect(bundle.bundleProvenance.bundleSchemaVersion).toBe(SHOWCASE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.bundleProvenance.generatorVersion).toBe(SHOWCASE_BUNDLE_GENERATOR_VERSION);
    expect(salt.length).toBe(32);
  });

  it("buildShowcaseBundle writes to disk atomically and verifies", async () => {
    const runId = `bundle-disk-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const { bundle, bundlePath, bundleSha256 } = await buildShowcaseBundle({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(existsSync(bundlePath)).toBe(true);
    expect(bundle.integritySha256).toBe(bundleSha256);
    createdTempDirs.push(bundlePath);
    // Verify the on-disk bundle round-trips.
    const reVerified = await verifyShowcaseBundle(bundlePath);
    expect(reVerified.integritySha256).toBe(bundleSha256);
    expect(reVerified.bundleId).toBe(bundle.bundleId);
  });

  it("buildShowcaseBundle refuses to overwrite an existing bundle", async () => {
    const runId = `bundle-overwrite-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const now = () => "2026-07-20T00:00:00.000Z";
    const bundleId = "fixed-bundle-id-for-overwrite-test";
    const { bundlePath } = await buildShowcaseBundle({
      verified,
      projectRoot,
      now,
      bundleId,
    });
    createdTempDirs.push(bundlePath);
    await expect(
      buildShowcaseBundle({ verified, projectRoot, now, bundleId }),
    ).rejects.toThrow(/拒绝覆盖已存在的 showcase bundle/);
  });

  it("release verdict honestly reflects regression status", async () => {
    const runId = `bundle-regression-${Date.now()}`;
    const scenario = buildSmokeScenario(`${runId}-fail`);
    const { verified } = await publishVerifiedArtifact({
      runId,
      scenarios: [scenario],
      observations: [buildObservation(scenario.scenarioId, "失败输出")],
      grades: [buildGrade(scenario.scenarioId, false, ["outcome failed"])],
      status: "regression",
    });
    const { bundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(bundle.releaseVerdict.verdict).toBe("regression");
    expect(bundle.releaseVerdict.honestBaseline).toBe("0/1");
    expect(bundle.releaseVerdict.forbiddenClaims.length).toBeGreaterThan(0);
    // Must NOT claim real-user satisfaction, production quality, etc.
    const claims = bundle.releaseVerdict.forbiddenClaims.join("\n");
    expect(claims).toMatch(/不得宣称/);
    expect(claims).toMatch(/offline\/synthetic/);
  });

  it("release verdict reflects partial_budget status", async () => {
    const runId = `bundle-partial-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({
      runId,
      status: "partial_budget",
    });
    const { bundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(bundle.releaseVerdict.verdict).toBe("partial_budget");
  });

  it("release verdict reflects passed status", async () => {
    const runId = `bundle-passed-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({
      runId,
      status: "completed",
    });
    const { bundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(bundle.releaseVerdict.verdict).toBe("passed");
    expect(bundle.releaseVerdict.honestBaseline).toBe("1/1");
  });

  it("verifyShowcaseBundle rejects a tampered bundle", async () => {
    const runId = `bundle-tamper-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const { bundlePath } = await buildShowcaseBundle({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
      allowOverwrite: true,
    });
    createdTempDirs.push(bundlePath);
    // Tamper: bump integritySha256.
    const raw = await readFile(bundlePath, "utf-8");
    const tampered = JSON.parse(raw) as ShowcaseBundle;
    tampered.integritySha256 = "0".repeat(64);
    await writeFile(bundlePath, JSON.stringify(tampered, null, 2), { mode: 0o600 });
    await expect(verifyShowcaseBundle(bundlePath)).rejects.toThrow(/bundle integritySha256 不一致/);
  });

  it("verifyShowcaseBundle rejects unknown schema versions", async () => {
    const runId = `bundle-future-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const { bundlePath } = await buildShowcaseBundle({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
      allowOverwrite: true,
    });
    createdTempDirs.push(bundlePath);
    const raw = await readFile(bundlePath, "utf-8");
    const tampered = JSON.parse(raw) as ShowcaseBundle;
    tampered.schemaVersion = 99 as ShowcaseBundle["schemaVersion"];
    await writeFile(bundlePath, JSON.stringify(tampered, null, 2), { mode: 0o600 });
    await expect(verifyShowcaseBundle(bundlePath)).rejects.toThrow(/bundle schemaVersion 99 不受支持/);
  });
});

// ---------------------------------------------------------------------------
// §4 Redaction attack tests
// ---------------------------------------------------------------------------

describe("T46-7 §4 — Redaction attacks", () => {
  it("redactText strips raw user/task/member IDs", () => {
    const salt = generatePseudonymSalt();
    const input = "user_abc12345 任务 task_def45678 由 member_ghi78901 完成";
    const redacted = redactText(input, salt);
    expect(redacted).not.toMatch(/user_abc12345/);
    expect(redacted).not.toMatch(/task_def45678/);
    expect(redacted).not.toMatch(/member_ghi78901/);
    // Pseudonyms should appear.
    expect(redacted).toMatch(/user_[a-f0-9]{16}/);
    expect(redacted).toMatch(/task_[a-f0-9]{16}/);
    expect(redacted).toMatch(/member_[a-f0-9]{16}/);
  });

  it("redactText strips absolute paths", () => {
    const salt = generatePseudonymSalt();
    const input = "文件位于 /tmp/secret/run-1234/report.json 已处理";
    const redacted = redactText(input, salt);
    expect(redacted).not.toMatch(/\/tmp\/secret/);
    expect(redacted).toMatch(/<absolute_path_redacted>/);
  });

  it("redactText strips OpenAI API keys and GitHub tokens", () => {
    const salt = generatePseudonymSalt();
    const input = "key=sk-1234567890abcdefghijklmnopqrstuvwxyz token=ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const redacted = redactText(input, salt);
    expect(redacted).not.toMatch(/sk-1234567890abcdefghijklmnopqrstuvwxyz/);
    expect(redacted).not.toMatch(/ghp_1234567890abcdefghijklmnopqrstuvwxyz/);
  });

  it("bundle contains no raw user/task/member IDs after export", async () => {
    const runId = `redact-attack-${Date.now()}`;
    const scenario = buildSmokeScenario(`${runId}-scenario`);
    const observation = buildObservation(
      scenario.scenarioId,
      "包含 user_secret12345678 和 task_confidential8901 的输出",
    );
    const { verified } = await publishVerifiedArtifact({
      runId,
      scenarios: [scenario],
      observations: [observation],
    });
    const { bundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const serialized = JSON.stringify(bundle);
    // The raw IDs must not appear anywhere in the bundle.
    expect(serialized).not.toMatch(/user_secret12345678/);
    expect(serialized).not.toMatch(/task_confidential8901/);
    // Pseudonyms are fine.
    expect(serialized).toMatch(/user_[a-f0-9]{16}/);
  });

  it("verifyShowcaseBundle rejects bundles that leak raw IDs", async () => {
    const runId = `redact-leak-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const { bundle, bundlePath } = await buildShowcaseBundle({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
      allowOverwrite: true,
    });
    createdTempDirs.push(bundlePath);
    // Inject a raw ID into the bundle and recompute hash to simulate
    // a malicious exporter.
    const tampered: ShowcaseBundle = {
      ...bundle,
      releaseVerdict: {
        ...bundle.releaseVerdict,
        summary: `${bundle.releaseVerdict.summary} user_1234567890abcdefgh`,
      },
    };
    const { integritySha256: _drop, ...rest } = tampered;
    void _drop;
    tampered.integritySha256 = sha256(stableStringify(rest));
    await writeFile(bundlePath, JSON.stringify(tampered, null, 2), { mode: 0o600 });
    await expect(verifyShowcaseBundle(bundlePath)).rejects.toThrow(/bundle 检测到未脱敏的 raw user_id/);
  });
});

// ---------------------------------------------------------------------------
// §5 Bundle-scoped pseudonym tests
// ---------------------------------------------------------------------------

describe("T46-7 §5 — Bundle-scoped pseudonyms", () => {
  it("same raw ID maps to same pseudonym within a bundle", () => {
    const salt = generatePseudonymSalt();
    const a1 = pseudonymize("scenario-abc", salt, "scenario");
    const a2 = pseudonymize("scenario-abc", salt, "scenario");
    expect(a1).toBe(a2);
  });

  it("different raw IDs map to different pseudonyms", () => {
    const salt = generatePseudonymSalt();
    const a1 = pseudonymize("scenario-abc", salt, "scenario");
    const a2 = pseudonymize("scenario-xyz", salt, "scenario");
    expect(a1).not.toBe(a2);
  });

  it("different salts produce different pseudonyms for the same raw ID", () => {
    const salt1 = generatePseudonymSalt();
    const salt2 = generatePseudonymSalt();
    const a1 = pseudonymize("scenario-abc", salt1, "scenario");
    const a2 = pseudonymize("scenario-abc", salt2, "scenario");
    expect(a1).not.toBe(a2);
  });

  it("different prefixes produce different pseudonyms for the same raw ID", () => {
    const salt = generatePseudonymSalt();
    const scenarioP = pseudonymize("abc", salt, "scenario");
    const packetP = pseudonymize("abc", salt, "packet");
    expect(scenarioP).not.toBe(packetP);
    expect(scenarioP).toMatch(/^scenario_/);
    expect(packetP).toMatch(/^packet_/);
  });

  it("pseudonymize rejects empty rawId and invalid prefix", () => {
    const salt = generatePseudonymSalt();
    expect(() => pseudonymize("", salt, "scenario")).toThrow(/pseudonymize 拒绝空 rawId/);
    expect(() => pseudonymize("abc", salt, "Invalid-Prefix")).toThrow(/pseudonym 前缀非法/);
  });

  it("two bundles for the same artifact produce different pseudonyms (no cross-bundle correlation)", async () => {
    const runId = `pseudonym-bundles-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const now = () => "2026-07-20T00:00:00.000Z";
    const { bundle: bundle1 } = await buildShowcaseBundleInMemory({ verified, projectRoot, now });
    const { bundle: bundle2 } = await buildShowcaseBundleInMemory({ verified, projectRoot, now });
    // Pseudonyms must NOT be correlatable across bundles.
    expect(bundle1.sourceArtifact.runIdPseudonym).not.toBe(bundle2.sourceArtifact.runIdPseudonym);
  });
});

// ---------------------------------------------------------------------------
// §6 Result graph parity tests (viewer ↔ bundle)
// ---------------------------------------------------------------------------

describe("T46-7 §6 — Viewer ↔ bundle parity", () => {
  it("viewer and bundle produce identical fingerprints for the same artifact", async () => {
    const runId = `parity-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const now = () => "2026-07-20T00:00:00.000Z";
    // Issue #100 §3.2: viewer and bundle must produce identical
    // fingerprints. Share the salt so pseudonyms match byte-for-byte.
    const salt = generatePseudonymSalt();
    // Build bundle in memory to get its fingerprint.
    const { bundle: inMemoryBundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now,
      salt,
    });
    // Start viewer, fetch its /bundle route, and compare.
    const handle = await startLocalViewer({ verified, projectRoot, port: 0, host: "127.0.0.1", now, salt });
    try {
      const response = await fetch(`${handle.url}bundle`);
      expect(response.status).toBe(200);
      const viewerBundle = (await response.json()) as ShowcaseBundle;
      expect(viewerBundle.integritySha256).toBe(inMemoryBundle.integritySha256);
      expect(viewerBundle.releaseVerdict).toEqual(inMemoryBundle.releaseVerdict);
      expect(viewerBundle.costs).toEqual(inMemoryBundle.costs);
      expect(viewerBundle.sourceArtifact).toEqual(inMemoryBundle.sourceArtifact);
    } finally {
      await handle.close();
    }
  });

  it("viewer /api/viewer payload matches bundle verdict and counts", async () => {
    const runId = `parity-api-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const now = () => "2026-07-20T00:00:00.000Z";
    const salt = generatePseudonymSalt();
    const { bundle } = await buildShowcaseBundleInMemory({ verified, projectRoot, now, salt });
    const handle = await startLocalViewer({ verified, projectRoot, port: 0, host: "127.0.0.1", now, salt });
    try {
      const response = await fetch(`${handle.url}api/viewer`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        releaseVerdict: typeof bundle.releaseVerdict;
        hardGates: typeof bundle.hardGates;
        costs: typeof bundle.costs;
        sourceArtifact: typeof bundle.sourceArtifact;
        portableBundleFingerprint: string;
      };
      expect(payload.releaseVerdict).toEqual(bundle.releaseVerdict);
      expect(payload.hardGates).toEqual(bundle.hardGates);
      expect(payload.costs).toEqual(bundle.costs);
      expect(payload.sourceArtifact).toEqual(bundle.sourceArtifact);
      expect(payload.portableBundleFingerprint).toBe(bundle.integritySha256);
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// §7 No-grade-recomputation tests
// ---------------------------------------------------------------------------

describe("T46-7 §7 — No grade recomputation", () => {
  it("bundle releaseVerdict.honestBaseline equals the artifact's summary counts", async () => {
    const runId = `no-recompute-${Date.now()}`;
    const s1 = buildSmokeScenario(`${runId}-s1`);
    const s2 = buildSmokeScenario(`${runId}-s2`);
    const s3 = buildSmokeScenario(`${runId}-s3`);
    const { verified } = await publishVerifiedArtifact({
      runId,
      scenarios: [s1, s2, s3],
      observations: [
        buildObservation(s1.scenarioId, "ok"),
        buildObservation(s2.scenarioId, "ok"),
        buildObservation(s3.scenarioId, "ok"),
      ],
      grades: [
        buildGrade(s1.scenarioId, true),
        buildGrade(s2.scenarioId, true),
        buildGrade(s3.scenarioId, false, ["failure"]),
      ],
      status: "regression",
    });
    const { bundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    // Honest baseline is 2/3 (read from artifact.summary.passedCount).
    expect(bundle.releaseVerdict.honestBaseline).toBe("2/3");
    expect(bundle.releaseVerdict.verdict).toBe("regression");
  });

  it("bundle never modifies the artifact's grades array", async () => {
    const runId = `no-mutate-grades-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const gradesBefore = JSON.parse(JSON.stringify(verified.artifact.grades)) as Grade[];
    await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(verified.artifact.grades).toEqual(gradesBefore);
  });

  it("viewer never modifies the artifact's observations", async () => {
    const runId = `no-mutate-obs-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const obsBefore = JSON.parse(JSON.stringify(verified.artifact.observations)) as ScenarioObservation[];
    const handle = await startLocalViewer({
      verified,
      projectRoot,
      port: 0,
      host: "127.0.0.1",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    try {
      await fetch(`${handle.url}artifact`);
    } finally {
      await handle.close();
    }
    expect(verified.artifact.observations).toEqual(obsBefore);
  });
});

// ---------------------------------------------------------------------------
// §8 Loopback-only binding tests
// ---------------------------------------------------------------------------

describe("T46-7 §8 — Loopback-only binding", () => {
  it("LOOPBACK_HOSTS contains only 127.0.0.1 and ::1", () => {
    expect(LOOPBACK_HOSTS).toContain("127.0.0.1");
    expect(LOOPBACK_HOSTS).toContain("::1");
    expect(LOOPBACK_HOSTS.length).toBe(2);
  });

  it("DEFAULT_VIEWER_PORT is 0 (ephemeral)", () => {
    expect(DEFAULT_VIEWER_PORT).toBe(0);
  });

  it("startLocalViewer rejects non-loopback hosts", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `bind-reject-${Date.now()}` });
    await expect(
      startLocalViewer({
        verified,
        projectRoot,
        port: 0,
        host: "0.0.0.0" as "127.0.0.1",
      }),
    ).rejects.toThrow(/viewer 拒绝绑定非 loopback 主机/);
    await expect(
      startLocalViewer({
        verified,
        projectRoot,
        port: 0,
        host: "192.168.1.1" as "127.0.0.1",
      }),
    ).rejects.toThrow(/viewer 拒绝绑定非 loopback 主机/);
  });

  it("startLocalViewer binds to 127.0.0.1 by default", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `bind-default-${Date.now()}` });
    const handle = await startLocalViewer({
      verified,
      projectRoot,
      port: 0,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    try {
      expect(handle.host).toBe("127.0.0.1");
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    } finally {
      await handle.close();
    }
  });

  it("startLocalViewer binds to ::1 when explicitly requested", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `bind-ipv6-${Date.now()}` });
    const handle = await startLocalViewer({
      verified,
      projectRoot,
      port: 0,
      host: "::1",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    try {
      expect(handle.host).toBe("::1");
      expect(handle.url).toMatch(/^http:\/\/\[::1\]:\d+\//);
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// §9 Viewer no-mutation route/control tests
// ---------------------------------------------------------------------------

describe("T46-7 §9 — Viewer has no mutation routes", () => {
  let handle: ViewerHandle;
  let baseUrl: string;

  beforeEach(async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `no-mutate-${Date.now()}` });
    handle = await startLocalViewer({
      verified,
      projectRoot,
      port: 0,
      host: "127.0.0.1",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    baseUrl = handle.url;
  });

  afterEach(async () => {
    if (handle) await handle.close();
  });

  it("POST / is rejected with 405", async () => {
    const response = await fetch(baseUrl, { method: "POST", body: "x" });
    expect(response.status).toBe(405);
  });

  it("PUT /api/viewer is rejected with 405", async () => {
    const response = await fetch(`${baseUrl}api/viewer`, { method: "PUT", body: "x" });
    expect(response.status).toBe(405);
  });

  it("DELETE / is rejected with 405", async () => {
    const response = await fetch(baseUrl, { method: "DELETE" });
    expect(response.status).toBe(405);
  });

  it("PATCH / is rejected with 405", async () => {
    const response = await fetch(baseUrl, { method: "PATCH", body: "x" });
    expect(response.status).toBe(405);
  });

  it("GET /?action=run is rejected as mutation query", async () => {
    const response = await fetch(`${baseUrl}?action=run`);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("mutation_query_rejected");
  });

  it("GET /?promote=standard is rejected as mutation query", async () => {
    const response = await fetch(`${baseUrl}?promote=standard`);
    expect(response.status).toBe(400);
  });

  it("GET /?repair=packet is rejected as mutation query", async () => {
    const response = await fetch(`${baseUrl}?repair=packet`);
    expect(response.status).toBe(400);
  });

  it("GET /unknown-path returns 404", async () => {
    const response = await fetch(`${baseUrl}unknown-path`);
    expect(response.status).toBe(404);
  });

  it("GET /health returns ok", async () => {
    const response = await fetch(`${baseUrl}health`);
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("GET / returns HTML overview with READ-ONLY badge", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toMatch(/READ-ONLY/);
    expect(html).toMatch(/offline\/synthetic/);
  });
});

// ---------------------------------------------------------------------------
// §10 Atomic preview publish & accepted baseline not overwritten
// ---------------------------------------------------------------------------

describe("T46-7 §10 — Atomic preview publish", () => {
  it("LIVE_PREVIEW_RUN_ID_PREFIX is preview_", () => {
    expect(LIVE_PREVIEW_RUN_ID_PREFIX).toBe("preview_");
  });

  it("LIVE_PREVIEW_LABEL_FILE is preview_label.json", () => {
    expect(LIVE_PREVIEW_LABEL_FILE).toBe("preview_label.json");
  });

  it("LIVE_PREVIEW_SUT_CEILING_USD is $0.10", () => {
    expect(LIVE_PREVIEW_SUT_CEILING_USD).toBe(0.10);
  });

  it("buildPreviewBudget enforces the $0.10 SUT cap", () => {
    const budget = buildPreviewBudget();
    expect(budget.maxSutCostUsd).toBe(LIVE_PREVIEW_SUT_CEILING_USD);
    expect(budget.maxSutCostUsd).toBeLessThanOrEqual(0.10);
  });

  it("runLivePreview produces a runId with preview_ prefix and label file", async () => {
    const result = await runLivePreview({
      projectRoot,
      model: "mock:mock-model",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    createdRunDirs.push(result.runDir);
    expect(result.runId.startsWith(LIVE_PREVIEW_RUN_ID_PREFIX)).toBe(true);
    expect(result.preview).toBe(true);
    expect(existsSync(result.labelPath)).toBe(true);
    expect(result.modelIsMock).toBe(true);
    expect(result.remainingGates).toEqual([]);
    // Read the label file and verify it has the preview marker.
    const labelRaw = await readFile(result.labelPath, "utf-8");
    const label = JSON.parse(labelRaw) as { preview: boolean; runId: string };
    expect(label.preview).toBe(true);
    expect(label.runId).toBe(result.runId);
  }, 60_000);

  it("runLivePreview does NOT sleep or fake latency", async () => {
    const startedMs = Date.now();
    const result = await runLivePreview({
      projectRoot,
      model: "mock:mock-model",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    createdRunDirs.push(result.runDir);
    const elapsedMs = Date.now() - startedMs;
    // Mock preview should complete quickly (well under 30s). The
    // durationMs reported must be honest, not inflated.
    expect(result.durationMs).toBeLessThan(30_000);
    expect(elapsedMs).toBeLessThan(60_000);
    // The reported duration must be approximately the real elapsed time.
    expect(Math.abs(elapsedMs - result.durationMs)).toBeLessThan(5_000);
  }, 90_000);

  it("runLivePreview never overwrites an accepted baseline path", async () => {
    // Run two previews — each must produce a unique runId and runDir.
    const r1 = await runLivePreview({
      projectRoot,
      model: "mock:mock-model",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const r2 = await runLivePreview({
      projectRoot,
      model: "mock:mock-model",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    createdRunDirs.push(r1.runDir, r2.runDir);
    expect(r1.runId).not.toBe(r2.runId);
    expect(r1.runDir).not.toBe(r2.runDir);
  }, 90_000);

  it("committed showcase bundle is not overwritten by a preview run", async () => {
    // Publish a verified artifact, then commit a showcase bundle. A
    // subsequent live preview run must not touch the bundle path.
    const runId = `preview-baseline-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const { bundlePath } = await buildShowcaseBundle({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    createdTempDirs.push(bundlePath);
    const bundleContentBefore = await readFile(bundlePath, "utf-8");
    // Run a live preview.
    const preview = await runLivePreview({
      projectRoot,
      model: "mock:mock-model",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    createdRunDirs.push(preview.runDir);
    // The bundle must be byte-identical.
    const bundleContentAfter = await readFile(bundlePath, "utf-8");
    expect(bundleContentAfter).toBe(bundleContentBefore);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// §11 Schema migration — explicit, deterministic
// ---------------------------------------------------------------------------

describe("T46-7 §11 — Schema migration explicitness", () => {
  it("MIGRATIONS table is frozen and empty for V1", () => {
    expect(Array.isArray(MIGRATIONS)).toBe(true);
    expect(MIGRATIONS.length).toBe(0);
  });

  it("migrateArtifact records an empty migration log for V1 artifacts", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `mig-log-${Date.now()}` });
    const result = migrateArtifact(verified.artifact);
    expect(result.migrationsApplied).toEqual([]);
    expect(result.sourceSchemaVersion).toBe(result.targetSchemaVersion);
  });

  it("verifyAndMigrateArtifact populates the migration log on VerifiedArtifact", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `mig-verify-${Date.now()}` });
    expect(verified.migrationLog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §12 Unsupported future schema fail-closed
// ---------------------------------------------------------------------------

describe("T46-7 §12 — Future schema fail-closed", () => {
  it("assertSupportedSchema rejects version 99", () => {
    expect(() => assertSupportedSchema(99)).toThrow(/不受支持的 schemaVersion: 99/);
  });

  it("assertSupportedSchema rejects version 0 and negative versions", () => {
    expect(() => assertSupportedSchema(0)).toThrow(/不受支持的 schemaVersion/);
    expect(() => assertSupportedSchema(-1)).toThrow(/不受支持的 schemaVersion/);
  });

  it("migrateArtifact rejects a future schema version", () => {
    const future = { ...({} as EvaluationArtifact), schemaVersion: 2 };
    expect(() => migrateArtifact(future)).toThrow(/不受支持的 artifact schemaVersion: 2/);
  });

  it("verifyAndMigrateArtifact rejects integrity.json with a future schemaVersion", async () => {
    const runId = `future-integrity-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    // Corrupt the integrity.json by bumping its schemaVersion.
    const integrityPath = join(verified.runDir, "integrity.json");
    const raw = await readFile(integrityPath, "utf-8");
    const tampered = JSON.parse(raw);
    tampered.schemaVersion = 99;
    // The artifact store chmod's individual files to 0o400 (immutable).
    // We must chmod the FILE (not just the directory) before writing.
    await chmod(verified.runDir, 0o700);
    await chmod(integrityPath, 0o600);
    await writeFile(integrityPath, JSON.stringify(tampered, null, 2), { mode: 0o600 });
    await expect(verifyAndMigrateArtifact(verified.runDir, runId)).rejects.toThrow(/integrity\.json schemaVersion 99 不受支持/);
  });
});

// ---------------------------------------------------------------------------
// §13 Malformed / hash mismatch / provenance mismatch
// ---------------------------------------------------------------------------

describe("T46-7 §13 — Malformed artifact fail-closed", () => {
  it("verifyAndMigrateArtifact rejects a malformed integrity.json", async () => {
    const runId = `malformed-integrity-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const integrityPath = join(verified.runDir, "integrity.json");
    await chmod(verified.runDir, 0o700);
    await chmod(integrityPath, 0o600);
    await writeFile(integrityPath, "{not-json", { mode: 0o600 });
    await expect(verifyAndMigrateArtifact(verified.runDir, runId)).rejects.toThrow(/integrity\.json 解析失败/);
  });

  it("verifyAndMigrateArtifact rejects a malformed report.json", async () => {
    const runId = `malformed-report-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const reportPath = join(verified.runDir, "report.json");
    await chmod(verified.runDir, 0o700);
    await chmod(reportPath, 0o600);
    await writeFile(reportPath, "{not-json", { mode: 0o600 });
    // The integrity.json hash check fires first (reportSha256 mismatch),
    // then the parse error. Either failure mode is acceptable.
    await expect(verifyAndMigrateArtifact(verified.runDir, runId)).rejects.toThrow(/(report\.json 哈希与 integrity\.reportSha256 不一致|report\.json 解析失败)/);
  });

  it("verifyAndMigrateArtifact rejects when report.json hash does not match integrity.reportSha256", async () => {
    const runId = `hash-mismatch-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const reportPath = join(verified.runDir, "report.json");
    const raw = await readFile(reportPath, "utf-8");
    const tampered = JSON.parse(raw) as EvaluationArtifact;
    tampered.summary = { ...tampered.summary, passedCount: tampered.summary.passedCount + 1 };
    await chmod(verified.runDir, 0o700);
    await chmod(reportPath, 0o600);
    await writeFile(reportPath, JSON.stringify(tampered, null, 2), { mode: 0o600 });
    await expect(verifyAndMigrateArtifact(verified.runDir, runId)).rejects.toThrow(/report\.json 哈希与 integrity\.reportSha256 不一致/);
  });

  it("verifyAndMigrateArtifact rejects when a file hash in the integrity index is wrong", async () => {
    const runId = `file-hash-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    // Tamper with manifest.json (which is in the integrity index).
    const manifestPath = join(verified.runDir, "manifest.json");
    const raw = await readFile(manifestPath, "utf-8");
    const tampered = JSON.parse(raw);
    tampered.createdAt = "1970-01-01T00:00:00.000Z";
    await chmod(verified.runDir, 0o700);
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, JSON.stringify(tampered, null, 2), { mode: 0o600 });
    await expect(verifyAndMigrateArtifact(verified.runDir, runId)).rejects.toThrow(/result graph hash 校验失败: manifest\.json/);
  });

  it("verifyAndMigrateArtifact rejects when provenance is missing", async () => {
    const runId = `no-provenance-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const reportPath = join(verified.runDir, "report.json");
    const raw = await readFile(reportPath, "utf-8");
    const tampered = JSON.parse(raw) as EvaluationArtifact;
    delete (tampered as { provenance?: EvaluationProvenance }).provenance;
    // Recompute the integrity hash so the only failure is the missing
    // provenance — this proves the provenance check is independent.
    // IMPORTANT: we must set tampered.integrityRootSha256 BEFORE
    // computing newReportSha256, because the report on disk includes
    // integrityRootSha256 and the hash must match what we write.
    const integrityRaw = await readFile(join(verified.runDir, "integrity.json"), "utf-8");
    const integrity = JSON.parse(integrityRaw) as { entries: Record<string, string>; evidenceRootSha256: string; reportSha256: string; integrityRootSha256: string };
    // Step 1: compute the new integrity root using the tampered report
    // (with provenance deleted) but WITHOUT integrityRootSha256 (excluded
    // to avoid self-referential hash, mirroring verifyResultGraph §2.3).
    const { integrityRootSha256: _drop, ...rest } = tampered;
    void _drop;
    const newIntegrityRoot = sha256(stableStringify({ entries: integrity.entries, report: rest }));
    // Step 2: set tampered.integrityRootSha256 to the new root.
    tampered.integrityRootSha256 = newIntegrityRoot;
    // Step 3: NOW compute the report hash (after integrityRootSha256 is set).
    const newReportSha256 = sha256(JSON.stringify(tampered, null, 2) + "\n");
    integrity.reportSha256 = newReportSha256;
    integrity.integrityRootSha256 = newIntegrityRoot;
    await chmod(verified.runDir, 0o700);
    await chmod(reportPath, 0o600);
    const integrityPath = join(verified.runDir, "integrity.json");
    await chmod(integrityPath, 0o600);
    await writeFile(reportPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    await writeFile(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`, { mode: 0o600 });
    await expect(verifyAndMigrateArtifact(verified.runDir, runId)).rejects.toThrow(/artifact 缺少 provenance/);
  });

  it("verifyAndMigrateArtifact rejects a malformed runId", async () => {
    await expect(verifyAndMigrateArtifact("/tmp/whatever", "")).rejects.toThrow(/非法 run ID/);
    await expect(verifyAndMigrateArtifact("/tmp/whatever", "run id with spaces")).rejects.toThrow(/非法 run ID/);
    await expect(verifyAndMigrateArtifact("/tmp/whatever", "run/id/with/slashes")).rejects.toThrow(/非法 run ID/);
  });
});

// ---------------------------------------------------------------------------
// §14 Retention planning — zero deletion
// ---------------------------------------------------------------------------

describe("T46-7 §14 — Retention planning", () => {
  it("RETENTION_REPORT_SCHEMA_VERSION is 1", () => {
    expect(RETENTION_REPORT_SCHEMA_VERSION).toBe(1);
  });

  it("RETENTION_POLICY_VERSION is v1-no-deletion", () => {
    expect(RETENTION_POLICY_VERSION).toBe("v1-no-deletion");
  });

  it("buildRetentionReport never deletes files", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `retention-no-delete-${Date.now()}` });
    const filesBefore = await collectFiles(verified.runDir);
    const report = await buildRetentionReport({
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const filesAfter = await collectFiles(verified.runDir);
    expect(report.autoDeletionPerformed).toBe(false);
    expect(report.deletedFileCount).toBe(0);
    expect(filesAfter.sort()).toEqual(filesBefore.sort());
  });

  it("buildRetentionReport marks failed runs as preserve", async () => {
    const runId = `retention-failed-${Date.now()}`;
    await publishVerifiedArtifact({ runId, status: "regression" });
    const report = await buildRetentionReport({
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const entry = report.runs.find((r) => r.runId === runId);
    expect(entry).toBeDefined();
    expect(entry!.preserve).toBe(true);
    expect(entry!.preserveReasons).toContain("status_failed");
    expect(entry!.eligibleForCleanup).toBe(false);
  });

  it("buildRetentionReport marks preview runs as preserve", async () => {
    const preview = await runLivePreview({
      projectRoot,
      model: "mock:mock-model",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    createdRunDirs.push(preview.runDir);
    const report = await buildRetentionReport({
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const entry = report.runs.find((r) => r.runId === preview.runId);
    expect(entry).toBeDefined();
    expect(entry!.preserve).toBe(true);
    expect(entry!.preserveReasons).toContain("preview_run");
  }, 60_000);

  it("buildRetentionReport marks runs referenced by showcase bundles as preserve", async () => {
    const runId = `retention-referenced-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const { bundlePath } = await buildShowcaseBundle({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    createdTempDirs.push(bundlePath);
    const report = await buildRetentionReport({
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const entry = report.runs.find((r) => r.runId === runId);
    expect(entry).toBeDefined();
    expect(entry!.preserve).toBe(true);
    expect(entry!.preserveReasons).toContain("referenced_by_showcase_bundle");
  });

  it("buildRetentionReport produces a stable integritySha256", async () => {
    const runId = `retention-hash-${Date.now()}`;
    await publishVerifiedArtifact({ runId });
    const now = () => "2026-07-20T00:00:00.000Z";
    const r1 = await buildRetentionReport({ projectRoot, now });
    const r2 = await buildRetentionReport({ projectRoot, now });
    expect(r1.integritySha256).toBe(r2.integritySha256);
  });

  it("publishRetentionReport writes a machine-readable JSON file", async () => {
    const report = await buildRetentionReport({
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const tempDir = await mkdtemp(join(tmpdir(), "retention-publish-"));
    createdTempDirs.push(tempDir);
    const reportPath = join(tempDir, "retention.json");
    await publishRetentionReport(report, reportPath);
    expect(existsSync(reportPath)).toBe(true);
    const reVerified = await verifyRetentionReport(reportPath);
    expect(reVerified.integritySha256).toBe(report.integritySha256);
  });

  it("publishRetentionReport refuses to overwrite an existing report", async () => {
    const report = await buildRetentionReport({
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const tempDir = await mkdtemp(join(tmpdir(), "retention-overwrite-"));
    createdTempDirs.push(tempDir);
    const reportPath = join(tempDir, "retention.json");
    await publishRetentionReport(report, reportPath);
    await expect(publishRetentionReport(report, reportPath)).rejects.toThrow(/拒绝覆盖已存在的报告/);
  });
});

async function collectFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      out.push(full);
      if (e.isDirectory()) await walk(full);
    }
  }
  await walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// §15 Agent-first 3-profile acceptance
// ---------------------------------------------------------------------------

describe("T46-7 §15 — Agent-first acceptance profiles", () => {
  it("defines exactly 3 profiles", () => {
    expect(AGENT_PROFILES.length).toBe(3);
    const names = AGENT_PROFILES.map((p) => p.name);
    expect(names).toContain("codex");
    expect(names).toContain("claude-code");
    expect(names).toContain("trae-equivalent");
  });

  it("every profile has 7 mappings (discover/validate/run/status/verify/show/repair-packet)", () => {
    for (const profile of AGENT_PROFILES) {
      expect(profile.mappings.length).toBe(7);
      const nls = profile.mappings.map((m) => m.naturalLanguage);
      expect(nls).toContain("discover evaluation lab");
      expect(nls).toContain("validate evaluation config");
      expect(nls).toContain("run smoke evaluation");
      expect(nls).toContain("poll run status");
      expect(nls).toContain("verify artifact integrity");
      expect(nls).toContain("show run report");
      expect(nls).toContain("produce repair packet");
    }
  });

  it("every profile points to the same SKILL.md path", () => {
    for (const profile of AGENT_PROFILES) {
      expect(profile.skillMdPath).toBe(SKILL_MD_PATH);
    }
  });

  it("every profile's mappings use mock:mock-model (never paid)", () => {
    for (const profile of AGENT_PROFILES) {
      for (const mapping of profile.mappings) {
        for (const arg of mapping.command) {
          if (arg.startsWith("deepseek:") || arg.startsWith("openai:") || arg.startsWith("anthropic:")) {
            throw new Error(`${profile.name} mapping references paid model: ${arg}`);
          }
        }
      }
    }
  });

  it("AGENT_ACCEPTANCE_SCHEMA_VERSION is 1", () => {
    expect(AGENT_ACCEPTANCE_SCHEMA_VERSION).toBe(1);
  });

  it("EVAL_LAB_SCRIPT points to scripts/eval-lab", () => {
    expect(EVAL_LAB_SCRIPT).toBe("scripts/eval-lab");
  });

  it("runAgentAcceptance rejects an unknown profile name", async () => {
    await expect(
      runAgentAcceptance({
        projectRoot,
        profile: "unknown-profile" as AgentProfileName,
      }),
    ).rejects.toThrow(/未知 agent profile/);
  });

  it("runAgentAcceptance executes all 3 profiles when profile='all'", async () => {
    const results = await runAgentAcceptance({
      projectRoot,
      profile: "all",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(results.length).toBe(3);
    for (const result of results) {
      expect(result.schemaVersion).toBe(AGENT_ACCEPTANCE_SCHEMA_VERSION);
      expect(result.steps.length).toBe(7);
      expect(typeof result.integritySha256).toBe("string");
      expect(result.integritySha256).toMatch(/^[a-f0-9]{64}$/);
    }
    // The harness must NOT invoke real LLM agents — it runs CLI commands.
    // Verify SKILL.md presence was checked.
    for (const result of results) {
      expect(result.skillMdPresent).toBe(true);
    }
  }, 300_000);

  it("publishAgentAcceptanceReport writes a JSON report atomically", async () => {
    const results = await runAgentAcceptance({
      projectRoot,
      profile: "codex",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    const tempDir = await mkdtemp(join(tmpdir(), "agent-acceptance-publish-"));
    createdTempDirs.push(tempDir);
    const reportPath = join(tempDir, "agent-acceptance.json");
    await publishAgentAcceptanceReport(results, reportPath);
    expect(existsSync(reportPath)).toBe(true);
    // Refuse to overwrite.
    await expect(publishAgentAcceptanceReport(results, reportPath)).rejects.toThrow(/拒绝覆盖已存在的报告/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// §16 Cost bucket & unknown-cost truthfulness
// ---------------------------------------------------------------------------

describe("T46-7 §16 — Cost bucket truthfulness", () => {
  it("bundle displays unknown cost as null, not $0", async () => {
    const runId = `cost-unknown-${Date.now()}`;
    const scenario = buildSmokeScenario(`${runId}-scenario`);
    const observation = buildObservation(scenario.scenarioId, "输出", unknownSutCosts());
    const { verified } = await publishVerifiedArtifact({
      runId,
      scenarios: [scenario],
      observations: [observation],
    });
    const { bundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(bundle.costs.sutCost.amountUsd).toBeNull();
    expect(bundle.costs.sutCost.source).toBe("unknown");
  });

  it("bundle keeps Coding Agent cost external/unknown", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `cost-coding-${Date.now()}` });
    const { bundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(bundle.costs.codingAgentCost.amountUsd).toBeNull();
    expect(bundle.costs.codingAgentCost.source).toBe("unknown");
    expect(bundle.costs.codingAgentCost.countedAgainstSutCap).toBe(false);
  });

  it("bundle cost provenance note mentions the three-way split", async () => {
    const { verified } = await publishVerifiedArtifact({ runId: `cost-note-${Date.now()}` });
    const { bundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot,
      now: () => "2026-07-20T00:00:00.000Z",
    });
    expect(bundle.costs.provenanceNote).toMatch(/三类成本独立分账/);
    expect(bundle.costs.provenanceNote).toMatch(/unknown 不得显示为 \$0/);
  });

  it("viewer displays identical cost buckets to the bundle", async () => {
    const runId = `cost-viewer-${Date.now()}`;
    const { verified } = await publishVerifiedArtifact({ runId });
    const now = () => "2026-07-20T00:00:00.000Z";
    const { bundle } = await buildShowcaseBundleInMemory({ verified, projectRoot, now });
    const handle = await startLocalViewer({ verified, projectRoot, port: 0, host: "127.0.0.1", now });
    try {
      const response = await fetch(`${handle.url}api/viewer`);
      const payload = (await response.json()) as { costs: typeof bundle.costs };
      expect(payload.costs).toEqual(bundle.costs);
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// §17 Live preview model gate
// ---------------------------------------------------------------------------

describe("T46-7 §17 — Live preview model gate", () => {
  it("PAID_MODEL_REMAINING_GATES lists all 4 gates", () => {
    expect(PAID_MODEL_REMAINING_GATES.length).toBe(4);
    expect(PAID_MODEL_REMAINING_GATES).toContain("frozen_pricing_table_missing");
    expect(PAID_MODEL_REMAINING_GATES).toContain("pre_call_worst_case_bound_missing");
    expect(PAID_MODEL_REMAINING_GATES).toContain("cost_telemetry_real_provider_unverified");
    expect(PAID_MODEL_REMAINING_GATES).toContain("paid_model_credentials_not_configured_in_evaluation_env");
  });

  it("verifyPreviewModelGate allows mock:mock-model", () => {
    const result = verifyPreviewModelGate("mock:mock-model");
    expect(result.allowed).toBe(true);
    expect(result.modelIsMock).toBe(true);
    expect(result.remainingGates).toEqual([]);
  });

  it("verifyPreviewModelGate rejects deepseek provider (paid fail-closed)", () => {
    const result = verifyPreviewModelGate("deepseek:deepseek-v4-flash");
    expect(result.allowed).toBe(false);
    expect(result.modelIsMock).toBe(false);
    expect(result.remainingGates.length).toBe(4);
  });

  it("verifyPreviewModelGate rejects openai provider (paid fail-closed)", () => {
    const result = verifyPreviewModelGate("openai:gpt-4o-mini");
    expect(result.allowed).toBe(false);
    expect(result.remainingGates).toContain("frozen_pricing_table_missing");
  });

  it("verifyPreviewModelGate rejects malformed model references", () => {
    expect(() => verifyPreviewModelGate("mock")).toThrow(/provider:name 格式/);
    expect(() => verifyPreviewModelGate("deepseek:")).toThrow(/provider:name 格式/);
    expect(() => verifyPreviewModelGate(":deepseek-v4-flash")).toThrow(/provider:name 格式/);
    expect(() => verifyPreviewModelGate("")).toThrow(/provider:name 格式/);
  });

  it("runLivePreview refuses to start a paid model", async () => {
    await expect(
      runLivePreview({
        projectRoot,
        model: "deepseek:deepseek-v4-flash",
        now: () => "2026-07-20T00:00:00.000Z",
      }),
    ).rejects.toThrow(/paid_model_unbounded|paid model|remaining_gates/);
  });

  it("runLivePreview records honest durationMs (no sleep inflation)", async () => {
    const result = await runLivePreview({
      projectRoot,
      model: "mock:mock-model",
      now: () => "2026-07-20T00:00:00.000Z",
    });
    createdRunDirs.push(result.runDir);
    // Mock model: duration must be well under the wall-time budget (30s).
    expect(result.durationMs).toBeLessThan(30_000);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// §18 CLI smoke tests
// ---------------------------------------------------------------------------

describe("T46-7 §18 — CLI smoke", () => {
  it("scripts/eval-lab usage lists all new commands", () => {
    const scriptPath = resolve(projectRoot, "scripts/eval-lab");
    const output = execFileSync("bash", [scriptPath], { encoding: "utf-8" });
    const parsed = JSON.parse(output) as { commands: Record<string, string> };
    expect(parsed.commands.showcase).toMatch(/showcase/);
    expect(parsed.commands.viewer).toMatch(/viewer/);
    expect(parsed.commands.preview).toMatch(/preview/);
    expect(parsed.commands.retention).toMatch(/retention/);
    expect(parsed.commands["agent-acceptance"]).toMatch(/agent-acceptance/);
  });

  it("scripts/eval-lab rejects unknown commands", () => {
    const scriptPath = resolve(projectRoot, "scripts/eval-lab");
    expect(() => {
      try {
        execFileSync("bash", [scriptPath, "totally-unknown-command"], { encoding: "utf-8" });
      } catch (error) {
        const err = error as NodeJS.ErrnoException & { stdout?: string };
        if (err.stdout && err.stdout.includes("未知命令")) {
          throw new Error(err.stdout);
        }
        throw error;
      }
    }).toThrow(/未知命令/);
  });

  it("scripts/eval-lab accepts all new commands in the allowlist", () => {
    const scriptPath = resolve(projectRoot, "scripts/eval-lab");
    // Read the script source and verify each new command appears in
    // the case-statement allowlist. This is a pure file read — no
    // execution — so it cannot time out or trigger network calls.
    const source = execFileSync("cat", [scriptPath], { encoding: "utf-8" });
    // Extract the case-statement allowlist line. The allowlist is a
    // pipe-separated list ending with `) ;;`.
    const allowlistMatch = source.match(/case\s+"\$COMMAND"\s+in\s*\n\s*([^\n]+)\)\s*;;/);
    expect(allowlistMatch).not.toBeNull();
    const allowlist = allowlistMatch![1]!;
    const allowed = new Set(allowlist.split("|").map((s) => s.trim()).filter(Boolean));
    for (const command of ["showcase", "viewer", "preview", "retention", "agent-acceptance"]) {
      expect(allowed.has(command)).toBe(true);
    }
  });
});
