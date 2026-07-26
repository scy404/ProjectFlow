/**
 * T46-7 (Issue #100 §3.5) — Read-only retention planner.
 *
 * Produces a machine-readable retention report over the local
 * artifact store. V1 is INTENTIONALLY non-destructive: it never
 * deletes, moves, or modifies any file. The report is meant to be
 * previewed by a human (or future cleanup job) before any action.
 *
 * Issue #100 §3.5 "Retention planning":
 *  - 提供只读 retention report/plan
 *  - 报告 artifact size、age、status、引用关系和 cleanup eligibility
 *  - V1 不得自动删除任何文件
 *  - failed、needs_review、Repair Packet、promoted/accepted baseline、
 *    被 showcase 引用的 artifact 必须标记为 preserve
 *  - 输出必须是 previewable、machine-readable 的
 *
 * The planner is a pure read pass over `agent-bridge/artifacts/`.
 * It NEVER writes to the artifact store.
 */

import { readFile, readdir, stat, link, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";
import type { EvaluationArtifact } from "./contract.js";
import type { ShowcaseBundle, BundleSourceSidecar } from "./showcase-bundle.js";

// ---------------------------------------------------------------------------
// §1 Constants
// ---------------------------------------------------------------------------

/** The directory under the project root that holds evaluation runs. */
export const ARTIFACTS_DIR = "agent-bridge/artifacts";

/** The directory under the project root that holds committed showcase bundles. */
export const SHOWCASE_BUNDLES_DIR = "agent-bridge/showcase/bundles";

/** Local-only sidecar directory (NOT committed to Git). */
export const SHOWCASE_BUNDLE_SOURCES_DIR = "agent-bridge/showcase/bundle-sources";

/** Schema version for the retention report. */
export const RETENTION_REPORT_SCHEMA_VERSION = 1 as const;

/** V1 retention policy — always non-destructive. */
export const RETENTION_POLICY_VERSION = "v1-no-deletion" as const;

// ---------------------------------------------------------------------------
// §2 Types
// ---------------------------------------------------------------------------

/** Preservation reasons — every entry must be explicit and auditable. */
export type PreserveReason =
  | "status_failed"
  | "status_needs_review"
  | "status_partial_budget"
  | "contains_repair_packet"
  | "contains_diagnosis"
  | "contains_counterfactual"
  | "contains_calibration_artifact"
  | "contains_promotion_approval"
  | "referenced_by_showcase_bundle"
  | "is_promoted_baseline"
  | "preview_run";

export interface RetentionRunEntry {
  /** Run ID (directory name). */
  runId: string;
  /** Absolute path to the run directory. */
  runDir: string;
  /** Total size in bytes of the run directory. */
  sizeBytes: number;
  /** File count inside the run directory. */
  fileCount: number;
  /** ISO timestamp when the run started (from manifest). */
  startedAt: string | null;
  /** ISO timestamp when the run completed (from manifest). */
  completedAt: string | null;
  /** Age in days from `startedAt` to `evaluatedAt`. */
  ageDays: number | null;
  /** Final artifact status. */
  status: string | null;
  /** Preset name. */
  preset: string | null;
  /** Whether the run directory contains a Repair Packet. */
  hasRepairPacket: boolean;
  /** Whether the run directory contains a diagnosis record. */
  hasDiagnosis: boolean;
  /** Whether the run directory contains a counterfactual record. */
  hasCounterfactual: boolean;
  /** Whether the run directory contains a calibration artifact. */
  hasCalibrationArtifact: boolean;
  /** Whether the run directory contains a promotion approval. */
  hasPromotionApproval: boolean;
  /** Whether the run is a live preview (runId starts with `preview_`). */
  isPreview: boolean;
  /** Whether the run is referenced by any committed showcase bundle. */
  referencedByShowcase: boolean;
  /** True when the run must be preserved. */
  preserve: boolean;
  /** Explicit reasons for preservation (empty when `preserve` is false). */
  preserveReasons: PreserveReason[];
  /** True when the run is eligible for cleanup in a future V2. */
  eligibleForCleanup: boolean;
  /** Human-readable Chinese summary. */
  summary: string;
}

export interface RetentionBundleEntry {
  /** Bundle ID. */
  bundleId: string;
  /** Absolute path to the bundle file. */
  bundlePath: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** ISO timestamp when the bundle was created. */
  createdAt: string | null;
  /** Source artifact runId (raw, not pseudonymized). */
  sourceRunId: string | null;
  /** Whether the bundle is referenced by any other committed artifact. */
  referencedByOther: boolean;
  /** Always true — committed bundles are always preserved. */
  preserve: true;
  /** Always false — committed bundles are never cleanup-eligible. */
  eligibleForCleanup: false;
  /** Human-readable Chinese summary. */
  summary: string;
}

export interface RetentionReport {
  schemaVersion: typeof RETENTION_REPORT_SCHEMA_VERSION;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  generatedAt: string;
  projectRoot: string;
  artifactsDir: string;
  bundlesDir: string;
  /** Total size in bytes across all runs. */
  totalRunSizeBytes: number;
  /** Total size in bytes across all committed bundles. */
  totalBundleSizeBytes: number;
  /** Number of runs discovered. */
  runCount: number;
  /** Number of bundles discovered. */
  bundleCount: number;
  /** Number of runs marked preserve. */
  preservedRunCount: number;
  /** Number of runs eligible for cleanup (V1 reports only — no action taken). */
  eligibleRunCount: number;
  /** V1 invariant — always false. */
  autoDeletionPerformed: false;
  /** V1 invariant — always 0. */
  deletedFileCount: 0;
  /** Per-run retention entries. */
  runs: RetentionRunEntry[];
  /** Per-bundle retention entries. */
  bundles: RetentionBundleEntry[];
  /** SHA-256 of the canonical report (excluding this field). */
  integritySha256: string;
}

// ---------------------------------------------------------------------------
// §3 Entry point
// ---------------------------------------------------------------------------

export interface BuildRetentionReportOptions {
  /** Repository root containing CLAUDE.md. */
  projectRoot: string;
  /** Optional ISO timestamp override (for tests). */
  now?: () => string;
}

/**
 * Build a machine-readable retention report. Issue #100 §3.5.
 *
 * The report is a pure read pass — no files are written, deleted,
 * or moved. V1 always reports `autoDeletionPerformed: false` and
 * `deletedFileCount: 0`.
 */
export async function buildRetentionReport(
  options: BuildRetentionReportOptions,
): Promise<RetentionReport> {
  const projectRoot = options.projectRoot;
  const now = options.now ?? (() => new Date().toISOString());
  const generatedAt = now();
  const artifactsDir = resolve(projectRoot, ARTIFACTS_DIR);
  const bundlesDir = resolve(projectRoot, SHOWCASE_BUNDLES_DIR);
  const sourcesDir = resolve(projectRoot, SHOWCASE_BUNDLE_SOURCES_DIR);

  // §3.1 Discover all committed showcase bundles. We need this list
  //      first so we can mark runs referenced by them as preserve.
  // §3.1.1 Read local-only sidecar files FIRST to recover the RAW
  //        source runId for each bundle. The bundle itself only
  //        carries a pseudonymized runId; the sidecar is the local
  //        bookkeeping that lets the retention planner mark source
  //        runs without reverse-mapping pseudonyms AND lets each
  //        bundle entry expose its real sourceRunId. Without this
  //        pass, RetentionBundleEntry.sourceRunId would always be
  //        null — an honesty bug that hides the bundle→run linkage.
  const sidecars = await discoverBundleSidecars(sourcesDir);
  const referencedRunIds = new Set<string>();
  for (const sidecar of sidecars) {
    if (sidecar.sourceRunId) {
      referencedRunIds.add(sidecar.sourceRunId);
    }
  }
  const bundleEntries = await discoverBundles(bundlesDir, generatedAt, sidecars);

  // §3.2 Discover all run directories.
  const runEntries = await discoverRuns(artifactsDir, generatedAt, referencedRunIds);

  // §3.3 Build the report.
  const totalRunSizeBytes = runEntries.reduce((sum, r) => sum + r.sizeBytes, 0);
  const totalBundleSizeBytes = bundleEntries.reduce((sum, b) => sum + b.sizeBytes, 0);
  const preservedRunCount = runEntries.filter((r) => r.preserve).length;
  const eligibleRunCount = runEntries.filter((r) => r.eligibleForCleanup).length;

  const report: Omit<RetentionReport, "integritySha256"> = {
    schemaVersion: RETENTION_REPORT_SCHEMA_VERSION,
    policyVersion: RETENTION_POLICY_VERSION,
    generatedAt,
    projectRoot,
    artifactsDir,
    bundlesDir,
    totalRunSizeBytes,
    totalBundleSizeBytes,
    runCount: runEntries.length,
    bundleCount: bundleEntries.length,
    preservedRunCount,
    eligibleRunCount,
    autoDeletionPerformed: false,
    deletedFileCount: 0,
    runs: runEntries,
    bundles: bundleEntries,
  };

  const integritySha256 = sha256(stableStringify(report));
  return { ...report, integritySha256 };
}

// ---------------------------------------------------------------------------
// §4 Run discovery
// ---------------------------------------------------------------------------

async function discoverRuns(
  artifactsDir: string,
  generatedAt: string,
  referencedRunIds: Set<string>,
): Promise<RetentionRunEntry[]> {
  if (!existsSync(artifactsDir)) return [];
  const entries = await readdir(artifactsDir, { withFileTypes: true });
  const runs: RetentionRunEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const runDir = join(artifactsDir, entry.name);
    const runEntry = await analyzeRunDir(entry.name, runDir, generatedAt, referencedRunIds);
    runs.push(runEntry);
  }
  // Sort by startedAt ascending (nulls first).
  runs.sort((a, b) => {
    if (a.startedAt === null && b.startedAt === null) return a.runId.localeCompare(b.runId);
    if (a.startedAt === null) return -1;
    if (b.startedAt === null) return 1;
    return a.startedAt.localeCompare(b.startedAt);
  });
  return runs;
}

async function analyzeRunDir(
  runId: string,
  runDir: string,
  generatedAt: string,
  referencedRunIds: Set<string>,
): Promise<RetentionRunEntry> {
  // §4.1 Walk the directory to compute total size + file count and
  //      detect auxiliary artifacts (Repair Packets, diagnoses, etc.).
  const { sizeBytes, fileCount, hasRepairPacket, hasDiagnosis, hasCounterfactual, hasCalibrationArtifact, hasPromotionApproval } =
    await walkRunDir(runDir);

  // §4.2 Read the manifest (if present) to get startedAt, completedAt,
  //      status, preset.
  const manifest = await readManifest(runDir);
  const startedAt = manifest?.startedAt ?? null;
  const completedAt = manifest?.completedAt ?? null;
  const status = manifest?.status ?? null;
  const preset = manifest?.preset ?? null;
  const isPreview = runId.startsWith("preview_");
  const referencedByShowcase = referencedRunIds.has(runId);

  // §4.3 Compute age in days.
  let ageDays: number | null = null;
  if (startedAt) {
    const startedTime = Date.parse(startedAt);
    if (!Number.isNaN(startedTime)) {
      ageDays = Math.max(0, (Date.parse(generatedAt) - startedTime) / (24 * 60 * 60 * 1000));
    }
  }

  // §4.4 Determine preservation.
  const preserveReasons: PreserveReason[] = [];
  if (status === "failed" || status === "regression") preserveReasons.push("status_failed");
  if (status === "needs_review") preserveReasons.push("status_needs_review");
  if (status === "partial_budget") preserveReasons.push("status_partial_budget");
  if (hasRepairPacket) preserveReasons.push("contains_repair_packet");
  if (hasDiagnosis) preserveReasons.push("contains_diagnosis");
  if (hasCounterfactual) preserveReasons.push("contains_counterfactual");
  if (hasCalibrationArtifact) preserveReasons.push("contains_calibration_artifact");
  if (hasPromotionApproval) preserveReasons.push("contains_promotion_approval");
  if (referencedByShowcase) preserveReasons.push("referenced_by_showcase_bundle");
  if (isPreview) preserveReasons.push("preview_run");
  // §4.4.1 Promoted baseline detection. The active standards registry
  //        is the source of truth; we read the run's promotion-approval
  //        files to determine if this run produced a promoted baseline.
  //        `hasPromotionApproval` already covers this — the
  //        `is_promoted_baseline` reason is a separate, semantic flag
  //        that is set when the run contains a promotion approval
  //        record (since promotion approvals are how baselines are
  //        promoted).
  if (hasPromotionApproval) preserveReasons.push("is_promoted_baseline");

  const preserve = preserveReasons.length > 0;
  const eligibleForCleanup = !preserve;

  const summary = buildRunSummary(runId, status, preset, sizeBytes, ageDays, preserve, preserveReasons);

  return {
    runId,
    runDir,
    sizeBytes,
    fileCount,
    startedAt,
    completedAt,
    ageDays,
    status,
    preset,
    hasRepairPacket,
    hasDiagnosis,
    hasCounterfactual,
    hasCalibrationArtifact,
    hasPromotionApproval,
    isPreview,
    referencedByShowcase,
    preserve,
    preserveReasons,
    eligibleForCleanup,
    summary,
  };
}

interface RunManifestSummary {
  startedAt: string;
  completedAt: string;
  status: string;
  preset: string;
}

/**
 * Read the run's status, startedAt, completedAt and preset.
 *
 * Prefers `report.json` (the finalized artifact) because it carries
 * the authoritative post-run status. Falls back to `manifest.json`
 * for `preset` when the run is still in-progress (no report yet).
 * Returns null when neither file is present or parseable.
 */
async function readManifest(runDir: string): Promise<RunManifestSummary | null> {
  const reportPath = join(runDir, "report.json");
  const manifestPath = join(runDir, "manifest.json");
  let preset: string | null = null;
  let startedAt: string | null = null;
  let completedAt: string | null = null;
  let status: string | null = null;

  // §1 Read manifest.json for preset (always present once the run is initialized).
  if (existsSync(manifestPath)) {
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as { preset?: string; createdAt?: string };
      if (typeof parsed.preset === "string") preset = parsed.preset;
      // Use createdAt as a fallback for startedAt when report.json is missing.
      if (typeof parsed.createdAt === "string") startedAt = parsed.createdAt;
    } catch {
      // ignore — fall through to report.json
    }
  }

  // §2 Read report.json for the authoritative status / startedAt / completedAt.
  if (existsSync(reportPath)) {
    try {
      const raw = await readFile(reportPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<EvaluationArtifact>;
      if (typeof parsed.startedAt === "string") startedAt = parsed.startedAt;
      if (typeof parsed.completedAt === "string") completedAt = parsed.completedAt;
      if (typeof parsed.status === "string") status = parsed.status;
      if (typeof parsed.preset === "string") preset = parsed.preset;
    } catch {
      // ignore — keep whatever we got from manifest.json
    }
  }

  if (status === null || startedAt === null || completedAt === null || preset === null) {
    return null;
  }
  return { startedAt, completedAt, status, preset };
}

interface WalkResult {
  sizeBytes: number;
  fileCount: number;
  hasRepairPacket: boolean;
  hasDiagnosis: boolean;
  hasCounterfactual: boolean;
  hasCalibrationArtifact: boolean;
  hasPromotionApproval: boolean;
}

async function walkRunDir(runDir: string): Promise<WalkResult> {
  const result: WalkResult = {
    sizeBytes: 0,
    fileCount: 0,
    hasRepairPacket: false,
    hasDiagnosis: false,
    hasCounterfactual: false,
    hasCalibrationArtifact: false,
    hasPromotionApproval: false,
  };
  await walk(runDir, runDir, result);
  return result;
}

async function walk(root: string, dir: string, result: WalkResult): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, result);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stats = await stat(fullPath);
      result.sizeBytes += stats.size;
      result.fileCount += 1;
    } catch {
      // File may have been removed mid-walk — skip.
      continue;
    }
    const relativePath = fullPath.slice(root.length + 1);
    if (relativePath.startsWith("repair-packets/")) result.hasRepairPacket = true;
    else if (relativePath.startsWith("diagnoses/")) result.hasDiagnosis = true;
    else if (relativePath.startsWith("counterfactuals/")) result.hasCounterfactual = true;
    else if (relativePath === "calibration-artifact.json") result.hasCalibrationArtifact = true;
    else if (relativePath.startsWith("promotion-approvals/") || relativePath === "promotion-approval.json") {
      result.hasPromotionApproval = true;
    }
  }
}

function buildRunSummary(
  runId: string,
  status: string | null,
  preset: string | null,
  sizeBytes: number,
  ageDays: number | null,
  preserve: boolean,
  reasons: PreserveReason[],
): string {
  const sizeKb = (sizeBytes / 1024).toFixed(1);
  const age = ageDays !== null ? `${ageDays.toFixed(1)} 天` : "未知";
  const statusText = status ?? "未知";
  const presetText = preset ?? "未知";
  if (preserve) {
    return `保留 ${runId} (status=${statusText}, preset=${presetText}, size=${sizeKb}KB, age=${age}); 原因: ${reasons.join(", ")}`;
  }
  return `可清理 ${runId} (status=${statusText}, preset=${presetText}, size=${sizeKb}KB, age=${age}); V1 不自动删除`;
}

// ---------------------------------------------------------------------------
// §5 Bundle discovery
// ---------------------------------------------------------------------------

async function discoverBundles(
  bundlesDir: string,
  _generatedAt: string,
  sidecars: BundleSourceSidecar[],
): Promise<RetentionBundleEntry[]> {
  if (!existsSync(bundlesDir)) return [];
  // Index sidecars by bundleId so each bundle entry can recover its
  // RAW source runId. The portable bundle only carries a pseudonymized
  // runId; the sidecar is the local bookkeeping that lets the
  // retention planner report the real sourceRunId honestly.
  const sidecarByBundleId = new Map<string, BundleSourceSidecar>();
  for (const sidecar of sidecars) sidecarByBundleId.set(sidecar.bundleId, sidecar);
  const entries = await readdir(bundlesDir, { withFileTypes: true });
  const bundles: RetentionBundleEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name.startsWith(".")) continue;
    const bundlePath = join(bundlesDir, entry.name);
    const bundleEntry = await analyzeBundleFile(entry.name, bundlePath, sidecarByBundleId);
    bundles.push(bundleEntry);
  }
  bundles.sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  return bundles;
}

async function analyzeBundleFile(
  fileName: string,
  bundlePath: string,
  sidecarByBundleId: Map<string, BundleSourceSidecar>,
): Promise<RetentionBundleEntry> {
  const stats = await stat(bundlePath);
  let bundle: ShowcaseBundle | null = null;
  try {
    const raw = await readFile(bundlePath, "utf-8");
    bundle = JSON.parse(raw) as ShowcaseBundle;
  } catch {
    // Malformed bundle — still preserve (do not delete).
  }
  const bundleId = bundle?.bundleId ?? fileName;
  const createdAt = bundle?.createdAt ?? null;
  // The bundle's `sourceArtifact.runIdPseudonym` is pseudonymized.
  // The RAW source runId is recovered from the local-only sidecar
  // file in `agent-bridge/showcase/bundle-sources/<bundleId>.source.json`.
  // When the sidecar is missing (e.g., the bundle was copied in from
  // another machine), we cannot determine the source runId and
  // mark it as `null` — this is honest.
  const sidecar = bundleId ? sidecarByBundleId.get(bundleId) : undefined;
  const sourceRunId = sidecar?.sourceRunId ?? null;
  const summary = `保留 showcase bundle ${bundleId} (size=${(stats.size / 1024).toFixed(1)}KB, sourceRun=${sourceRunId ?? "unknown"})`;
  return {
    bundleId,
    bundlePath,
    sizeBytes: stats.size,
    createdAt,
    sourceRunId,
    referencedByOther: false,
    preserve: true,
    eligibleForCleanup: false,
    summary,
  };
}

/**
 * Discover all local-only bundle source sidecar files. Each sidecar
 * maps a published bundle to its RAW source runId. Sidecars are
 * written by `buildShowcaseBundle` and are NOT part of the portable
 * bundle.
 */
async function discoverBundleSidecars(sourcesDir: string): Promise<BundleSourceSidecar[]> {
  if (!existsSync(sourcesDir)) return [];
  const entries = await readdir(sourcesDir, { withFileTypes: true });
  const sidecars: BundleSourceSidecar[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".source.json")) continue;
    if (entry.name.startsWith(".")) continue;
    const sidecarPath = join(sourcesDir, entry.name);
    try {
      const raw = await readFile(sidecarPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<BundleSourceSidecar>;
      if (
        typeof parsed.bundleId === "string"
        && typeof parsed.sourceRunId === "string"
        && typeof parsed.sourceRunDir === "string"
        && typeof parsed.publishedAt === "string"
      ) {
        sidecars.push(parsed as BundleSourceSidecar);
      }
    } catch {
      // Malformed sidecar — skip. We never delete files in V1.
    }
  }
  return sidecars;
}

// ---------------------------------------------------------------------------
// §6 Report publisher (atomic, never overwrites)
// ---------------------------------------------------------------------------

/**
 * Atomically publish the retention report to the showcase retention
 * directory. Uses the hard-link primitive so a partial write never
 * replaces an existing report.
 *
 * Issue #100 §3.5: "输出必须是 previewable、machine-readable 的".
 */
export async function publishRetentionReport(
  report: RetentionReport,
  reportPath: string,
): Promise<string> {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const tempPath = join(dirname(reportPath), `.${basename(reportPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tempPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  try {
    await link(tempPath, reportPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await rm(tempPath, { force: true });
      throw new EvaluationInfrastructureError(
        `retention report 拒绝覆盖已存在的报告: ${reportPath}`,
      );
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  return reportPath;
}

/**
 * Verify the integrity hash of a published retention report.
 * Throws on mismatch — there is no fallback.
 */
export async function verifyRetentionReport(reportPath: string): Promise<RetentionReport> {
  const raw = await readFile(reportPath, "utf-8");
  let parsed: RetentionReport;
  try {
    parsed = JSON.parse(raw) as RetentionReport;
  } catch (error) {
    throw new EvaluationInfrastructureError(`retention report JSON 解析失败: ${(error as Error).message}`);
  }
  const { integritySha256, ...rest } = parsed;
  const expected = sha256(stableStringify(rest));
  if (integritySha256 !== expected) {
    throw new EvaluationInfrastructureError(
      `retention report 哈希不匹配: expected ${expected}, got ${integritySha256}`,
    );
  }
  if (parsed.autoDeletionPerformed !== false || parsed.deletedFileCount !== 0) {
    throw new EvaluationValidationError(
      `retention report 违反 V1 不删除不变量: autoDeletionPerformed=${parsed.autoDeletionPerformed}, deletedFileCount=${parsed.deletedFileCount}`,
    );
  }
  return parsed;
}
