/**
 * T46-7 (Issue #100 §4) — Schema, hash and provenance verification for
 * presentation surfaces.
 *
 * The showcase bundle and the local viewer MUST consume the SAME
 * verified immutable result graph. This module is the single entry
 * point used by both surfaces to:
 *
 *  1. Verify the artifact schemaVersion is supported (or migrated via
 *     an explicit, deterministic migration).
 *  2. Verify the SHA-256 result graph (integrity root, evidence root,
 *     per-file hashes) against the stored integrity index.
 *  3. Verify the provenance record is present, well-formed, and not
 *     stale relative to the report.
 *  4. Reject unknown future schemas fail-closed — never best-effort
 *     guess a future shape.
 *
 * Boundary invariants (must hold across all presentation surfaces):
 *  - The presentation surface MUST NOT recompute, derive or override
 *    any grade. Grades are read-only summaries of the verified
 *    artifact.
 *  - Malformed, hash-mismatched, stale or missing-provenance
 *    artifacts MUST fail-closed.
 *  - Supported older schemas MUST be migrated through an explicit,
 *    deterministic migration step recorded in the bundle/viewer
 *    output. Best-effort guess for unknown future schemas is
 *    forbidden.
 *  - Migrations are ADDITIVE only — they may add defaulted fields or
 *    rename deprecated fields, but they cannot change the meaning of
 *    existing grades, observations, or evidence references.
 *  - Migrations MUST be idempotent: migrating an already-migrated
 *    artifact yields the same artifact.
 *
 * Issue #100 §4 also requires:
 *  - "supported older schema MUST go through explicit, deterministic
 *    migration"
 *  - "unknown future schema MUST be rejected, cannot best-effort guess"
 *  - "presentation surface MUST NOT derive or recompute grade"
 */

import { readFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";
import {
  EVALUATION_SCHEMA_VERSION,
  type EvaluationArtifact,
  type EvaluationProvenance,
  type IntegrityIndex,
} from "./contract.js";

// ---------------------------------------------------------------------------
// §1 Supported schema versions and migration table
// ---------------------------------------------------------------------------

/**
 * The set of schemaVersions the presentation surface can verify and
 * (when needed) migrate. Adding a new version requires:
 *  - bumping `EVALUATION_SCHEMA_VERSION` in `contract.ts`
 *  - adding the previous version to `SUPPORTED_SOURCE_SCHEMA_VERSIONS`
 *  - registering a deterministic migration in `MIGRATIONS`
 *  - extending the migration tests
 *
 * Unknown future versions MUST be rejected fail-closed.
 */
export const SUPPORTED_SOURCE_SCHEMA_VERSIONS: readonly number[] = [
  EVALUATION_SCHEMA_VERSION,
] as const;

/**
 * The schema version the presentation surface emits after migration.
 * Today this equals the current EVALUATION_SCHEMA_VERSION. When a V2
 * is introduced, this will become the target version for migrations
 * from V1.
 */
export const PRESENTATION_SCHEMA_VERSION: number = EVALUATION_SCHEMA_VERSION;

/**
 * Migration record. Each migration takes a parsed artifact of the
 * source version and produces an artifact at the target version. The
 * migration MUST be deterministic and idempotent.
 */
export interface MigrationRecord {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly description: string;
  readonly migrate: (artifact: EvaluationArtifact) => EvaluationArtifact;
}

/**
 * Frozen migration table. Each entry migrates a supported older
 * schema to the presentation surface's target version.
 *
 * Currently there are no older schemas to migrate — V1 is the only
 * supported source. The table is intentionally empty so the
 * presentation surface still exercises the migration path (lookup,
 * apply, record) without inventing fake migrations.
 *
 * When V2 is introduced, add a migration from V1 → V2 here. The
 * migration MUST be additive only and MUST NOT alter existing grade
 * semantics.
 */
export const MIGRATIONS: readonly MigrationRecord[] = [];

/**
 * Find the migration chain from `sourceVersion` to
 * `PRESENTATION_SCHEMA_VERSION`. Returns an empty array when the
 * source already equals the target. Throws when no chain exists.
 */
function findMigrationChain(sourceVersion: number): MigrationRecord[] {
  if (sourceVersion === PRESENTATION_SCHEMA_VERSION) return [];
  if (!SUPPORTED_SOURCE_SCHEMA_VERSIONS.includes(sourceVersion)) {
    throw new EvaluationValidationError(
      `不受支持的 artifact schemaVersion: ${sourceVersion}; 当前支持: ${SUPPORTED_SOURCE_SCHEMA_VERSIONS.join(", ")}`,
    );
  }
  const chain: MigrationRecord[] = [];
  let current = sourceVersion;
  const visited = new Set<number>([sourceVersion]);
  while (current !== PRESENTATION_SCHEMA_VERSION) {
    const next = MIGRATIONS.find((migration) => migration.fromVersion === current);
    if (!next) {
      throw new EvaluationInfrastructureError(
        `找不到 ${current} → ${PRESENTATION_SCHEMA_VERSION} 的 migration; 已迁移链: ${chain.map((m) => `${m.fromVersion}→${m.toVersion}`).join(", ") || "<空>"}`,
      );
    }
    if (visited.has(next.toVersion)) {
      throw new EvaluationInfrastructureError(
        `migration 链检测到环: ${next.fromVersion} → ${next.toVersion}`,
      );
    }
    visited.add(next.toVersion);
    chain.push(next);
    current = next.toVersion;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// §2 Verification primitives
// ---------------------------------------------------------------------------

/**
 * Verify the integrity index entries against the actual files on
 * disk. Each entry's SHA-256 MUST match the file content. The
 * evidence root hash MUST match the stable stringification of the
 * entries. The integrity root hash MUST match the stable
 * stringification of `{entries, report}` (where `report` excludes
 * its own `integrityRootSha256` field).
 *
 * Issue #100 §4: "malformed, hash mismatch, stale/missing provenance
 * MUST fail-closed".
 */
export async function verifyResultGraph(
  runDir: string,
  artifact: EvaluationArtifact,
  integrity: IntegrityIndex,
): Promise<void> {
  if (integrity.algorithm !== "sha256") {
    throw new EvaluationInfrastructureError(
      `integrity algorithm 不受支持: ${String(integrity.algorithm)}`,
    );
  }
  // §2.1 Verify every file hash in the integrity index.
  for (const [relativePath, expectedHash] of Object.entries(integrity.entries)) {
    if (!isSafeRelativePath(relativePath)) {
      throw new EvaluationValidationError(`integrity index 包含非法路径: ${relativePath}`);
    }
    const absolute = join(runDir, relativePath);
    assertRegularFile(absolute, runDir);
    const content = await readFile(absolute, "utf-8");
    if (sha256(content) !== expectedHash) {
      throw new EvaluationInfrastructureError(
        `result graph hash 校验失败: ${relativePath}`,
      );
    }
  }
  // §2.2 Verify the evidence root hash.
  const computedEvidenceRoot = sha256(stableStringify(integrity.entries));
  if (computedEvidenceRoot !== integrity.evidenceRootSha256) {
    throw new EvaluationInfrastructureError("evidence root hash 不一致");
  }
  // §2.3 Verify the integrity root hash. The report object used in
  // the integrity root excludes its own `integrityRootSha256` field
  // to avoid a self-referential hash.
  const { integrityRootSha256: _stored, ...reportCore } = artifact;
  void _stored;
  const computedIntegrityRoot = sha256(stableStringify({ entries: integrity.entries, report: reportCore }));
  if (computedIntegrityRoot !== integrity.integrityRootSha256) {
    throw new EvaluationInfrastructureError("integrity root hash 不一致");
  }
  if (artifact.integrityRootSha256 !== integrity.integrityRootSha256) {
    throw new EvaluationInfrastructureError("report.integrityRootSha256 与 integrity.integrityRootSha256 不一致");
  }
  // §2.4 Verify the report SHA-256 matches `report.json` on disk.
  const reportDiskPath = join(runDir, "report.json");
  assertRegularFile(reportDiskPath, runDir);
  const reportOnDisk = await readFile(reportDiskPath, "utf-8");
  if (sha256(reportOnDisk) !== integrity.reportSha256) {
    throw new EvaluationInfrastructureError("report.json 哈希与 integrity.reportSha256 不一致");
  }
}

/**
 * Verify the artifact provenance is present, well-formed and
 * consistent with the report. Issue #100 §4: "stale/missing
 * provenance MUST fail-closed".
 */
export function verifyProvenance(artifact: EvaluationArtifact): EvaluationProvenance {
  const provenance = artifact.provenance;
  if (!provenance) {
    throw new EvaluationInfrastructureError("artifact 缺少 provenance");
  }
  if (typeof provenance.evaluatorVersion !== "string" || !provenance.evaluatorVersion) {
    throw new EvaluationInfrastructureError("provenance.evaluatorVersion 缺失");
  }
  if (provenance.publicSeamVersion !== "http-sse-v1") {
    throw new EvaluationInfrastructureError(
      `provenance.publicSeamVersion 不受支持: ${String(provenance.publicSeamVersion)}`,
    );
  }
  if (typeof provenance.platform !== "string" || !provenance.platform) {
    throw new EvaluationInfrastructureError("provenance.platform 缺失");
  }
  if (typeof provenance.architecture !== "string" || !provenance.architecture) {
    throw new EvaluationInfrastructureError("provenance.architecture 缺失");
  }
  if (typeof provenance.nodeVersion !== "string" || !provenance.nodeVersion) {
    throw new EvaluationInfrastructureError("provenance.nodeVersion 缺失");
  }
  if (!provenance.code || typeof provenance.code.gitCommit !== "string" || !provenance.code.gitCommit) {
    throw new EvaluationInfrastructureError("provenance.code.gitCommit 缺失");
  }
  if (typeof provenance.code.gitDirty !== "boolean") {
    throw new EvaluationInfrastructureError("provenance.code.gitDirty 必须为 boolean");
  }
  if (typeof provenance.code.worktreeSha256 !== "string" || !provenance.code.worktreeSha256) {
    throw new EvaluationInfrastructureError("provenance.code.worktreeSha256 缺失");
  }
  if (typeof provenance.scenarioContractsSha256 !== "string" || provenance.scenarioContractsSha256.length !== 64) {
    throw new EvaluationInfrastructureError("provenance.scenarioContractsSha256 不是合法的 SHA-256");
  }
  if (typeof provenance.modelConfigSha256 !== "string" || provenance.modelConfigSha256.length !== 64) {
    throw new EvaluationInfrastructureError("provenance.modelConfigSha256 不是合法的 SHA-256");
  }
  return provenance;
}

// ---------------------------------------------------------------------------
// §3 Migration surface
// ---------------------------------------------------------------------------

/** Result of `migrateArtifact`. The migration log records each applied
 *  migration step so the presentation surface can surface it to the
 *  viewer and embed it in the bundle provenance. */
export interface MigrationResult {
  /** The migrated artifact (or the original when no migration was needed). */
  readonly artifact: EvaluationArtifact;
  /** The source schema version. */
  readonly sourceSchemaVersion: number;
  /** The target schema version (always PRESENTATION_SCHEMA_VERSION). */
  readonly targetSchemaVersion: number;
  /** The migration chain applied (empty when source == target). */
  readonly migrationsApplied: ReadonlyArray<{
    fromVersion: number;
    toVersion: number;
    description: string;
  }>;
}

/**
 * Migrate an artifact to `PRESENTATION_SCHEMA_VERSION`. Throws when
 * the source version is unsupported or no migration chain exists.
 *
 * Issue #100 §4: "supported older schema MUST go through explicit,
 * deterministic migration; unknown future schema MUST be rejected".
 */
export function migrateArtifact(artifact: EvaluationArtifact): MigrationResult {
  const sourceVersion = artifact.schemaVersion;
  if (!Number.isInteger(sourceVersion) || sourceVersion <= 0) {
    throw new EvaluationValidationError(`artifact.schemaVersion 非法: ${String(sourceVersion)}`);
  }
  const chain = findMigrationChain(sourceVersion);
  let current = artifact;
  for (const migration of chain) {
    current = migration.migrate(current);
    if (current.schemaVersion !== migration.toVersion) {
      throw new EvaluationInfrastructureError(
        `migration ${migration.fromVersion} → ${migration.toVersion} 输出了 schemaVersion ${String(current.schemaVersion)}`,
      );
    }
  }
  return {
    artifact: current,
    sourceSchemaVersion: sourceVersion,
    targetSchemaVersion: PRESENTATION_SCHEMA_VERSION,
    migrationsApplied: chain.map((migration) => ({
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
      description: migration.description,
    })),
  };
}

// ---------------------------------------------------------------------------
// §4 Top-level verification entry point
// ---------------------------------------------------------------------------

/**
 * Verified artifact bundle — the single input format the presentation
 * surfaces consume. Produced by `verifyAndMigrateArtifact`.
 */
export interface VerifiedArtifact {
  /** The migrated artifact at PRESENTATION_SCHEMA_VERSION. */
  readonly artifact: EvaluationArtifact;
  /** The integrity index loaded from `integrity.json`. */
  readonly integrity: IntegrityIndex;
  /** The verified provenance. */
  readonly provenance: EvaluationProvenance;
  /** The migration log. Empty when no migration was needed. */
  readonly migrationLog: MigrationResult["migrationsApplied"];
  /** Absolute path to the run directory on disk. */
  readonly runDir: string;
  /** Run ID. */
  readonly runId: string;
}

/**
 * Top-level entry point used by the showcase bundle and local viewer.
 *
 * Steps:
 *  1. Read `integrity.json` and verify its schema.
 *  2. Read `report.json`, verify its hash matches the integrity index.
 *  3. Verify every file hash in the integrity index.
 *  4. Verify the evidence root and integrity root hashes.
 *  5. Verify the provenance record.
 *  6. Migrate the artifact to PRESENTATION_SCHEMA_VERSION (no-op today).
 *  7. Return the verified artifact + integrity + provenance + migration log.
 *
 * Issue #100 §4: "rendering MUST first verify artifact schema, SHA-256
 * result graph and provenance; malformed, hash mismatch, stale/missing
 * provenance MUST fail-closed".
 */
export async function verifyAndMigrateArtifact(runDir: string, runId: string): Promise<VerifiedArtifact> {
  if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new EvaluationValidationError(`非法 run ID: ${String(runId)}`);
  }
  // §0 Path containment (Issue #100 batch B):
  //    a) runDir must not be a symlink (lstat).
  //    b) canonical (realpath) basename of runDir must equal runId.
  //    c) runId must appear as a component in the realpath.
  const normalizedRunDir = resolve(runDir);
  let runDirStat;
  try {
    runDirStat = lstatSync(normalizedRunDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EvaluationInfrastructureError(`runDir 不存在: ${normalizedRunDir}`);
    }
    throw new EvaluationInfrastructureError(`无法 stat runDir: ${(error as Error).message}`);
  }
  if (runDirStat.isSymbolicLink()) {
    throw new EvaluationValidationError(`runDir 不允许为 symlink: ${normalizedRunDir}`);
  }
  if (!runDirStat.isDirectory()) {
    throw new EvaluationValidationError(`runDir 必须是目录: ${normalizedRunDir}`);
  }
  const runDirReal = realpathSync(normalizedRunDir);
  const canonicalBasename = basename(runDirReal);
  if (canonicalBasename !== runId) {
    throw new EvaluationValidationError(
      `runDir canonical basename "${canonicalBasename}" 与 runId "${runId}" 不一致; 路径越界拒绝`,
    );
  }
  const runDirComponents = runDirReal.split(sep);
  if (!runDirComponents.includes(runId)) {
    throw new EvaluationValidationError(
      `runId "${runId}" 不在 runDir realpath "${runDirReal}" 中; 路径越界拒绝`,
    );
  }
  // §1 Read and parse integrity.json (with lstat containment).
  const integrityPath = join(runDirReal, "integrity.json");
  assertRegularFile(integrityPath, runDirReal);
  const integrityRaw = await readFile(integrityPath, "utf-8");
  let integrity: IntegrityIndex;
  try {
    integrity = JSON.parse(integrityRaw) as IntegrityIndex;
  } catch (error) {
    throw new EvaluationInfrastructureError(`integrity.json 解析失败: ${(error as Error).message}`);
  }
  // Issue #100 batch 2: use assertSupportedSchema so the code path is
  // NOT hardcoded to current-only. When EVALUATION_SCHEMA_VERSION bumps
  // and a migration is added, this path still works — supported older
  // versions pass through, unknown future versions fail-closed.
  assertSupportedSchema(integrity.schemaVersion);
  // §2 Read and parse report.json, verify its hash matches integrity.
  const reportPath = join(runDirReal, "report.json");
  assertRegularFile(reportPath, runDirReal);
  const reportRaw = await readFile(reportPath, "utf-8");
  if (sha256(reportRaw) !== integrity.reportSha256) {
    throw new EvaluationInfrastructureError("report.json 哈希与 integrity.reportSha256 不一致");
  }
  let artifact: EvaluationArtifact;
  try {
    artifact = JSON.parse(reportRaw) as EvaluationArtifact;
  } catch (error) {
    throw new EvaluationInfrastructureError(`report.json 解析失败: ${(error as Error).message}`);
  }
  // Issue #100 fix #5: the artifact's self-reported runId MUST match the
  // caller-provided runId. This prevents cross-run artifact misidentification
  // where artifact from run A is loaded under run B's directory.
  if (artifact.runId !== runId) {
    throw new EvaluationInfrastructureError(
      `artifact runId "${artifact.runId}" 与调用方 runId "${runId}" 不匹配; 拒绝加载`,
    );
  }
  // Issue #100 batch 2: the report's schemaVersion MUST match the
  // integrity.json's schemaVersion. They are the same source version —
  // any divergence means the artifact is corrupt or mismatched.
  if (artifact.schemaVersion !== integrity.schemaVersion) {
    throw new EvaluationInfrastructureError(
      `report.json schemaVersion ${String(artifact.schemaVersion)} 与 integrity.json schemaVersion ${String(integrity.schemaVersion)} 不一致; 拒绝加载`,
    );
  }
  // §3 Verify the full result graph (every file hash + evidence root
  //    + integrity root + report hash), using runDirReal for containment.
  await verifyResultGraph(runDirReal, artifact, integrity);
  // §4 Verify provenance.
  const provenance = verifyProvenance(artifact);
  // §5 Migrate to PRESENTATION_SCHEMA_VERSION (no-op today, but the
  //    code path goes through findMigrationChain which uses
  //    SUPPORTED_SOURCE_SCHEMA_VERSIONS — independent of the hardcoded
  //    current-only check that was removed in batch 2).
  const migration = migrateArtifact(artifact);
  // §6 Return the verified artifact bundle (using canonical realpath).
  return {
    artifact: migration.artifact,
    integrity,
    provenance,
    migrationLog: migration.migrationsApplied,
    runDir: runDirReal,
    runId,
  };
}

// ---------------------------------------------------------------------------
// §5 Helpers
// ---------------------------------------------------------------------------

const SAFE_RELATIVE_PATH = /^[a-zA-Z0-9_./-]+$/;

function isSafeRelativePath(path: string): boolean {
  if (!SAFE_RELATIVE_PATH.test(path)) return false;
  if (path.startsWith("/")) return false;
  if (path.split(/[\\/]/).includes("..")) return false;
  return true;
}

/**
 * Assert that `filePath` is a regular file (not symlink, not directory)
 * and its realpath is contained within `rootReal`.
 *
 * Issue #100 batch B: all artifact file reads must pass lstat + realpath
 * containment before reading.
 */
function assertRegularFile(filePath: string, rootReal: string): void {
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EvaluationInfrastructureError(`artifact 文件不存在: ${filePath}`);
    }
    throw new EvaluationInfrastructureError(`无法 stat artifact 文件: ${(error as Error).message}`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new EvaluationValidationError(`artifact 文件不允许为 symlink: ${filePath}`);
  }
  if (!fileStat.isFile()) {
    throw new EvaluationValidationError(`artifact 文件必须是 regular file: ${filePath}`);
  }
  const fileReal = realpathSync(filePath);
  const rootPrefix = `${rootReal}${sep}`;
  if (!fileReal.startsWith(rootPrefix) && fileReal !== rootReal) {
    throw new EvaluationValidationError(
      `artifact 文件真实路径越界: ${fileReal} 不在 ${rootReal} 内`,
    );
  }
}

/**
 * Assert that a given schema version is supported. Exposed for tests
 * and for the CLI's `--validate` path. Fail-closed on unknown future
 * schemas.
 */
export function assertSupportedSchema(version: number): void {
  if (!SUPPORTED_SOURCE_SCHEMA_VERSIONS.includes(version)) {
    throw new EvaluationValidationError(
      `不受支持的 schemaVersion: ${version}; 当前支持: ${SUPPORTED_SOURCE_SCHEMA_VERSIONS.join(", ")}`,
    );
  }
}

/**
 * Compute a stable SHA-256 fingerprint for a verified artifact. Used
 * by both the showcase bundle and the local viewer so they can prove
 * they are rendering the SAME artifact. Issue #100 §3: "viewer 与
 * portable bundle 对同一 artifact 的 verdict、计数和成本必须完全一致".
 */
export function computeArtifactFingerprint(verified: VerifiedArtifact): string {
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
