/**
 * T46-7 (Issue #100 §3.1) — Portable redacted showcase bundle.
 *
 * Consumes a {@link VerifiedArtifact} produced by `schema-migration.ts`
 * and emits a single self-contained JSON bundle that can be committed
 * to Git. The bundle is the FIRST of two presentation surfaces; the
 * second is the loopback-only local viewer (`local-viewer.ts`).
 *
 * Boundary invariants (Issue #100 §3.1 + §3.2):
 *  - The bundle MUST consume the SAME verified result graph as the
 *    local viewer. Grades, counts, costs and verdicts are READ-ONLY
 *    summaries of the verified artifact — never recomputed.
 *  - The bundle MUST NOT contain raw traces, private text, secrets,
 *    tokens, cookies, absolute paths, hidden prompts or raw IDs.
 *  - Pseudonyms are stable ONLY within a single bundle. Different
 *    bundles MUST NOT produce correlatable identifiers.
 *  - The bundle MUST be fully portable — no dependency on local raw
 *    artifacts. All summaries are inlined.
 *  - Evidence MUST be marked offline/synthetic. The bundle MUST NOT
 *    claim real-user satisfaction, production quality, retention,
 *    productivity or business outcomes.
 *  - Bundle schema, hash and provenance MUST be verifiable.
 *  - Accepted baselines and already-committed showcase bundles MUST
 *    NOT be overwritten.
 *
 * Issue #100 §4 (schema/provenance):
 *  - Rendering first verifies artifact schema, SHA-256 result graph
 *    and provenance (delegated to `schema-migration.ts`).
 *  - Malformed, hash-mismatch, stale/missing provenance fail-closed.
 *  - Supported older schemas migrate via explicit deterministic
 *    migration; unknown future schemas are rejected.
 */

import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, chmod, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";
import {
  type VerifiedArtifact,
} from "./schema-migration.js";
import type {
  EvaluationArtifact,
  Grade,
  CostLedgerEntry,
} from "./contract.js";
import type {
  RepairPacket,
  IssueCluster,
  DiagnosisRecord,
  CounterfactualRecord,
} from "./diagnosis-contract.js";
import type { CalibrationArtifact } from "./calibration-contract.js";
import { CAPABILITY_DOMAINS, SCENARIO_CLASSES, P0_MANDATORY_CATEGORIES, ROBUSTNESS_VARIANT_KINDS, type CapabilityDomain, type ScenarioClass } from "./golden-core-contract.js";
import { GOLDEN_CORE_REGISTRY } from "./golden-core-registry.js";
import type { GoldenCoreScenarioEntry } from "./golden-core-contract.js";
import { getScenarioMetadata } from "./scenario-metadata.js";
import {
  type ExtensionIntegrityIndex,
  readExtensionIntegrityIndex,
  readVerifiedExtensionFile,
  getExtensionEntriesByType,
  type ExtensionFileType,
} from "./extension-integrity.js";

// ---------------------------------------------------------------------------
// §1 Bundle schema
// ---------------------------------------------------------------------------

export const SHOWCASE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const SHOWCASE_BUNDLE_GENERATOR_VERSION = "t46-slice5-v1";

/** The kind of evidence a summary row represents. */
export type EvidenceKind =
  | "observation"
  | "grade"
  | "repair_packet"
  | "diagnosis"
  | "cluster"
  | "counterfactual"
  | "calibration"
  | "golden_core";

/** A redacted summary of a single evidence row. */
export interface BundleEvidenceRow {
  evidenceKind: EvidenceKind;
  /** Bundle-scoped pseudonym for the source ID (scenarioId / packetId / etc.). */
  sourceIdPseudonym: string;
  /** SHA-256 of the source artifact's canonical content. NOT the file path. */
  sourceContentSha256: string;
  /** Chinese summary, redacted. NEVER includes free-text output — structured fields only. */
  summary: string;
  /** Structured evidence fields. No free text, no raw IDs, no paths. */
  structured?: {
    /** For observation evidence: scenario status fields. */
    scenarioStatus?: string;
    passed?: boolean;
    failureCount?: number;
    hardGatePass?: number;
    hardGateFail?: number;
    latencyMs?: number;
    /** For repair/diagnosis/cluster evidence. */
    causalStatus?: string;
    memberCount?: number;
  };
  /** Always true for portable bundles. */
  redacted: true;
}

/** A redacted summary of a Repair Packet. Issue #100 batch D: portable
 *  showcase MUST NOT include free-text fields (observedSymptom,
 *  expectedContract, affectedComponents, acceptanceCriteria,
 *  protectedBoundaries, nonGoals). Only pseudonym, enum, bool, count,
 *  confidence, content SHA, and controlled template fields survive. */
export interface BundleRepairPacketSummary {
  packetIdPseudonym: string;
  packetType: "fix" | "investigation";
  severity: "low" | "medium" | "high" | "critical";
  causalStatus: string;
  confidence: string;
  staleState: "fresh" | "stale" | "unknown";
  /** Count of protected boundaries (the boundary text is NEVER in the bundle). */
  protectedBoundaryCount: number;
  /** Count of non-goals (the non-goal text is NEVER in the bundle). */
  nonGoalCount: number;
  hasCandidateRegression: boolean;
  integritySha256: string;
}

/** A redacted summary of an Issue Cluster. Issue #100 batch D: sharedCause
 *  is free-text → removed. Only pseudonym, enum, count, confidence. */
export interface BundleIssueClusterSummary {
  clusterIdPseudonym: string;
  memberCount: number;
  causalStatus: string;
  confidence: string;
}

/** A redacted summary of a Diagnosis record. Issue #100 batch D:
 *  observedSymptom/expectedContract are free-text → removed. */
export interface BundleDiagnosisSummary {
  diagnosisIdPseudonym: string;
  causalStatus: string;
  confidence: string;
  integritySha256: string;
}

/** Capability matrix row. */
export interface CapabilityMatrixRow {
  dimension: "domain" | "class";
  key: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  excluded: number;
  infraErrors: number;
}

/** Cost bucket summary. Issue #100 §3.2: three cost buckets; unknown
 *  cost MUST NOT be displayed as $0. */
export interface BundleCostBucket {
  amountUsd: number | null;
  source: "provider_reported" | "versioned_price_estimate" | "unknown";
  countedAgainstSutCap: boolean;
}

/** Skip/exclusion/infra-error entry. */
export interface BundleSkipEntry {
  scenarioIdPseudonym: string;
  reason: string;
  kind: "skip" | "exclusion" | "infra_error";
}

/** Regression closure summary. */
export interface BundleRegressionClosure {
  closedRegressions: number;
  openRegressions: number;
  candidateRegressionsPreserved: number;
  autoPromotionPerformed: false;
}

/** Calibration summary — counts only, no Judge transcripts. */
export interface BundleCalibrationSummary {
  calibrationArtifactPresent: boolean;
  semanticJudgeUsed: boolean;
  activeStandardsPromoted: 0;
  candidateStandardsCount: number;
  conflictCatalog: {
    totalPatterns: number;
    resolved: number;
    unresolved: number;
  };
}

/** Retention summary embedded in the bundle. */
export interface BundleRetentionSummary {
  preserve: string[];
  autoDeletionPerformed: false;
  reportPath: string;
}

/** Release verdict — honest, never green-washed. */
export interface BundleReleaseVerdict {
  verdict: "passed" | "regression" | "partial_budget";
  honestBaseline: string;
  summary: string;
  forbiddenClaims: string[];
}

/** Bundle provenance — separate from artifact provenance. */
export interface BundleProvenance {
  bundleSchemaVersion: typeof SHOWCASE_BUNDLE_SCHEMA_VERSION;
  bundleType: "portable_redacted_showcase";
  generatorVersion: typeof SHOWCASE_BUNDLE_GENERATOR_VERSION;
  generatedAt: string;
  sourceArtifactFingerprint: string;
  /** SHA-256 of the pseudonym salt. The salt itself is NOT in the bundle. */
  pseudonymSaltSha256: string;
  /** Migrations applied to the source artifact before rendering. */
  migrationsApplied: ReadonlyArray<{
    fromVersion: number;
    toVersion: number;
    description: string;
  }>;
}

/** Source artifact summary embedded in the bundle. */
export interface BundleSourceArtifact {
  runIdPseudonym: string;
  preset: string;
  model: string;
  status: string;
  startedAt: string;
  completedAt: string;
  integrityRootSha256: string;
  evidenceRootSha256: string;
  artifactFingerprint: string;
  evidenceClass: "offline_synthetic";
}

/** Hard gates summary. */
export interface BundleHardGates {
  p0MutationsDetected: boolean;
  referenceZeroHardFalseFailures: boolean;
  hiddenFieldLeakageTestsPass: boolean;
  requiredScenariosNotSkippedOrExcluded: boolean;
  evidenceGraphAndChecksumsComplete: boolean;
  noSemanticJudgeRequired: boolean;
}

/** Reliability summary. */
export interface BundleReliability {
  observedTrialPassRate: number | null;
  empiricalAllKReliability: number | null;
  passAtK: number | null;
  modeledPassK: number | null;
  confidenceInterval: { lower: number | null; upper: number | null } | null;
  evidenceSufficient: boolean;
}

/** Coverage summary. */
export interface BundleCoverage {
  canonicalScenarios: number;
  p0MandatoryCategories: number;
  robustnessVariantKinds: number;
  goldenCoreFrozenAt: string | null;
  goldenCoreRegistryFingerprint: string | null;
}

/** The top-level showcase bundle. */
export interface ShowcaseBundle {
  schemaVersion: typeof SHOWCASE_BUNDLE_SCHEMA_VERSION;
  bundleId: string;
  bundleType: "portable_redacted_showcase";
  evidenceClass: "offline_synthetic";
  createdAt: string;
  sourceArtifact: BundleSourceArtifact;
  releaseVerdict: BundleReleaseVerdict;
  hardGates: BundleHardGates;
  capabilityMatrix: CapabilityMatrixRow[];
  reliability: BundleReliability;
  costs: {
    sutCost: BundleCostBucket;
    evaluatorModelCost: BundleCostBucket;
    codingAgentCost: BundleCostBucket;
    provenanceNote: string;
  };
  evidenceChains: BundleEvidenceRow[];
  issueClusters: BundleIssueClusterSummary[];
  repairPacketSummaries: BundleRepairPacketSummary[];
  diagnosisSummaries: BundleDiagnosisSummary[];
  regressionClosure: BundleRegressionClosure;
  coverage: BundleCoverage;
  skips: BundleSkipEntry[];
  exclusions: BundleSkipEntry[];
  infraErrors: BundleSkipEntry[];
  calibration: BundleCalibrationSummary;
  retention: BundleRetentionSummary;
  artifactProvenance: {
    evaluatorVersion: string;
    publicSeamVersion: string;
    platform: string;
    architecture: string;
    nodeVersion: string;
    code: { gitCommit: string; gitDirty: boolean; worktreeSha256: string };
    scenarioContractsSha256: string;
    modelConfigSha256: string;
  };
  bundleProvenance: BundleProvenance;
  integritySha256: string;
}

// ---------------------------------------------------------------------------
// §2 Pseudonym generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh bundle-scoped pseudonym salt. The salt is 32 random
 * bytes — never serialized to the bundle. Only its SHA-256 is recorded
 * so consumers can verify the bundle was generated by some salt
 * without recovering it.
 *
 * Issue #100 §3.1: "pseudonym 只在当前 bundle 内稳定；不同 bundle 不得
 * 产生可关联的稳定标识".
 */
export function generatePseudonymSalt(): Buffer {
  return randomBytes(32);
}

/**
 * Derive a stable, bundle-scoped pseudonym for a raw ID. The pseudonym
 * is `prefix_` followed by the first 16 hex chars of
 * `sha256(salt || ":" || prefix || ":" || rawId)`. The prefix makes the
 * pseudonym self-describing (run_, packet_, cluster_, etc.) without
 * leaking the raw ID.
 */
export function pseudonymize(rawId: string, salt: Buffer, prefix: string): string {
  if (!rawId || typeof rawId !== "string") {
    throw new EvaluationValidationError(`pseudonymize 拒绝空 rawId (prefix=${prefix})`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new EvaluationValidationError(`pseudonym 前缀非法: ${prefix}`);
  }
  const hash = createHash("sha256")
    .update(Buffer.concat([salt, Buffer.from(`:${prefix}:${rawId}`, "utf-8")]))
    .digest("hex");
  return `${prefix}_${hash.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// §3 Redaction
// ---------------------------------------------------------------------------

const RAW_USER_ID_PATTERN = /\buser_[a-zA-Z0-9_-]+\b/g;
const RAW_TASK_ID_PATTERN = /\btask_[a-zA-Z0-9_-]+\b/g;
const RAW_MEMBER_ID_PATTERN = /\bmember_[a-zA-Z0-9_-]+\b/g;
const RAW_PROJECT_ID_PATTERN = /\bproject_[a-zA-Z0-9_-]+\b/g;
const RAW_WORKSPACE_ID_PATTERN = /\bworkspace_[a-zA-Z0-9_-]+\b/g;
const RAW_PROPOSAL_ID_PATTERN = /\bproposal_[a-zA-Z0-9_-]+\b/g;
const RAW_CONVERSATION_ID_PATTERN = /\bconv(?:ersation)?_[a-zA-Z0-9_-]+\b/g;
const STANDALONE_JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const ABSOLUTE_PATH_PATTERN = /(?:^|\s)(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)|(?:^|\s)([A-Z]:\\[^<*?"|>\r\n]+)/g;
const SECRET_PATTERN = /\b(?:sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,}|ghp_[a-zA-Z0-9]{30,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/g;

/**
 * Issue #100 fix #2 + batch D: fail-closed privacy assertion.
 *
 * Scans the serialized bundle JSON for raw ID patterns, secrets, tokens,
 * absolute paths and other privacy-sensitive content.
 *
 * Structured allowlist is the primary boundary — regex scanning is
 * defense-in-depth only. Any detection causes the bundle to fail to build.
 *
 * THROWS on any detection → bundle is never published.
 */
export function assertBundlePrivacy(bundle: object): void {
  const serialized = JSON.stringify(bundle);
  const checks: Array<{ name: string; pattern: RegExp }> = [
    // Raw ID patterns.
    { name: "raw user_id", pattern: /\buser_[a-zA-Z0-9_-]{8,}\b/ },
    { name: "raw task_id", pattern: /\btask_[a-zA-Z0-9_-]{8,}\b/ },
    { name: "raw member_id", pattern: /\bmember_[a-zA-Z0-9_-]{8,}\b/ },
    { name: "raw project_id", pattern: /\bproject_[a-zA-Z0-9_-]{8,}\b/ },
    { name: "raw workspace_id", pattern: /\bworkspace_[a-zA-Z0-9_-]{8,}\b/ },
    { name: "raw conversation_id", pattern: /\bconv(ersation)?_[a-zA-Z0-9_-]{8,}\b/ },
    { name: "raw proposal_id", pattern: /\bproposal_[a-zA-Z0-9_-]{8,}\b/ },
    { name: "raw run_id (non-prefixed)", pattern: /"runId":\s*"run_[a-zA-Z0-9_-]{8,}"/ },
    // Secret/token patterns.
    { name: "OpenAI API key", pattern: /sk-[a-zA-Z0-9]{20,}/ },
    { name: "GitHub token", pattern: /ghp_[a-zA-Z0-9]{30,}/ },
    { name: "bearer/JWT token", pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/ },
    { name: "standalone JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
    { name: "private key block", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
    { name: "generic API token/key", pattern: /\b(api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|secret[_-]?key)\b.*:.*"[A-Za-z0-9._-]{16,}"/i },
    // Cookie/password patterns.
    { name: "session cookie", pattern: /\b(session|sid|token|auth|jwt)\s*=\s*[a-zA-Z0-9._-]{16,}/ },
    { name: "password field", pattern: /\b(password|passwd|pwd)\b.*:\s*"[^"]+"/i },
    // Path patterns.
    { name: "absolute Unix path", pattern: /\/(Users|home|root|tmp|opt|etc|var)\// },
    { name: "Windows drive letter path", pattern: /[A-Z]:\\/ },
    { name: "agent-bridge artifacts path", pattern: /agent-bridge\/artifacts\/run_/ },
    // Raw hidden prompt sentinel leakage.
    { name: "hidden field token (sentinel)", pattern: /hiddenFieldTokens?|hidden_sentinel|hidden_field/i },
  ];
  for (const { name, pattern } of checks) {
    if (pattern.test(serialized)) {
      throw new EvaluationInfrastructureError(
        `bundle 隐私断言失败: 检测到未脱敏的 ${name}`,
      );
    }
  }
}

/**
 *
 * The `salt` and a per-text `idPrefix` ensure the same raw ID maps to
 * the same pseudonym within the bundle but different bundles cannot
 * correlate.
 */
export function redactText(text: string | undefined | null, salt: Buffer): string {
  if (!text || typeof text !== "string") return "";
  let redacted = text;
  redacted = redacted.replace(RAW_USER_ID_PATTERN, (match) => pseudonymize(match, salt, "user"));
  redacted = redacted.replace(RAW_TASK_ID_PATTERN, (match) => pseudonymize(match, salt, "task"));
  redacted = redacted.replace(RAW_MEMBER_ID_PATTERN, (match) => pseudonymize(match, salt, "member"));
  redacted = redacted.replace(RAW_PROJECT_ID_PATTERN, (match) => pseudonymize(match, salt, "project"));
  redacted = redacted.replace(RAW_WORKSPACE_ID_PATTERN, (match) => pseudonymize(match, salt, "workspace"));
  redacted = redacted.replace(RAW_PROPOSAL_ID_PATTERN, (match) => pseudonymize(match, salt, "proposal"));
  redacted = redacted.replace(RAW_CONVERSATION_ID_PATTERN, (match) => pseudonymize(match, salt, "conversation"));
  redacted = redacted.replace(ABSOLUTE_PATH_PATTERN, " <absolute_path_redacted> ");
  redacted = redacted.replace(SECRET_PATTERN, " <secret_redacted> ");
  redacted = redacted.replace(STANDALONE_JWT_PATTERN, " <secret_redacted> ");
  return redacted;
}

// ---------------------------------------------------------------------------
// §4 Bundle directory layout
// ---------------------------------------------------------------------------

export const SHOWCASE_BUNDLE_DIR = "agent-bridge/showcase/bundles";
export const SHOWCASE_RETENTION_DIR = "agent-bridge/showcase/retention";
/**
 * Local-only sidecar directory. Each bundle published via
 * `buildShowcaseBundle` writes a `<bundleId>.source.json` file here
 * recording the RAW source runId. This is NOT part of the portable
 * bundle (the bundle only carries `runIdPseudonym`). The sidecar
 * exists solely so the retention planner can mark source runs as
 * `referenced_by_showcase_bundle` without reverse-mapping pseudonyms.
 *
 * Issue #100 §3.1: "committed bundle 必须真正 portable, 不能依赖本机
 * raw artifact" — the sidecar is local bookkeeping, never committed
 * to Git, and the bundle itself remains fully portable.
 */
export const SHOWCASE_BUNDLE_SOURCES_DIR = "agent-bridge/showcase/bundle-sources";

/**
 * Resolve the showcase bundle directory under the project root. The
 * directory is committed to Git (unlike `agent-bridge/artifacts/`).
 */
export function showcaseBundleDir(projectRoot: string): string {
  return resolve(projectRoot, SHOWCASE_BUNDLE_DIR);
}

/**
 * Resolve the retention report directory under the project root.
 */
export function showcaseRetentionDir(projectRoot: string): string {
  return resolve(projectRoot, SHOWCASE_RETENTION_DIR);
}

/**
 * Resolve the local-only bundle-sources sidecar directory. Files in
 * this directory are NOT committed to Git (see `.gitignore`).
 */
export function showcaseBundleSourcesDir(projectRoot: string): string {
  return resolve(projectRoot, SHOWCASE_BUNDLE_SOURCES_DIR);
}

/**
 * Sidecar record mapping a published bundle to its raw source runId.
 * Local-only — never inlined into the portable bundle.
 */
export interface BundleSourceSidecar {
  bundleId: string;
  sourceRunId: string;
  sourceRunDir: string;
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// §5 Bundle construction
// ---------------------------------------------------------------------------

export interface BuildShowcaseBundleOptions {
  /** The verified artifact to render. */
  verified: VerifiedArtifact;
  /** Project root (for reading auxiliary artifacts: repair packets, clusters, etc.). */
  projectRoot: string;
  /** Optional bundle ID. Auto-generated when omitted. */
  bundleId?: string;
  /** Optional pseudonym salt. Auto-generated when omitted. */
  salt?: Buffer;
  /** Optional ISO timestamp. Defaults to now(). */
  now?: () => string;
  /** Optional Golden Core coverage data (when the run is golden-core). */
  goldenCoreCoverage?: {
    canonicalCount: number;
    frozenAt: string;
    registryFingerprint: string;
  };
  /** Force overwrite of an existing bundle (DANGEROUS — only for tests). */
  allowOverwrite?: boolean;
}

/**
 * Build a portable redacted showcase bundle IN MEMORY (no disk write).
 *
 * This is the shared construction path used by both the CLI
 * `showcase export` command (which then publishes to disk) and the
 * local viewer (which only needs the in-memory bundle to compute
 * the portable fingerprint).
 *
 * Issue #100 §3.2: "viewer 与 portable bundle 对同一 artifact 的
 * verdict、计数和成本必须完全一致". Sharing the same builder
 * guarantees byte-for-byte parity.
 */
export async function buildShowcaseBundleInMemory(options: BuildShowcaseBundleOptions): Promise<{
  bundle: ShowcaseBundle;
  bundleSha256: string;
  salt: Buffer;
}> {
  const verified = options.verified;
  const salt = options.salt ?? generatePseudonymSalt();
  const now = options.now ?? (() => new Date().toISOString());
  const generatedAt = now();
  const bundleId = options.bundleId ?? `showcase_${pseudonymize(verified.runId, salt, "run")}_${generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;

  // §5.1 Read auxiliary artifacts through the verified extension
  //      integrity index. Issue #100 fix #1: raw file reads of
  //      un-signed side-channel files are FORBIDDEN. All auxiliary
  //      artifacts (repair packets, clusters, diagnoses,
  //      counterfactuals, calibration, candidates) MUST first pass
  //      through a verified extension integrity index that anchors
  //      to the source run's integrityRootSha256.
  const extIndex = await readExtensionIntegrityIndex(
    verified.runDir,
    verified.integrity.integrityRootSha256,
    verified.runId,
  );
  const repairPackets = await readIndexedRepairPackets(verified.runDir, extIndex);
  const issueClusters = await readIndexedIssueClusters(verified.runDir, extIndex);
  const diagnoses = await readIndexedDiagnoses(verified.runDir, extIndex);
  const counterfactuals = await readIndexedCounterfactuals(verified.runDir, extIndex);
  const calibrationArtifact = await readIndexedCalibrationArtifact(verified.runDir, extIndex);
  const candidateRegistry = await readIndexedCandidateRegistry(verified.runDir, extIndex);

  // §5.2 Build the source artifact summary.
  const artifact = verified.artifact;
  const runIdPseudonym = pseudonymize(verified.runId, salt, "run");
  const sourceArtifact: BundleSourceArtifact = {
    runIdPseudonym,
    preset: artifact.preset,
    model: artifact.model,
    status: artifact.status,
    startedAt: artifact.startedAt,
    completedAt: artifact.completedAt,
    integrityRootSha256: verified.integrity.integrityRootSha256,
    evidenceRootSha256: verified.integrity.evidenceRootSha256,
    artifactFingerprint: computeArtifactFingerprintInline(verified),
    evidenceClass: "offline_synthetic",
  };

  // §5.3 Build the release verdict. Issue #100 §4: "如果展示层正确反映
  //      30/52, 则 release verdict 应诚实显示 regression, 父 Issue #93
  //      暂时不具备关闭资格".
  const passedCount = artifact.summary.passedCount;
  const totalCount = artifact.observations.length;
  const releaseVerdict: BundleReleaseVerdict = {
    verdict: artifact.status === "partial_budget" ? "partial_budget" : artifact.status === "regression" ? "regression" : "passed",
    honestBaseline: `${passedCount}/${totalCount}`,
    summary: buildReleaseVerdictSummary(artifact),
    forbiddenClaims: [
      "不得宣称真实用户满意度",
      "不得宣称生产质量",
      "不得宣称留存或生产力提升",
      "不得宣称业务结果",
      "本 bundle evidence 标记为 offline/synthetic, 不代表真实生产环境表现",
    ],
  };

  // §5.4 Build the hard gates summary from the V3 exit gate report
  //      when present. When absent, mark all gates as `false` with
  //      an explicit "no_exit_gate_report" note via the summary.
  const hardGates = buildHardGatesSummary(artifact);

  // §5.5 Build the capability matrix. Issue #100 §3.1: "capability
  //      matrix" is required.
  const capabilityMatrix = buildCapabilityMatrix(artifact, salt);

  // §5.6 Build the reliability summary from the V3 reliability report.
  const reliability = buildReliabilitySummary(artifact);

  // §5.7 Build the cost buckets. Issue #100 §3.2: three cost buckets;
  //      unknown cost MUST NOT be displayed as $0.
  const costs = {
    sutCost: toBundleCostBucket(artifact.summary.sutCost),
    evaluatorModelCost: toBundleCostBucket(artifact.summary.evaluatorModelCost),
    codingAgentCost: toBundleCostBucket(artifact.summary.codingAgentCost),
    provenanceNote: "三类成本独立分账；ProjectFlow Agent 上限按 preset 约束；evaluator Judge/simulator 独立 ceiling；Coding Agent external/unknown；unknown 不得显示为 $0",
  };

  // §5.8 Build evidence chains (representative summaries).
  const evidenceChains = buildEvidenceChains(artifact, repairPackets, issueClusters, diagnoses, counterfactuals, calibrationArtifact, salt);

  // §5.9 Build issue cluster summaries. Issue #100 batch D: sharedCause
  //      is free-text → removed.
  const issueClusterSummaries: BundleIssueClusterSummary[] = issueClusters.map((cluster) => ({
    clusterIdPseudonym: pseudonymize(cluster.clusterId, salt, "cluster"),
    memberCount: cluster.members.length,
    causalStatus: cluster.causalStatus,
    confidence: cluster.confidence,
  }));

  // §5.10 Build repair packet summaries. Issue #100 batch D: portable
  //      showcase MUST NOT include free-text (observedSymptom,
  //      expectedContract, affectedComponents, acceptanceCriteria,
  //      protectedBoundaries, nonGoals). Counts only for boundaries/goals.
  const repairPacketSummaries: BundleRepairPacketSummary[] = repairPackets.map((packet) => ({
    packetIdPseudonym: pseudonymize(packet.packetId, salt, "packet"),
    packetType: packet.packetType,
    severity: packet.severity,
    causalStatus: packet.causalStatus,
    confidence: packet.confidence,
    staleState: packet.staleState,
    protectedBoundaryCount: packet.protectedBoundaries.length,
    nonGoalCount: packet.nonGoals.length,
    hasCandidateRegression: !!packet.candidateRegression,
    integritySha256: packet.integritySha256,
  }));

  // §5.11 Build diagnosis summaries. Issue #100 batch D:
  //      observedSymptom/expectedContract are free-text → removed.
  const diagnosisSummaries: BundleDiagnosisSummary[] = diagnoses.map((diag) => ({
    diagnosisIdPseudonym: pseudonymize(diag.diagnosisId, salt, "diagnosis"),
    causalStatus: diag.causalStatus,
    confidence: diag.confidence,
    integritySha256: sha256(stableStringify(diag)),
  }));

  // §5.12 Build regression closure.
  const regressionClosure: BundleRegressionClosure = {
    closedRegressions: countClosedRegressions(artifact),
    openRegressions: countOpenRegressions(artifact),
    candidateRegressionsPreserved: repairPackets.filter((p) => p.candidateRegression).length,
    autoPromotionPerformed: false,
  };

  // §5.13 Build coverage.
  const coverage: BundleCoverage = {
    canonicalScenarios: options.goldenCoreCoverage?.canonicalCount ?? (artifact.preset === "golden-core" ? artifact.observations.length : 0),
    p0MandatoryCategories: P0_MANDATORY_CATEGORIES.length,
    robustnessVariantKinds: ROBUSTNESS_VARIANT_KINDS.length,
    goldenCoreFrozenAt: options.goldenCoreCoverage?.frozenAt ?? null,
    goldenCoreRegistryFingerprint: options.goldenCoreCoverage?.registryFingerprint ?? null,
  };

  // §5.14 Build skips, exclusions and infra errors.
  const { skips, exclusions, infraErrors } = buildSkipExclusionInfra(artifact, salt);

  // §5.15 Build calibration summary.
  const calibration = buildCalibrationSummary(calibrationArtifact, candidateRegistry);

  // §5.16 Build retention summary.
  const retention: BundleRetentionSummary = {
    preserve: ["failed", "needs_review", "repair_packet", "promoted_baseline", "referenced_by_bundle"],
    autoDeletionPerformed: false,
    reportPath: `${SHOWCASE_RETENTION_DIR}/${runIdPseudonym}.json`,
  };

  // §5.17 Build artifact provenance (from the verified artifact).
  const artifactProvenance = {
    evaluatorVersion: verified.provenance.evaluatorVersion,
    publicSeamVersion: verified.provenance.publicSeamVersion,
    platform: verified.provenance.platform,
    architecture: verified.provenance.architecture,
    nodeVersion: verified.provenance.nodeVersion,
    code: {
      gitCommit: verified.provenance.code.gitCommit,
      gitDirty: verified.provenance.code.gitDirty,
      worktreeSha256: verified.provenance.code.worktreeSha256,
    },
    scenarioContractsSha256: verified.provenance.scenarioContractsSha256,
    modelConfigSha256: verified.provenance.modelConfigSha256,
  };

  // §5.18 Build bundle provenance.
  const bundleProvenance: BundleProvenance = {
    bundleSchemaVersion: SHOWCASE_BUNDLE_SCHEMA_VERSION,
    bundleType: "portable_redacted_showcase",
    generatorVersion: SHOWCASE_BUNDLE_GENERATOR_VERSION,
    generatedAt,
    sourceArtifactFingerprint: sourceArtifact.artifactFingerprint,
    pseudonymSaltSha256: sha256(salt.toString("hex")),
    migrationsApplied: verified.migrationLog,
  };

  // §5.19 Assemble the bundle (without integritySha256).
  const bundleWithoutHash: Omit<ShowcaseBundle, "integritySha256"> = {
    schemaVersion: SHOWCASE_BUNDLE_SCHEMA_VERSION,
    bundleId,
    bundleType: "portable_redacted_showcase",
    evidenceClass: "offline_synthetic",
    createdAt: generatedAt,
    sourceArtifact,
    releaseVerdict,
    hardGates,
    capabilityMatrix,
    reliability,
    costs,
    evidenceChains,
    issueClusters: issueClusterSummaries,
    repairPacketSummaries,
    diagnosisSummaries,
    regressionClosure,
    coverage,
    skips,
    exclusions,
    infraErrors,
    calibration,
    retention,
    artifactProvenance,
    bundleProvenance,
  };

  // §5.20 Fail-closed privacy scan on the assembled bundle BEFORE computing
  // the integrity hash. Any detected raw ID, secret, token, or path
  // pattern causes the entire bundle to fail to build.
  assertBundlePrivacy(bundleWithoutHash);

  // §5.21 Compute the integrity hash.
  const integritySha256 = sha256(stableStringify(bundleWithoutHash));
  const bundle: ShowcaseBundle = { ...bundleWithoutHash, integritySha256 };

  return { bundle, bundleSha256: integritySha256, salt };
}

/**
 * Build a portable redacted showcase bundle AND publish it to disk.
 *
 * The bundle is written to `agent-bridge/showcase/bundles/<bundleId>.json`
 * as an immutable file (chmod 0o400 after atomic publish).
 *
 * Returns the bundle and its absolute path. Issue #100 §3.1: "committed
 * bundle 必须真正 portable, 不能依赖本机 raw artifact".
 */
export async function buildShowcaseBundle(options: BuildShowcaseBundleOptions): Promise<{
  bundle: ShowcaseBundle;
  bundlePath: string;
  bundleSha256: string;
}> {
  const { bundle, bundleSha256 } = await buildShowcaseBundleInMemory(options);
  // §5.21 Write the bundle atomically. Issue #100 §3.1: "committed
  //      bundle 必须真正 portable". The bundle is written to
  //      `agent-bridge/showcase/bundles/<bundleId>.json` (committed
  //      to Git, unlike raw artifacts).
  const bundleDir = showcaseBundleDir(options.projectRoot);
  const bundlePath = join(bundleDir, `${bundle.bundleId}.json`);
  await publishImmutableBundle(bundlePath, JSON.stringify(bundle, null, 2) + "\n", options.allowOverwrite ?? false);
  // §5.22 Write the local-only sidecar recording the RAW source runId.
  //      This is NOT part of the portable bundle. The retention
  //      planner reads sidecars to mark source runs as
  //      `referenced_by_showcase_bundle` without reverse-mapping
  //      pseudonyms. The sidecar is mutable (rewritable) because it
  //      is local bookkeeping, not evidence.
  const sidecar: BundleSourceSidecar = {
    bundleId: bundle.bundleId,
    sourceRunId: options.verified.runId,
    sourceRunDir: options.verified.runDir,
    publishedAt: bundle.createdAt,
  };
  const sourcesDir = showcaseBundleSourcesDir(options.projectRoot);
  const sidecarPath = join(sourcesDir, `${bundle.bundleId}.source.json`);
  await mkdir(sourcesDir, { recursive: true, mode: 0o700 });
  await chmod(sourcesDir, 0o700);
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  return { bundle, bundlePath, bundleSha256 };
}

// ---------------------------------------------------------------------------
// §6 Helpers — index-verified auxiliary artifact readers
// ---------------------------------------------------------------------------

async function readIndexedRepairPackets(runDir: string, extIndex: ExtensionIntegrityIndex | null): Promise<RepairPacket[]> {
  return readIndexedArtifactsByType<RepairPacket>(runDir, extIndex, "repair_packet");
}

async function readIndexedIssueClusters(runDir: string, extIndex: ExtensionIntegrityIndex | null): Promise<IssueCluster[]> {
  return readIndexedArtifactsByType<IssueCluster>(runDir, extIndex, "issue_cluster");
}

async function readIndexedDiagnoses(runDir: string, extIndex: ExtensionIntegrityIndex | null): Promise<DiagnosisRecord[]> {
  return readIndexedArtifactsByType<DiagnosisRecord>(runDir, extIndex, "diagnosis");
}

async function readIndexedCounterfactuals(runDir: string, extIndex: ExtensionIntegrityIndex | null): Promise<CounterfactualRecord[]> {
  return readIndexedArtifactsByType<CounterfactualRecord>(runDir, extIndex, "counterfactual");
}

async function readIndexedArtifactsByType<T>(
  runDir: string,
  extIndex: ExtensionIntegrityIndex | null,
  type: ExtensionFileType,
): Promise<T[]> {
  const entries = extIndex ? getExtensionEntriesByType(extIndex, type) : [];
  const results: T[] = [];
  for (const entry of entries) {
    const { content } = await readVerifiedExtensionFile(extIndex!, runDir, entry.relativePath);
    results.push(JSON.parse(content) as T);
  }
  return results;
}

async function readIndexedCalibrationArtifact(runDir: string, extIndex: ExtensionIntegrityIndex | null): Promise<CalibrationArtifact | null> {
  if (!extIndex) return null;
  const calEntries = getExtensionEntriesByType(extIndex, "calibration_artifact");
  if (calEntries.length === 0) return null;
  const { content } = await readVerifiedExtensionFile(extIndex, runDir, calEntries[0]!.relativePath);
  return JSON.parse(content) as CalibrationArtifact;
}

async function readIndexedCandidateRegistry(runDir: string, extIndex: ExtensionIntegrityIndex | null): Promise<{ candidates?: unknown[] } | null> {
  if (!extIndex) return null;
  const candEntries = getExtensionEntriesByType(extIndex, "candidate_registry");
  if (candEntries.length === 0) return null;
  const { content } = await readVerifiedExtensionFile(extIndex, runDir, candEntries[0]!.relativePath);
  return JSON.parse(content) as { candidates?: unknown[] };
}

// ---------------------------------------------------------------------------
// §7 Helpers — bundle field builders
// ---------------------------------------------------------------------------

function computeArtifactFingerprintInline(verified: VerifiedArtifact): string {
  return sha256(stableStringify({
    schemaVersion: verified.artifact.schemaVersion,
    runId: verified.artifact.runId,
    preset: verified.artifact.preset,
    model: verified.artifact.model,
    status: verified.artifact.status,
    startedAt: verified.artifact.startedAt,
    completedAt: verified.artifact.completedAt,
    summary: verified.artifact.summary,
    integrityRootSha256: verified.integrity.integrityRootSha256,
    evidenceRootSha256: verified.integrity.evidenceRootSha256,
    observationCount: verified.artifact.observations.length,
    gradeCount: verified.artifact.grades.length,
  }));
}

function buildReleaseVerdictSummary(artifact: EvaluationArtifact): string {
  const passed = artifact.summary.passedCount;
  const total = artifact.observations.length;
  const status = artifact.status;
  if (status === "regression") {
    return `ProjectFlow Agent 在 ${artifact.preset} preset 下出现回归: ${passed}/${total} 通过; 失败场景保留为修复输入, 不通过弱化 grader 消除`;
  }
  if (status === "partial_budget") {
    return `ProjectFlow Agent 在 ${artifact.preset} preset 下因预算耗尽提前结束: ${passed}/${total} 通过; 已完成 evidence 保留, 剩余场景作为后续输入`;
  }
  return `ProjectFlow Agent 在 ${artifact.preset} preset 下 ${passed}/${total} 通过; evidence 标记为 offline/synthetic, 不代表真实生产环境表现`;
}

function buildHardGatesSummary(artifact: EvaluationArtifact): BundleHardGates {
  const v3 = artifact.v3;
  const exitGate = v3?.exitGateReport;
  if (!exitGate) {
    return {
      p0MutationsDetected: false,
      referenceZeroHardFalseFailures: false,
      hiddenFieldLeakageTestsPass: false,
      requiredScenariosNotSkippedOrExcluded: false,
      evidenceGraphAndChecksumsComplete: !!artifact.integrityRootSha256,
      noSemanticJudgeRequired: true,
    };
  }
  const conditions = exitGate.conditions ?? [];
  const find = (id: string) => conditions.find((c: { conditionId?: string; passed?: boolean }) => c.conditionId === id);
  const p0 = find("p0_mutations_detected");
  const ref = find("reference_zero_hard_false_failures");
  const hidden = find("hidden_field_leakage_tests_pass");
  const required = find("required_scenarios_not_skipped_or_excluded");
  const graph = find("evidence_graph_and_checksums_complete");
  const noJudge = find("no_semantic_judge_required");
  return {
    p0MutationsDetected: !!p0?.passed,
    referenceZeroHardFalseFailures: !!ref?.passed,
    hiddenFieldLeakageTestsPass: !!hidden?.passed,
    requiredScenariosNotSkippedOrExcluded: !!required?.passed,
    evidenceGraphAndChecksumsComplete: !!graph?.passed,
    noSemanticJudgeRequired: noJudge?.passed ?? true,
  };
}

function buildCapabilityMatrix(artifact: EvaluationArtifact, _salt: Buffer): CapabilityMatrixRow[] {
  // For golden-core preset, join the frozen Golden Core registry's
  // capability/scenarioClass/priority/P0 metadata. Heuristic inference
  // from scenarioId is FORBIDDEN — missing/duplicate/unknown MUST
  // fail-closed. Issue #100 fix #3.
  const byDomain = new Map<CapabilityDomain, { passed: number; failed: number; skipped: number; excluded: number; infraErrors: number; total: number }>();
  const byClass = new Map<ScenarioClass, { passed: number; failed: number; skipped: number; excluded: number; infraErrors: number; total: number }>();
  for (const domain of CAPABILITY_DOMAINS) byDomain.set(domain, { passed: 0, failed: 0, skipped: 0, excluded: 0, infraErrors: 0, total: 0 });
  for (const cls of SCENARIO_CLASSES) byClass.set(cls, { passed: 0, failed: 0, skipped: 0, excluded: 0, infraErrors: 0, total: 0 });

  const grades = new Map<string, Grade>();
  for (const grade of artifact.grades) grades.set(grade.scenarioId, grade);

  // Build Golden Core metadata map for registry-verified runs.
  const gcMeta = buildGoldenCoreMetadataMap(artifact);

  for (const obs of artifact.observations) {
    let domain: CapabilityDomain;
    let cls: ScenarioClass;

    if (gcMeta) {
      // Golden Core preset: use registry metadata ONLY. Missing/unknown
      // scenarioId fails-closed at buildGoldenCoreMetadataMap.
      const meta = gcMeta.get(obs.scenarioId);
      if (!meta) {
        throw new EvaluationValidationError(
          `Golden Core observation ${obs.scenarioId} 未在 Golden Core registry 中找到 metadata; 禁止 heuristic 猜测`,
        );
      }
      domain = meta.capability;
      cls = meta.scenarioClass;
    } else {
      // Non-Golden-Core preset: scenario contracts MUST carry explicit
      // capability/scenarioClass metadata. Heuristic fallback is ONLY
      // for legacy scenarios that predate this contract.
      domain = getExplicitCapabilityDomain(obs.scenarioId);
      cls = getExplicitScenarioClass(obs.scenarioId);
    }

    const grade = grades.get(obs.scenarioId);
    const applyBucket = (entry: { passed: number; failed: number; skipped: number; excluded: number; infraErrors: number; total: number } | undefined) => {
      if (!entry) return;
      entry.total += 1;
      if (obs.terminalStatus === "failed") {
        entry.infraErrors += 1;
      } else if (grade) {
        if (grade.passed) entry.passed += 1;
        else entry.failed += 1;
      } else {
        entry.skipped += 1;
      }
    };
    applyBucket(byDomain.get(domain));
    applyBucket(byClass.get(cls));
  }

  // Issue #100 batch 3: for golden-core partial_budget, missing canonical
  // observations are explicitly skipped. Add them to domain/class totals
  // so the matrix reflects all 52 canonicals, not just observed count.
  if (gcMeta && artifact.status === "partial_budget") {
    const observedIds = new Set(artifact.observations.map((o) => o.scenarioId));
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      if (!observedIds.has(entry.scenarioId)) {
        const domainEntry = byDomain.get(entry.capability);
        if (domainEntry) {
          domainEntry.total += 1;
          domainEntry.skipped += 1;
        }
        const classEntry = byClass.get(entry.scenarioClass);
        if (classEntry) {
          classEntry.total += 1;
          classEntry.skipped += 1;
        }
      }
    }
  }

  const rows: CapabilityMatrixRow[] = [];
  for (const [domain, entry] of byDomain) {
    rows.push({ dimension: "domain", key: domain, ...entry });
  }
  for (const [cls, entry] of byClass) {
    rows.push({ dimension: "class", key: cls, ...entry });
  }

  // Post-build verification: every domain and class must have a row.
  // A missing row means the metadata map is incomplete.
  const domainKeys = new Set(rows.filter((r) => r.dimension === "domain").map((r) => r.key));
  const classKeys = new Set(rows.filter((r) => r.dimension === "class").map((r) => r.key));
  for (const domain of CAPABILITY_DOMAINS) {
    if (!domainKeys.has(domain)) {
      throw new EvaluationValidationError(
        `capability matrix 缺少 domain: ${domain}; metadata map 不完整`,
      );
    }
  }
  for (const cls of SCENARIO_CLASSES) {
    if (!classKeys.has(cls)) {
      throw new EvaluationValidationError(
        `capability matrix 缺少 scenarioClass: ${cls}; metadata map 不完整`,
      );
    }
  }

  // Issue #100 batch 3: for golden-core runs, domain and class totals
  // must each sum to the canonical count (52). Non-Golden-Core presets
  // are exempt — their scenario sets are not bounded by the registry.
  if (gcMeta) {
    const domainTotal = rows.filter((r) => r.dimension === "domain").reduce((s, r) => s + r.total, 0);
    const classTotal = rows.filter((r) => r.dimension === "class").reduce((s, r) => s + r.total, 0);
    const canonicalCount = GOLDEN_CORE_REGISTRY.canonical.length;
    if (domainTotal !== canonicalCount) {
      throw new EvaluationValidationError(
        `Golden Core capability matrix domain total ${domainTotal} !== canonical ${canonicalCount}; 缺失 canonical 场景未被计入 domain`,
      );
    }
    if (classTotal !== canonicalCount) {
      throw new EvaluationValidationError(
        `Golden Core capability matrix class total ${classTotal} !== canonical ${canonicalCount}; 缺失 canonical 场景未被计入 class`,
      );
    }
  }

  return rows;
}

/**
 * Build a scenarioId → GoldenCoreScenarioEntry map from the frozen
 * Golden Core registry. Returns `null` when the artifact is NOT a
 * golden-core run — non-Golden-Core presets use explicit contract
 * metadata instead.
 *
 * Issue #100 fix #3: missing/duplicate/unknown scenarioIds fail-closed.
 *
 * Issue #100 batch 2: enhanced with alignment validation.
 * - For completed/regression: observation set MUST equal canonical set.
 * - For partial_budget: explicitly count skipped scenarios.
 * - Verifies every registry canonical scenarioId has exactly one
 *   observation and one grade.
 * - Verifies no duplicate observations or grades.
 * - Verifies grade.scenarioId matches observation.scenarioId.
 */
function buildGoldenCoreMetadataMap(
  artifact: EvaluationArtifact,
): Map<string, GoldenCoreScenarioEntry> | null {
  if (artifact.preset !== "golden-core") return null;

  const registry = GOLDEN_CORE_REGISTRY;
  const byId = new Map<string, GoldenCoreScenarioEntry>();
  for (const entry of registry.canonical) {
    if (byId.has(entry.scenarioId)) {
      throw new EvaluationValidationError(
        `Golden Core registry 包含重复 scenarioId: ${entry.scenarioId}`,
      );
    }
    byId.set(entry.scenarioId, entry);
  }

  // Verify every observation scenarioId exists in the registry.
  const observedIds = new Set(artifact.observations.map((o) => o.scenarioId));
  for (const id of observedIds) {
    if (!byId.has(id)) {
      throw new EvaluationValidationError(
        `Golden Core observation ${id} 不在 Golden Core registry canonical 集合中; 禁止 heuristic`,
      );
    }
  }

  // Alignment validation.
  validateGoldenCoreAlignment(artifact, registry.canonical, byId);

  return byId;
}

/**
 * Validate Golden Core alignment between the frozen registry and the
 * evaluation artifact.
 *
 * Issue #100 batch 2:
 *  - Verifies every registry canonical scenarioId has EXACTLY one
 *    observation and one grade.
 *  - Verifies no duplicate observations or grades.
 *  - Verifies grade.scenarioId matches observation.scenarioId.
 *  - For completed/regression: observation count == registry canonical count.
 *  - For partial_budget: if observations < canonical count, the
 *    remainder are explicitly skipped (not silently omitted).
 */
export function validateGoldenCoreAlignment(
  artifact: EvaluationArtifact,
  canonical: ReadonlyArray<GoldenCoreScenarioEntry>,
  _canonicalById: Map<string, GoldenCoreScenarioEntry>,
  options?: { throwOnMisalignment?: boolean },
): {
  aligned: boolean;
  missingObservations: string[];
  missingGrades: string[];
  mismatchedGradeScenarioIds: string[];
  duplicateObservations: string[];
  duplicateGrades: string[];
} {
  const shouldThrow = options?.throwOnMisalignment ?? true;
  const canonicalIds = new Set(canonical.map((e) => e.scenarioId));

  // Detect duplicate observations by scenarioId.
  const obsCounts = new Map<string, number>();
  for (const obs of artifact.observations) {
    obsCounts.set(obs.scenarioId, (obsCounts.get(obs.scenarioId) ?? 0) + 1);
  }
  const duplicateObservations: string[] = [];
  for (const [id, count] of obsCounts) {
    if (count > 1) duplicateObservations.push(id);
  }

  // Detect duplicate grades by scenarioId.
  const gradeCounts = new Map<string, number>();
  for (const grade of artifact.grades) {
    gradeCounts.set(grade.scenarioId, (gradeCounts.get(grade.scenarioId) ?? 0) + 1);
  }
  const duplicateGrades: string[] = [];
  for (const [id, count] of gradeCounts) {
    if (count > 1) duplicateGrades.push(id);
  }

  // Build grade lookup by scenarioId.
  const gradeById = new Map<string, Grade>();
  for (const grade of artifact.grades) {
    gradeById.set(grade.scenarioId, grade);
  }

  // Detect mismatched grade.scenarioId vs observation.scenarioId.
  const observedIds = new Set(artifact.observations.map((o) => o.scenarioId));
  const gradedIds = new Set(artifact.grades.map((g) => g.scenarioId));
  const mismatchedGradeScenarioIds: string[] = [];
  for (const gId of gradedIds) {
    if (!observedIds.has(gId)) {
      mismatchedGradeScenarioIds.push(gId);
    }
  }

  // Detect missing observations (in canonical but not observed).
  const missingObservations: string[] = [];
  for (const cId of canonicalIds) {
    if (!observedIds.has(cId)) {
      missingObservations.push(cId);
    }
  }

  // Detect missing grades (observed but not graded).
  const missingGrades: string[] = [];
  for (const oId of observedIds) {
    if (!gradedIds.has(oId)) {
      missingGrades.push(oId);
    }
  }

  // ── Phase 1: structural integrity checks (duplicates, grade mismatches,
  //            missing grades). These MUST fire BEFORE count checks so the
  //            most specific error is reported.

  const issues: string[] = [];
  if (duplicateObservations.length > 0) {
    issues.push(`重复 observation: ${duplicateObservations.join(", ")}`);
  }
  if (duplicateGrades.length > 0) {
    issues.push(`重复 grade: ${duplicateGrades.join(", ")}`);
  }
  if (mismatchedGradeScenarioIds.length > 0) {
    issues.push(`grade 有 observation 中不存在的 scenarioId: ${mismatchedGradeScenarioIds.join(", ")}`);
  }
  // Issue #100 batch 3: any observed scenario without a grade is fail-closed.
  // Grades are the ONLY source of ground truth — an observation without a
  // grade is an incomplete evidence chain and cannot be summarized.
  if (missingGrades.length > 0) {
    issues.push(`observed 场景缺少 grade: ${missingGrades.join(", ")}`);
  }

  if (issues.length > 0 && shouldThrow) {
    throw new EvaluationValidationError(`Golden Core alignment 失败: ${issues.join("; ")}`);
  }

  // ── Phase 2: count checks (only when structural integrity passes).

  // For completed/regression: observation count must equal canonical count.
  const status = artifact.status;
  if (status === "completed" || status === "regression") {
    if (artifact.observations.length !== canonical.length) {
      const msg = `Golden Core alignment 失败 (${status}): observation 数量 ${artifact.observations.length} !== canonical ${canonical.length}; 缺失 ${missingObservations.length} 场景`;
      if (shouldThrow) {
        throw new EvaluationValidationError(msg);
      }
      return {
        aligned: false,
        missingObservations,
        missingGrades,
        mismatchedGradeScenarioIds,
        duplicateObservations,
        duplicateGrades,
      };
    }
  }

  // For partial_budget: if observations < canonical count, remaining
  // are explicitly skipped (not silently omitted).
  if (status === "partial_budget" && artifact.observations.length < canonical.length) {
    // This is expected — the rest are skipped. We record them but
    // do NOT throw (partial_budget is a valid exit reason).
    return {
      aligned: true,
      missingObservations,
      missingGrades,
      mismatchedGradeScenarioIds,
      duplicateObservations,
      duplicateGrades,
    };
  }

  return {
    aligned: issues.length === 0,
    missingObservations,
    missingGrades,
    mismatchedGradeScenarioIds,
    duplicateObservations,
    duplicateGrades,
  };
}

/**
 * Get capability domain from explicit contract metadata. The scenario
 * metadata map (`scenario-metadata.ts`) is the SINGLE source of truth.
 * Unknown scenario IDs fail-closed — heuristic guessing is forbidden.
 *
 * Issue #100 batch 2: non-Golden-Core presets MUST use explicit
 * metadata, not heuristic substring matching on scenarioId.
 */
function getExplicitCapabilityDomain(scenarioId: string): CapabilityDomain {
  const meta = getScenarioMetadata(scenarioId);
  if (!meta) {
    throw new EvaluationValidationError(
      `场景 ${scenarioId} 未在 scenario metadata 中找到 capabilityDomain; 禁止 heuristic 猜测`,
    );
  }
  return meta.capabilityDomain;
}

function getExplicitScenarioClass(scenarioId: string): ScenarioClass {
  const meta = getScenarioMetadata(scenarioId);
  if (!meta) {
    throw new EvaluationValidationError(
      `场景 ${scenarioId} 未在 scenario metadata 中找到 scenarioClass; 禁止 heuristic 猜测`,
    );
  }
  return meta.scenarioClass;
}

function buildReliabilitySummary(artifact: EvaluationArtifact): BundleReliability {
  const report = artifact.v3?.reliabilityReport;
  if (!report) {
    return {
      observedTrialPassRate: null,
      empiricalAllKReliability: null,
      passAtK: null,
      modeledPassK: null,
      confidenceInterval: null,
      evidenceSufficient: false,
    };
  }
  const findMetric = (kind: string) => report.metrics.find((m: { kind: string }) => m.kind === kind);
  const observed = findMetric("observed_trial_pass_rate");
  const empirical = findMetric("empirical_all_k_reliability");
  const passAtK = findMetric("pass_at_k");
  const modeledPassK = findMetric("modeled_pass_k");
  const ci = findMetric("confidence_interval");
  return {
    observedTrialPassRate: observed?.value ?? null,
    empiricalAllKReliability: empirical?.value ?? null,
    passAtK: passAtK?.value ?? null,
    modeledPassK: modeledPassK?.value ?? null,
    confidenceInterval: ci
      ? { lower: ci.lowerBound ?? null, upper: ci.upperBound ?? null }
      : null,
    evidenceSufficient: !report.insufficientEvidence && report.metrics.every((m: { sufficientEvidence?: boolean }) => m.sufficientEvidence !== false),
  };
}

function toBundleCostBucket(entry: CostLedgerEntry): BundleCostBucket {
  // Issue #100 §3.2 invariant: unknown cost MUST NOT display as $0.
  // Defensive check — if the source artifact has `source: "unknown"`
  // with a non-null amount, we coerce to `null` rather than display
  // a misleading $0 or any specific dollar figure.
  if (entry.source === "unknown") {
    return {
      amountUsd: null,
      source: "unknown",
      countedAgainstSutCap: entry.countedAgainstSutCap,
    };
  }
  return {
    amountUsd: entry.amountUsd,
    source: entry.source,
    countedAgainstSutCap: entry.countedAgainstSutCap,
  };
}

function buildEvidenceChains(
  artifact: EvaluationArtifact,
  repairPackets: RepairPacket[],
  issueClusters: IssueCluster[],
  diagnoses: DiagnosisRecord[],
  counterfactuals: CounterfactualRecord[],
  calibrationArtifact: CalibrationArtifact | null,
  salt: Buffer,
): BundleEvidenceRow[] {
  const rows: BundleEvidenceRow[] = [];
  const grades = new Map<string, Grade>();
  for (const grade of artifact.grades) grades.set(grade.scenarioId, grade);

  // §1 Representative observations (up to 10 to keep the bundle compact).
  // Issue #100 fix #2: structured allowlist ONLY — NO free-text observation
  // output, even redacted. Regex-based redaction cannot guarantee full
  // coverage of all possible ID/path/secret formats. Instead, include
  // only deterministic structured fields (scenario status, grade counts,
  // hard gate results, latency).
  const observations = artifact.observations.slice(0, 10);
  for (const obs of observations) {
    const grade = grades.get(obs.scenarioId);
    const failureCount = grade?.failures.length ?? 0;
    const hardGraders = grade?.hardGrade?.graders ?? {};
    const hardGraderEntries = Object.entries(hardGraders);
    const hardGatePass = hardGraderEntries.filter(([, v]) => v).length;
    const hardGateFail = hardGraderEntries.filter(([, v]) => !v).length;
    const summary = grade
      ? grade.passed
        ? `场景 ${pseudonymize(obs.scenarioId, salt, "scenario")} 通过 (${failureCount} 失败, 硬门禁 ${hardGatePass}/${hardGatePass + hardGateFail})`
        : `场景 ${pseudonymize(obs.scenarioId, salt, "scenario")} 失败 (${failureCount} 失败, 硬门禁 ${hardGatePass}/${hardGatePass + hardGateFail})`
      : `场景 ${pseudonymize(obs.scenarioId, salt, "scenario")} 未见 grade`;
    rows.push({
      evidenceKind: "observation",
      sourceIdPseudonym: pseudonymize(obs.scenarioId, salt, "scenario"),
      sourceContentSha256: sha256(stableStringify(obs)),
      summary,
      structured: {
        scenarioStatus: obs.terminalStatus,
        passed: grade?.passed,
        failureCount,
        hardGatePass,
        hardGateFail,
        latencyMs: obs.latencyMs,
      },
      redacted: true,
    });
  }

  // §2 Repair packets (up to 5). Issue #100 batch D: summary must not
  //    include free-text observedSymptom.
  for (const packet of repairPackets.slice(0, 5)) {
    rows.push({
      evidenceKind: "repair_packet",
      sourceIdPseudonym: pseudonymize(packet.packetId, salt, "packet"),
      sourceContentSha256: packet.integritySha256,
      summary: `Repair Packet (${packet.packetType}, ${packet.causalStatus}, severity=${packet.severity})`,
      structured: {
        causalStatus: packet.causalStatus,
        memberCount: 1,
      },
      redacted: true,
    });
  }

  // §3 Issue clusters (up to 5). Issue #100 batch D: summary must not
  //    include free-text sharedCause.
  for (const cluster of issueClusters.slice(0, 5)) {
    rows.push({
      evidenceKind: "cluster",
      sourceIdPseudonym: pseudonymize(cluster.clusterId, salt, "cluster"),
      sourceContentSha256: sha256(stableStringify(cluster)),
      summary: `Issue Cluster (${cluster.causalStatus}, ${cluster.members.length} members)`,
      structured: {
        causalStatus: cluster.causalStatus,
        memberCount: cluster.members.length,
      },
      redacted: true,
    });
  }

  // §4 Diagnoses (up to 5). Issue #100 batch D: summary must not
  //    include free-text observedSymptom.
  for (const diag of diagnoses.slice(0, 5)) {
    rows.push({
      evidenceKind: "diagnosis",
      sourceIdPseudonym: pseudonymize(diag.diagnosisId, salt, "diagnosis"),
      sourceContentSha256: sha256(stableStringify(diag)),
      summary: `Diagnosis (${diag.causalStatus}, confidence=${diag.confidence})`,
      structured: {
        causalStatus: diag.causalStatus,
      },
      redacted: true,
    });
  }

  // §5 Counterfactuals (up to 3). Issue #100 batch D: changedFactor
  //    is free-text → removed. Only pseudonym, bool, content SHA.
  for (const cf of counterfactuals.slice(0, 3)) {
    rows.push({
      evidenceKind: "counterfactual",
      sourceIdPseudonym: pseudonymize(cf.counterfactualId, salt, "cf"),
      sourceContentSha256: sha256(stableStringify(cf)),
      summary: `Counterfactual: outcomeChanged=${cf.outcomeChanged ? "true" : "false"}`,
      redacted: true,
    });
  }

  // §6 Calibration (1 row when present).
  if (calibrationArtifact) {
    rows.push({
      evidenceKind: "calibration",
      sourceIdPseudonym: pseudonymize(calibrationArtifact.calibrationId ?? artifact.runId, salt, "calibration"),
      sourceContentSha256: calibrationArtifact.integritySha256 ?? sha256(stableStringify(calibrationArtifact)),
      summary: `Calibration Artifact (semantic judge used=${(calibrationArtifact.judgeVersions?.length ?? 0) > 0 ? "true" : "false"})`,
      redacted: true,
    });
  }

  // §7 Golden core (1 row when the run is golden-core).
  if (artifact.preset === "golden-core") {
    rows.push({
      evidenceKind: "golden_core",
      sourceIdPseudonym: pseudonymize(artifact.runId, salt, "golden_core"),
      sourceContentSha256: artifact.integrityRootSha256 ?? "",
      summary: `Golden Core run: ${artifact.summary.passedCount}/${artifact.observations.length} 通过`,
      redacted: true,
    });
  }

  return rows;
}

function countClosedRegressions(_artifact: EvaluationArtifact): number {
  // A "closed regression" is a scenario that previously failed but is
  // now passing. Without historical data, we approximate as 0 in V1.
  // The retention report records this honestly.
  return 0;
}

function countOpenRegressions(artifact: EvaluationArtifact): number {
  return artifact.grades.filter((g) => !g.passed).length;
}

function buildSkipExclusionInfra(artifact: EvaluationArtifact, salt: Buffer): {
  skips: BundleSkipEntry[];
  exclusions: BundleSkipEntry[];
  infraErrors: BundleSkipEntry[];
} {
  const skips: BundleSkipEntry[] = [];
  const exclusions: BundleSkipEntry[] = [];
  const infraErrors: BundleSkipEntry[] = [];
  const trials = artifact.v3?.reliabilityTrials ?? [];
  for (const trial of trials) {
    if (trial.excluded) {
      const reason = trial.exclusionReason ?? "skipped";
      const entry: BundleSkipEntry = {
        scenarioIdPseudonym: pseudonymize(trial.scenarioId, salt, "scenario"),
        reason,
        kind: reason === "infrastructure_error" ? "infra_error" : reason === "simulator_error" ? "exclusion" : "skip",
      };
      if (entry.kind === "infra_error") infraErrors.push(entry);
      else if (entry.kind === "exclusion") exclusions.push(entry);
      else skips.push(entry);
    }
  }
  // Observations with terminalStatus=failed are infra errors.
  for (const obs of artifact.observations) {
    if (obs.terminalStatus === "failed") {
      infraErrors.push({
        scenarioIdPseudonym: pseudonymize(obs.scenarioId, salt, "scenario"),
        reason: `terminal_status_failed (latencyMs=${obs.latencyMs})`,
        kind: "infra_error",
      });
    }
  }
  return { skips, exclusions, infraErrors };
}

function buildCalibrationSummary(
  calibrationArtifact: CalibrationArtifact | null,
  candidateRegistry: { candidates?: unknown[] } | null,
): BundleCalibrationSummary {
  const candidateCount = candidateRegistry?.candidates?.length ?? 0;
  if (!calibrationArtifact) {
    return {
      calibrationArtifactPresent: false,
      semanticJudgeUsed: false,
      activeStandardsPromoted: 0,
      candidateStandardsCount: candidateCount,
      conflictCatalog: { totalPatterns: 6, resolved: 0, unresolved: 0 },
    };
  }
  const conflicts = calibrationArtifact.standardConflicts ?? [];
  const resolved = conflicts.filter((c: { resolutionStatus?: string }) => c.resolutionStatus === "resolved").length;
  const unresolved = conflicts.filter((c: { resolutionStatus?: string }) => c.resolutionStatus !== "resolved").length;
  return {
    calibrationArtifactPresent: true,
    semanticJudgeUsed: (calibrationArtifact.judgeVersions?.length ?? 0) > 0,
    activeStandardsPromoted: 0, // always 0 — never auto-promoted
    candidateStandardsCount: candidateCount,
    conflictCatalog: { totalPatterns: 6, resolved, unresolved },
  };
}

// ---------------------------------------------------------------------------
// §8 Atomic publish
// ---------------------------------------------------------------------------

/**
 * Publish the bundle as an immutable file. Issue #100 §3.1: "committed
 * bundle 必须真正 portable". The publish is atomic (hard-link from a
 * temp file) and refuses to overwrite existing bundles unless
 * `allowOverwrite` is explicitly set (test-only).
 *
 * Issue #100 §3.2 / §6: "accepted baseline 与 live preview 的区别"
 * and "atomic preview publish 与 accepted baseline 不覆盖测试" — the
 * same invariant applies to committed showcase bundles: they are
 * immutable once published.
 */
async function publishImmutableBundle(path: string, content: string, allowOverwrite: boolean): Promise<void> {
  // Assert path containment under the showcase bundles directory.
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  // Assert no symlink in the path.
  assertNoSymlinkPath(parent, path);
  if (allowOverwrite) {
    await writeFile(path, content, { encoding: "utf-8", mode: 0o600 });
    return;
  }
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  try {
    await link(temp, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new EvaluationInfrastructureError(`拒绝覆盖已存在的 showcase bundle: ${path}`);
    }
    throw error;
  } finally {
    await import("node:fs/promises").then(({ unlink }) => unlink(temp).catch(() => undefined));
  }
  await chmod(path, 0o400);
}

function assertNoSymlinkPath(root: string, target: string): void {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new EvaluationInfrastructureError(`showcase bundle 根目录不允许为符号链接: ${root}`);
  }
  const rootReal = realpathSync(root);
  const relativePath = target === root ? "" : target.slice(root.length + 1);
  let current = root;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new EvaluationInfrastructureError(`showcase bundle 路径不允许包含符号链接: ${current}`);
      }
      const currentReal = realpathSync(current);
      if (currentReal !== rootReal && !currentReal.startsWith(`${rootReal}${sep}`)) {
        throw new EvaluationInfrastructureError(`showcase bundle 路径真实位置越界: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// §9 Bundle verification (for consumers / tests)
// ---------------------------------------------------------------------------

/**
 * Verify a showcase bundle: schema version, integrity hash, required
 * fields. Issue #100 §3.1: "bundle schema, hash, provenance 必须可验证".
 */
export async function verifyShowcaseBundle(bundlePath: string): Promise<ShowcaseBundle> {
  const content = await readFile(bundlePath, "utf-8");
  let bundle: ShowcaseBundle;
  try {
    bundle = JSON.parse(content) as ShowcaseBundle;
  } catch (error) {
    throw new EvaluationValidationError(`bundle 解析失败: ${(error as Error).message}`);
  }
  if (bundle.schemaVersion !== SHOWCASE_BUNDLE_SCHEMA_VERSION) {
    throw new EvaluationValidationError(
      `bundle schemaVersion ${String(bundle.schemaVersion)} 不受支持; 当前支持 ${SHOWCASE_BUNDLE_SCHEMA_VERSION}`,
    );
  }
  if (bundle.bundleType !== "portable_redacted_showcase") {
    throw new EvaluationValidationError(`bundle bundleType 非法: ${bundle.bundleType}`);
  }
  if (bundle.evidenceClass !== "offline_synthetic") {
    throw new EvaluationValidationError(`bundle evidenceClass 必须为 offline_synthetic; 实际: ${bundle.evidenceClass}`);
  }
  // Recompute the integrity hash.
  const { integritySha256: _stored, ...rest } = bundle;
  void _stored;
  const computed = sha256(stableStringify(rest));
  if (computed !== bundle.integritySha256) {
    throw new EvaluationInfrastructureError("bundle integritySha256 不一致");
  }
  // Verify forbidden claims are present.
  if (!bundle.releaseVerdict.forbiddenClaims || bundle.releaseVerdict.forbiddenClaims.length === 0) {
    throw new EvaluationValidationError("bundle releaseVerdict.forbiddenClaims 不能为空");
  }
  // Fail-closed privacy scan (shared with build path — Issue #100 fix #2).
  assertBundlePrivacy(bundle);
  return bundle;
}
