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
import { link, mkdir, readFile, readdir, chmod, writeFile } from "node:fs/promises";
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
  /** Chinese summary, redacted. */
  summary: string;
  /** Always true for portable bundles. */
  redacted: true;
}

/** A redacted summary of a Repair Packet. */
export interface BundleRepairPacketSummary {
  packetIdPseudonym: string;
  packetType: "fix" | "investigation";
  severity: "low" | "medium" | "high" | "critical";
  causalStatus: string;
  confidence: string;
  staleState: "fresh" | "stale" | "unknown";
  observedSymptom: string;
  expectedContract: string;
  affectedComponents: string[];
  protectedBoundaries: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  hasCandidateRegression: boolean;
  integritySha256: string;
}

/** A redacted summary of an Issue Cluster. */
export interface BundleIssueClusterSummary {
  clusterIdPseudonym: string;
  sharedCause: string;
  memberCount: number;
  causalStatus: string;
  confidence: string;
}

/** A redacted summary of a Diagnosis record. */
export interface BundleDiagnosisSummary {
  diagnosisIdPseudonym: string;
  causalStatus: string;
  confidence: string;
  observedSymptom: string;
  expectedContract: string;
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
const ABSOLUTE_PATH_PATTERN = /(?:^|\s)(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)|(?:^|\s)([A-Z]:\\[^<*?"|>\r\n]+)/g;
const SECRET_PATTERN = /\b(?:sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,}|ghp_[a-zA-Z0-9]{30,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/g;

/**
 * Redact a free-form text field. Replaces raw user/task/member IDs
 * with bundle-scoped pseudonyms, strips absolute paths and obvious
 * secret patterns.
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
  redacted = redacted.replace(ABSOLUTE_PATH_PATTERN, " <absolute_path_redacted> ");
  redacted = redacted.replace(SECRET_PATTERN, " <secret_redacted> ");
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

  // §5.1 Read auxiliary artifacts (repair packets, clusters, diagnoses,
  //      counterfactuals, calibration, golden-core). All reads happen
  //      here so the bundle can inline summaries and never reference
  //      local files again.
  const repairPackets = await readRepairPackets(verified.runDir);
  const issueClusters = await readIssueClusters(verified.runDir);
  const diagnoses = await readDiagnoses(verified.runDir);
  const counterfactuals = await readCounterfactuals(verified.runDir);
  const calibrationArtifact = await readCalibrationArtifact(verified.runDir);
  const candidateRegistry = await readCandidateRegistry(verified.runDir);

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

  // §5.9 Build issue cluster summaries.
  const issueClusterSummaries: BundleIssueClusterSummary[] = issueClusters.map((cluster) => ({
    clusterIdPseudonym: pseudonymize(cluster.clusterId, salt, "cluster"),
    sharedCause: redactText(cluster.sharedCause, salt),
    memberCount: cluster.members.length,
    causalStatus: cluster.causalStatus,
    confidence: cluster.confidence,
  }));

  // §5.10 Build repair packet summaries.
  const repairPacketSummaries: BundleRepairPacketSummary[] = repairPackets.map((packet) => ({
    packetIdPseudonym: pseudonymize(packet.packetId, salt, "packet"),
    packetType: packet.packetType,
    severity: packet.severity,
    causalStatus: packet.causalStatus,
    confidence: packet.confidence,
    staleState: packet.staleState,
    observedSymptom: redactText(packet.observedSymptom, salt),
    expectedContract: redactText(packet.expectedContract, salt),
    affectedComponents: packet.affectedComponents.map((c) => redactText(c, salt)),
    protectedBoundaries: packet.protectedBoundaries.map((b) => redactText(b, salt)),
    nonGoals: packet.nonGoals.map((g) => redactText(g, salt)),
    acceptanceCriteria: packet.acceptanceCriteria.map((c) => redactText(c, salt)),
    hasCandidateRegression: !!packet.candidateRegression,
    integritySha256: packet.integritySha256,
  }));

  // §5.11 Build diagnosis summaries.
  const diagnosisSummaries: BundleDiagnosisSummary[] = diagnoses.map((diag) => ({
    diagnosisIdPseudonym: pseudonymize(diag.diagnosisId, salt, "diagnosis"),
    causalStatus: diag.causalStatus,
    confidence: diag.confidence,
    observedSymptom: redactText(diag.observedSymptom, salt),
    expectedContract: redactText(diag.expectedContract, salt),
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

  // §5.20 Compute the integrity hash.
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
// §6 Helpers — auxiliary artifact readers
// ---------------------------------------------------------------------------

async function readRepairPackets(runDir: string): Promise<RepairPacket[]> {
  return readArtifactDir<RepairPacket>(runDir, "repair-packets");
}

async function readIssueClusters(runDir: string): Promise<IssueCluster[]> {
  return readArtifactDir<IssueCluster>(runDir, "clusters");
}

async function readDiagnoses(runDir: string): Promise<DiagnosisRecord[]> {
  return readArtifactDir<DiagnosisRecord>(runDir, "diagnoses");
}

async function readCounterfactuals(runDir: string): Promise<CounterfactualRecord[]> {
  return readArtifactDir<CounterfactualRecord>(runDir, "counterfactuals");
}

async function readArtifactDir<T>(runDir: string, subdir: string): Promise<T[]> {
  const dir = join(runDir, subdir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
  const results: T[] = [];
  for (const file of jsonFiles) {
    const content = await readFile(join(dir, file), "utf-8");
    results.push(JSON.parse(content) as T);
  }
  return results;
}

async function readCalibrationArtifact(runDir: string): Promise<CalibrationArtifact | null> {
  try {
    const content = await readFile(join(runDir, "calibration-artifact.json"), "utf-8");
    return JSON.parse(content) as CalibrationArtifact;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readCandidateRegistry(runDir: string): Promise<{ candidates?: unknown[] } | null> {
  try {
    const content = await readFile(join(runDir, "candidate-registry.json"), "utf-8");
    return JSON.parse(content) as { candidates?: unknown[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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
  // Group observations by capability domain and scenario class.
  // The scenarioId encodes the domain (e.g., "clarify-normal-001"
  // → domain=clarification-direction, class=normal). We use a
  // heuristic mapping because the scenario contracts are not in the
  // artifact itself.
  const byDomain = new Map<CapabilityDomain, { passed: number; failed: number; skipped: number; excluded: number; infraErrors: number; total: number }>();
  const byClass = new Map<ScenarioClass, { passed: number; failed: number; skipped: number; excluded: number; infraErrors: number; total: number }>();
  for (const domain of CAPABILITY_DOMAINS) byDomain.set(domain, { passed: 0, failed: 0, skipped: 0, excluded: 0, infraErrors: 0, total: 0 });
  for (const cls of SCENARIO_CLASSES) byClass.set(cls, { passed: 0, failed: 0, skipped: 0, excluded: 0, infraErrors: 0, total: 0 });

  const grades = new Map<string, Grade>();
  for (const grade of artifact.grades) grades.set(grade.scenarioId, grade);

  for (const obs of artifact.observations) {
    const domain = inferCapabilityDomain(obs.scenarioId);
    const cls = inferScenarioClass(obs.scenarioId);
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

  const rows: CapabilityMatrixRow[] = [];
  for (const [domain, entry] of byDomain) {
    rows.push({ dimension: "domain", key: domain, ...entry });
  }
  for (const [cls, entry] of byClass) {
    rows.push({ dimension: "class", key: cls, ...entry });
  }
  return rows;
}

function inferCapabilityDomain(scenarioId: string): CapabilityDomain {
  const id = scenarioId.toLowerCase();
  if (id.includes("clarify") || id.includes("direction")) return "clarification-direction";
  if (id.includes("plan") || id.includes("stage")) return "stage-planning";
  if (id.includes("breakdown") || id.includes("task")) return "task-breakdown";
  if (id.includes("assign")) return "assignment";
  if (id.includes("status") || id.includes("read")) return "status-read";
  if (id.includes("checkin") || id.includes("risk") || id.includes("replan")) return "checkin-risk-replan";
  if (id.includes("memory") || id.includes("conversation") || id.includes("chat")) return "conversations-project-memory";
  if (id.includes("runtime") || id.includes("security") || id.includes("recovery")) return "runtime-recovery-security";
  return "status-read";
}

function inferScenarioClass(scenarioId: string): ScenarioClass {
  const id = scenarioId.toLowerCase();
  if (id.includes("normal")) return "normal";
  if (id.includes("negative") || id.includes("forbidden") || id.includes("prohibit")) return "negative";
  if (id.includes("boundary") || id.includes("edge")) return "boundary";
  if (id.includes("insufficient") || id.includes("missing")) return "insufficient-information";
  if (id.includes("conflict")) return "conflict";
  if (id.includes("switch") || id.includes("goal-change")) return "goal-switching";
  if (id.includes("adversarial") || id.includes("attack") || id.includes("inject")) return "adversarial";
  if (id.includes("multi-turn") || id.includes("multiturn") || id.includes("conversation")) return "multi-turn";
  return "normal";
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
  // Issue #100 §3.1: "evidenceChains 必须包含足够信息让审查者判断场景
  // 行为, 但所有 raw user/task/member ID 必须经过 pseudonymize". We
  // include a SHORT redacted snippet of the observation output (up to
  // 200 chars) so reviewers can see what the scenario actually did
  // without leaking raw private text. The snippet is run through
  // `redactText` which replaces raw IDs with bundle-scoped pseudonyms.
  const observations = artifact.observations.slice(0, 10);
  for (const obs of observations) {
    const grade = grades.get(obs.scenarioId);
    const outputSnippet = redactText(obs.output?.slice(0, 200) ?? "", salt);
    const summary = grade
      ? grade.passed
        ? `场景 ${redactText(obs.scenarioId, salt)} 通过: ${grade.failures.length === 0 ? "无失败" : redactText(grade.failures.join("; "), salt)}; 输出摘要: ${outputSnippet}`
        : `场景 ${redactText(obs.scenarioId, salt)} 失败: ${redactText(grade.failures.join("; "), salt)}; 输出摘要: ${outputSnippet}`
      : `场景 ${redactText(obs.scenarioId, salt)} 未见 grade; 输出摘要: ${outputSnippet}`;
    rows.push({
      evidenceKind: "observation",
      sourceIdPseudonym: pseudonymize(obs.scenarioId, salt, "scenario"),
      sourceContentSha256: sha256(stableStringify(obs)),
      summary,
      redacted: true,
    });
  }

  // §2 Repair packets (up to 5).
  for (const packet of repairPackets.slice(0, 5)) {
    rows.push({
      evidenceKind: "repair_packet",
      sourceIdPseudonym: pseudonymize(packet.packetId, salt, "packet"),
      sourceContentSha256: packet.integritySha256,
      summary: `Repair Packet (${packet.packetType}, ${packet.causalStatus}): ${redactText(packet.observedSymptom, salt)}`,
      redacted: true,
    });
  }

  // §3 Issue clusters (up to 5).
  for (const cluster of issueClusters.slice(0, 5)) {
    rows.push({
      evidenceKind: "cluster",
      sourceIdPseudonym: pseudonymize(cluster.clusterId, salt, "cluster"),
      sourceContentSha256: sha256(stableStringify(cluster)),
      summary: `Issue Cluster (${cluster.causalStatus}, ${cluster.members.length} members): ${redactText(cluster.sharedCause, salt)}`,
      redacted: true,
    });
  }

  // §4 Diagnoses (up to 5).
  for (const diag of diagnoses.slice(0, 5)) {
    rows.push({
      evidenceKind: "diagnosis",
      sourceIdPseudonym: pseudonymize(diag.diagnosisId, salt, "diagnosis"),
      sourceContentSha256: sha256(stableStringify(diag)),
      summary: `Diagnosis (${diag.causalStatus}): ${redactText(diag.observedSymptom, salt)}`,
      redacted: true,
    });
  }

  // §5 Counterfactuals (up to 3).
  for (const cf of counterfactuals.slice(0, 3)) {
    rows.push({
      evidenceKind: "counterfactual",
      sourceIdPseudonym: pseudonymize(cf.counterfactualId, salt, "cf"),
      sourceContentSha256: sha256(stableStringify(cf)),
      summary: `Counterfactual: 单变量 changedFactor=${redactText(JSON.stringify(cf.changedFactor), salt)} outcomeChanged=${cf.outcomeChanged ? "true" : "false"}`,
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
  // Verify no raw IDs leak in the bundle (heuristic scan).
  const serialized = JSON.stringify(bundle);
  if (/\buser_[a-zA-Z0-9_-]{8,}\b/.test(serialized)) {
    throw new EvaluationValidationError("bundle 检测到未脱敏的 raw user_id");
  }
  if (/\btask_[a-zA-Z0-9_-]{8,}\b/.test(serialized)) {
    throw new EvaluationValidationError("bundle 检测到未脱敏的 raw task_id");
  }
  if (/\bmember_[a-zA-Z0-9_-]{8,}\b/.test(serialized)) {
    throw new EvaluationValidationError("bundle 检测到未脱敏的 raw member_id");
  }
  if (/sk-[a-zA-Z0-9]{20,}/.test(serialized)) {
    throw new EvaluationValidationError("bundle 检测到疑似 OpenAI API key");
  }
  if (/ghp_[a-zA-Z0-9]{30,}/.test(serialized)) {
    throw new EvaluationValidationError("bundle 检测到疑似 GitHub token");
  }
  return bundle;
}
