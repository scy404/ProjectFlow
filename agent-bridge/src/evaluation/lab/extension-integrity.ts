/**
 * T46-7 (Issue #100 batch A+B) — Extension integrity revision chain.
 *
 * The base integrity index (integrity.json) covers observation, grade,
 * checksum, manifest, report and evidence root artifacts that are
 * finalized when a run completes. Auxiliary artifacts produced AFTER
 * the run (diagnoses, clusters, repair packets, counterfactuals,
 * calibration artifacts, candidate registries, promotion approvals)
 * are NOT covered by the base integrity index.
 *
 * A single immutable extension-integrity.json cannot support the
 * diagnose → calibrate flow: after diagnose publishes the index,
 * calibrate cannot add new entries. The append-only revision chain
 * solves this:
 *
 *  - Each revision is a separate file (extension-integrity.0001.json,
 *    extension-integrity.0002.json, …).
 *  - Each revision anchors to sourceIntegrityRootSha256 and the
 *    previous revision's SHA-256.
 *  - Each revision records ONLY the files NEW in that revision.
 *  - Revisions are atomically published; EEXIST → fail-closed.
 *  - The consumer validates: unique contiguous chain, no forks, no
 *    gaps, no duplicate relativePath conflicts, valid schema/type/
 *    version/runId/anchor consistency.
 *
 * All diagnosis, cluster, repair, counterfactual, calibration,
 * candidate, and promotion-approval paths must register in the chain.
 *
 * Fail-closed rules (Issue #100 batch A):
 *  - Extension files exist on disk but no trusted chain → fail-closed
 *    (showcase/repair).
 *  - Old runs with zero extension files → return null (valid state).
 *  - Extension file publish succeeds but chain registration fails →
 *    MUST NOT return success.
 */

import { link, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Constants
// ---------------------------------------------------------------------------

export const EXTENSION_INTEGRITY_SCHEMA_VERSION = 1 as const;

/** Extension file types that can enter the index. */
export type ExtensionFileType =
  | "repair_packet"
  | "diagnosis"
  | "issue_cluster"
  | "counterfactual"
  | "calibration_artifact"
  | "candidate_registry"
  | "promotion_approval"
  | "rca_benchmark";

// ---------------------------------------------------------------------------
// §2 Types
// ---------------------------------------------------------------------------

export interface ExtensionRevisionEntry {
  /** Safe relative path from the run directory (e.g., "repair-packets/pkt-001.json"). */
  relativePath: string;
  /** SHA-256 of the file content. */
  sha256: string;
  /** Extension file type. */
  type: ExtensionFileType;
  /** Version of the extension file type. */
  version: number;
}

/**
 * A single revision in the append-only immutable chain.
 *
 * Each revision records ONLY the files added in that revision. The
 * consumer merges all revisions in order to build the full index.
 */
export interface ExtensionRevision {
  schemaVersion: typeof EXTENSION_INTEGRITY_SCHEMA_VERSION;
  /** 1-based sequential revision number. */
  revisionNumber: number;
  /** The runId this chain belongs to. */
  runId: string;
  /** The source run's integrityRootSha256 — anchors this extension to a verified base. */
  sourceIntegrityRootSha256: string;
  /** SHA-256 of the previous revision's canonical form (excluding integritySha256).
   *  null for revision 1 (first revision in the chain). */
  previousRevisionSha256: string | null;
  /** When this revision was generated. */
  generatedAt: string;
  /** Extension file entries added in THIS revision, sorted by relativePath. */
  entries: ExtensionRevisionEntry[];
  /** SHA-256 of the canonical revision (excluding this field). */
  integritySha256: string;
}

/**
 * The merged, verified extension index presented to consumers.
 *
 * Built by reading and validating the entire revision chain.
 */
export interface ExtensionIntegrityIndex {
  schemaVersion: typeof EXTENSION_INTEGRITY_SCHEMA_VERSION;
  runId: string;
  sourceIntegrityRootSha256: string;
  /** All entries from all revisions, merged and sorted by relativePath. */
  entries: ExtensionRevisionEntry[];
  /** The revision count in the chain. */
  revisionCount: number;
  /** SHA-256 of revision N (the tip). */
  tipRevisionSha256: string;
}

// ---------------------------------------------------------------------------
// §3 File naming
// ---------------------------------------------------------------------------

/** Filename pattern: extension-integrity.{NNNN}.json */
function revisionFileName(revisionNumber: number): string {
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
    throw new EvaluationValidationError(`非法 revision number: ${revisionNumber}`);
  }
  return `extension-integrity.${String(revisionNumber).padStart(4, "0")}.json`;
}

function revisionPath(runDir: string, revisionNumber: number): string {
  return join(runDir, revisionFileName(revisionNumber));
}

/** List all revision files in a runDir, sorted by revision number. */
async function listRevisionFiles(runDir: string): Promise<number[]> {
  let files: string[];
  try {
    files = await readdir(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const revisionNumbers: number[] = [];
  const pattern = /^extension-integrity\.(\d{4})\.json$/;
  for (const file of files) {
    const match = pattern.exec(file);
    if (match) {
      revisionNumbers.push(parseInt(match[1]!, 10));
    }
  }
  revisionNumbers.sort((a, b) => a - b);
  return revisionNumbers;
}

// ---------------------------------------------------------------------------
// §4 Path containment (lstat + realpath)
//
// Issue #100 batch B: every path (runDir, revision files, extension files,
// integrity.json, report.json) must pass lstat + realpath containment.
// Reject symlinks, non-regular files, absolute escape, .. traversal.
// ---------------------------------------------------------------------------

/**
 * Assert that `target` is a directory (not symlink) and its realpath is
 * within `rootReal`. Also walks each component from root to target and
 * rejects symlinks at any level.
 */
export function assertDirectoryContainment(root: string, targetDir: string): void {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new EvaluationInfrastructureError(
      `extension integrity: 无法 stat 根目录 ${root}: ${(error as Error).message}`,
    );
  }
  if (rootStat.isSymbolicLink()) {
    throw new EvaluationValidationError(
      `extension integrity: runDir 不允许为 symlink: ${root}`,
    );
  }
  const rootReal = realpathSync(root);

  // Verify targetDir is within root.
  if (targetDir !== root) {
    let currentReal: string;
    try {
      currentReal = realpathSync(targetDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!currentReal.startsWith(`${rootReal}${sep}`) && currentReal !== rootReal) {
      throw new EvaluationValidationError(
        `extension integrity: 路径越界 ${targetDir} (real=${currentReal}) 不在 ${rootReal} 内`,
      );
    }
  }

  // Walk each component from root to targetDir, checking for symlinks.
  if (targetDir !== root) {
    let current = root;
    const relativePath = targetDir.slice(root.length + 1);
    for (const component of relativePath.split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new EvaluationValidationError(
            `extension integrity: 路径组件不允许为 symlink: ${current}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
}

export function assertFileContainment(runDir: string, filePath: string): void {
  // Reject absolute paths and .. escape early.
  if (filePath.split(/[\\/]/).includes("..")) {
    throw new EvaluationValidationError(
      `extension integrity: 拒绝 .. 逃逸: ${filePath}`,
    );
  }
  // Reject non-regular files and symlinks.
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new EvaluationInfrastructureError(
      `extension integrity: 无法 stat 文件 ${filePath}: ${(error as Error).message}`,
    );
  }
  if (fileStat.isSymbolicLink()) {
    throw new EvaluationValidationError(
      `extension integrity: 拒绝 symlink 文件: ${filePath}`,
    );
  }
  if (!fileStat.isFile()) {
    throw new EvaluationValidationError(
      `extension integrity: 拒绝非 regular file: ${filePath}`,
    );
  }
  // Verify realpath containment.
  const fileReal = realpathSync(filePath);
  const runDirReal = realpathSync(runDir);
  const runDirPrefix = `${runDirReal}${sep}`;
  if (!fileReal.startsWith(runDirPrefix) && fileReal !== runDirReal) {
    throw new EvaluationValidationError(
      `extension integrity: 文件真实路径越界 ${fileReal} 不在 ${runDirReal} 内`,
    );
  }
}

/**
 * Assert that the canonical (realpath) basename of runDir matches the
 * given runId. Issue #100 batch B: "canonical runDir basename, caller
 * runId, artifact.runId 三方一致".
 */
export function assertRunDirBasenameConsistency(runDir: string, runId: string): void {
  const real = realpathSync(runDir);
  const name = basename(real);
  if (name !== runId) {
    throw new EvaluationValidationError(
      `runDir canonical basename "${name}" 与 runId "${runId}" 不一致`,
    );
  }
}

// ---------------------------------------------------------------------------
// §5 Scanning extension files (identify candidates for indexing)
// ---------------------------------------------------------------------------

interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  type: ExtensionFileType;
  version: number;
  sha256: string;
}

/**
 * Scan the runDir for all known extension file types. Returns a list of
 * all files that COULD be indexed. The caller decides which are new vs
 * already in an existing revision.
 */
async function scanExtensionFiles(runDir: string): Promise<ScannedFile[]> {
  assertDirectoryContainment(runDir, runDir);

  const results: ScannedFile[] = [];

  // Known extension subdirectories.
  const subdirs: Array<{ dir: string; type: ExtensionFileType; version: number }> = [
    { dir: "repair-packets", type: "repair_packet", version: 1 },
    { dir: "diagnoses", type: "diagnosis", version: 1 },
    { dir: "clusters", type: "issue_cluster", version: 1 },
    { dir: "counterfactuals", type: "counterfactual", version: 1 },
  ];

  for (const { dir, type, version } of subdirs) {
    const dirPath = join(runDir, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      if (file.startsWith(".")) continue;
      const relativePath = `${dir}/${file}`;
      const absolutePath = join(runDir, relativePath);
      assertFileContainment(runDir, absolutePath);
      const content = await readFile(absolutePath, "utf-8");
      results.push({
        relativePath,
        absolutePath,
        type,
        version,
        sha256: sha256(content),
      });
    }
  }

  // Known single-file extension artifacts.
  const singles: Array<{ file: string; type: ExtensionFileType; version: number }> = [
    { file: "calibration-artifact.json", type: "calibration_artifact", version: 1 },
    { file: "candidate-registry.json", type: "candidate_registry", version: 1 },
    { file: "promotion-approval.json", type: "promotion_approval", version: 1 },
    { file: "rca-benchmark.json", type: "rca_benchmark", version: 1 },
  ];

  for (const { file, type, version } of singles) {
    const absolutePath = join(runDir, file);
    try {
      assertFileContainment(runDir, absolutePath);
      const content = await readFile(absolutePath, "utf-8");
      results.push({
        relativePath: file,
        absolutePath,
        type,
        version,
        sha256: sha256(content),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// §6 Reading the existing chain
// ---------------------------------------------------------------------------

/**
 * Read and validate an entire revision chain. Returns the ordered list
 * of verified revisions and the merged index.
 *
 * Validation checks:
 *  - Revisions are numbered 1, 2, 3, … contiguously (no gaps).
 *  - Each revision's integritySha256 matches its canonical content.
 *  - Each revision's previousRevisionSha256 matches the previous
 *    revision's integritySha256 (chain link).
 *  - All revisions share the same runId and sourceIntegrityRootSha256.
 *  - No duplicate relativePath across revisions.
 *  - All revision files pass path containment.
 *
 * Returns null when no revision files exist.
 */
export async function readExtensionChain(
  runDir: string,
  expectedSourceIntegrityRootSha256: string,
): Promise<{
  revisions: ExtensionRevision[];
  mergedIndex: ExtensionIntegrityIndex;
} | null> {
  // §0 Path containment on runDir.
  assertDirectoryContainment(runDir, runDir);

  const revisionNumbers = await listRevisionFiles(runDir);
  if (revisionNumbers.length === 0) return null;

  // §1 Verify contiguous numbering starting at 1.
  for (let i = 0; i < revisionNumbers.length; i += 1) {
    if (revisionNumbers[i] !== i + 1) {
      throw new EvaluationInfrastructureError(
        `extension integrity chain 不连续: 期望 revision ${i + 1}, 找到 revision ${revisionNumbers[i]}`,
      );
    }
  }

  // §2 Read and validate each revision.
  const revisions: ExtensionRevision[] = [];
  const seenPaths = new Set<string>();

  for (const revNum of revisionNumbers) {
    const revPath = revisionPath(runDir, revNum);
    assertFileContainment(runDir, revPath);

    const raw = await readFile(revPath, "utf-8");
    let revision: ExtensionRevision;
    try {
      revision = JSON.parse(raw) as ExtensionRevision;
    } catch (error) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum} JSON 解析失败: ${revPath}`,
      );
    }

    // Schema version check.
    if (revision.schemaVersion !== EXTENSION_INTEGRITY_SCHEMA_VERSION) {
      throw new EvaluationValidationError(
        `extension integrity revision ${revNum} schemaVersion ${String(revision.schemaVersion)} 不受支持; 当前支持 ${EXTENSION_INTEGRITY_SCHEMA_VERSION}`,
      );
    }

    // Revision number must match filename.
    if (revision.revisionNumber !== revNum) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum}: revisionNumber 字段为 ${revision.revisionNumber}, 与文件名不匹配`,
      );
    }

    // Issue #100 batch 4: validate revision object shape before traversing.
    // Any missing/extra/malformed key fails-closed.

    // runId: must be non-empty, legal chars, match runDir basename.
    if (typeof revision.runId !== "string" || !revision.runId) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum}: runId 缺失或非字符串`,
      );
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(revision.runId)) {
      throw new EvaluationValidationError(
        `extension integrity revision ${revNum}: runId "${revision.runId}" 含非法字符`,
      );
    }
    // runId must match the canonical basename of runDir.
    const runDirBasename = basename(runDir);
    if (revision.runId !== runDirBasename) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum}: runId "${revision.runId}" 与 runDir basename "${runDirBasename}" 不一致`,
      );
    }

    // sourceIntegrityRootSha256: must be 64 lowercase hex.
    if (typeof revision.sourceIntegrityRootSha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(revision.sourceIntegrityRootSha256)) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum}: sourceIntegrityRootSha256 不是合法的 SHA-256`,
      );
    }

    // generatedAt: must be a non-empty string.
    if (typeof revision.generatedAt !== "string" || !revision.generatedAt) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum}: generatedAt 缺失`,
      );
    }

    // entries: must be an array and non-empty.
    if (!Array.isArray(revision.entries)) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum}: entries 不是数组`,
      );
    }
    if (revision.entries.length === 0) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum}: entries 不能为空`,
      );
    }

    // Validate each entry.
    const FROZEN_EXTENSION_TYPES: ReadonlySet<string> = new Set([
      "repair_packet", "diagnosis", "issue_cluster", "counterfactual",
      "calibration_artifact", "candidate_registry", "promotion_approval",
      "rca_benchmark",
    ]);
    for (let ei = 0; ei < revision.entries.length; ei += 1) {
      const entry = revision.entries[ei]!;
      // relativePath: must be safe and non-empty.
      if (typeof entry.relativePath !== "string" || !entry.relativePath) {
        throw new EvaluationValidationError(
          `extension integrity revision ${revNum} entry ${ei}: relativePath 缺失`,
        );
      }
      if (!isSafeRelativePath(entry.relativePath)) {
        throw new EvaluationValidationError(
          `extension integrity revision ${revNum} entry ${ei}: 非法 relativePath "${entry.relativePath}"`,
        );
      }
      // sha256: must be 64 lowercase hex.
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new EvaluationInfrastructureError(
          `extension integrity revision ${revNum} entry ${ei}: sha256 不是合法的 SHA-256`,
        );
      }
      // type: must be in frozen allowlist.
      if (typeof entry.type !== "string" || !FROZEN_EXTENSION_TYPES.has(entry.type)) {
        throw new EvaluationValidationError(
          `extension integrity revision ${revNum} entry ${ei}: type "${String(entry.type)}" 不在冻结允许列表中`,
        );
      }
      // version: must be a supported positive integer.
      if (!Number.isInteger(entry.version) || entry.version < 1) {
        throw new EvaluationValidationError(
          `extension integrity revision ${revNum} entry ${ei}: version ${String(entry.version)} 不是正整数`,
        );
      }
    }

    // previousRevisionSha256: null for rev1, 64 hex for rev2+.
    if (revision.previousRevisionSha256 !== null
        && (typeof revision.previousRevisionSha256 !== "string"
            || !/^[a-f0-9]{64}$/.test(revision.previousRevisionSha256))) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum}: previousRevisionSha256 必须是 null 或 64 位 hex; 实际: ${String(revision.previousRevisionSha256)}`,
      );
    }

    // Integrity hash check.
    const { integritySha256: stored, ...canonical } = revision;
    const computed = sha256(stableStringify(canonical));
    if (computed !== stored) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum} 哈希不一致: ${revPath}`,
      );
    }

    // Chain link check.
    if (revNum === 1) {
      if (revision.previousRevisionSha256 !== null) {
        throw new EvaluationInfrastructureError(
          `extension integrity revision 1 的 previousRevisionSha256 必须为 null, 实际: ${String(revision.previousRevisionSha256)}`,
        );
      }
    } else {
      const prevRevision = revisions[revNum - 2]!;
      if (revision.previousRevisionSha256 !== prevRevision.integritySha256) {
        throw new EvaluationInfrastructureError(
          `extension integrity chain 断裂: revision ${revNum} 声称 previous=${revision.previousRevisionSha256}, ` +
          `但 revision ${revNum - 1} 的 integritySha256=${prevRevision.integritySha256}`,
        );
      }
    }

    // Anchor check.
    if (revision.sourceIntegrityRootSha256 !== expectedSourceIntegrityRootSha256) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum} sourceIntegrityRootSha256 不匹配: ` +
        `expected ${expectedSourceIntegrityRootSha256}, got ${revision.sourceIntegrityRootSha256}`,
      );
    }

    // RunId consistency across revisions.
    if (revisions.length > 0 && revision.runId !== revisions[0]!.runId) {
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revNum} runId "${revision.runId}" 与 revision 1 runId "${revisions[0]!.runId}" 不一致`,
      );
    }

    // No duplicate relativePath across revisions.
    for (const entry of revision.entries) {
      if (seenPaths.has(entry.relativePath)) {
        throw new EvaluationInfrastructureError(
          `extension integrity: 重复 relativePath "${entry.relativePath}" 出现在 revision ${revNum}`,
        );
      }
      seenPaths.add(entry.relativePath);

      // Validate entry: safe relative path.
      if (!isSafeRelativePath(entry.relativePath)) {
        throw new EvaluationValidationError(
          `extension integrity revision ${revNum}: 非法 relativePath "${entry.relativePath}"`,
        );
      }
    }

    revisions.push(revision);
  }

  // §3 Build the merged index.
  const allEntries: ExtensionRevisionEntry[] = [];
  for (const rev of revisions) {
    allEntries.push(...rev.entries);
  }
  allEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const tip = revisions[revisions.length - 1]!;
  const mergedIndex: ExtensionIntegrityIndex = {
    schemaVersion: EXTENSION_INTEGRITY_SCHEMA_VERSION,
    runId: tip.runId,
    sourceIntegrityRootSha256: tip.sourceIntegrityRootSha256,
    entries: allEntries,
    revisionCount: revisions.length,
    tipRevisionSha256: tip.integritySha256,
  };

  return { revisions, mergedIndex };
}

// ---------------------------------------------------------------------------
// §7 Check for orphan extension files (files without a trusted chain)
//
// Issue #100 batch A: if extension files exist on disk but no chain
// indexes them, showcase/repair must fail-closed.
// ---------------------------------------------------------------------------

/**
 * Scan for any extension files that look like they should be indexed.
 * Returns true when extension files exist on disk.
 */
async function extensionFilesExist(runDir: string): Promise<boolean> {
  const subdirs = ["repair-packets", "diagnoses", "clusters", "counterfactuals"];
  for (const dir of subdirs) {
    try {
      const files = await readdir(join(runDir, dir));
      if (files.some((f) => f.endsWith(".json") && !f.startsWith("."))) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Issue #100 batch 4: non-ENOENT errors (EACCES, EIO, etc.) must
      // NOT be silently swallowed. Fail-closed — an unreadable extension
      // directory is evidence of corruption.
      throw new EvaluationInfrastructureError(
        `extensionFilesExist: 无法读取目录 ${join(runDir, dir)}: ${(error as Error).message}`,
      );
    }
  }
  const singles = ["calibration-artifact.json", "candidate-registry.json", "promotion-approval.json", "rca-benchmark.json"];
  for (const file of singles) {
    try {
      await readFile(join(runDir, file), "utf-8");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Issue #100 batch 4: non-ENOENT errors must throw.
      throw new EvaluationInfrastructureError(
        `extensionFilesExist: 无法读取文件 ${join(runDir, file)}: ${(error as Error).message}`,
      );
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// §8 Building a new revision (append)
// ---------------------------------------------------------------------------

export interface AppendRevisionOptions {
  runId: string;
  runDir: string;
  sourceIntegrityRootSha256: string;
  generatedAt?: string;
}

/**
 * Build and publish a new revision IF there are extension files not yet
 * covered by the existing chain.
 *
 * Steps:
 *  1. Scan all extension files on disk.
 *  2. Read the existing chain to find already-indexed files.
 *  3. If no new files, return the existing chain (no new revision).
 *  4. Otherwise, build a new revision with only the new files.
 *  5. Atomically publish the new revision.
 *
 * Returns the merged index after the append (or existing if no new files).
 *
 * Issue #100 batch A: "extension publish success but registration failure
 * MUST NOT return success" — if we find extension files but fail to publish
 * the revision, we throw (fail-closed).
 */
export async function appendExtensionRevision(
  options: AppendRevisionOptions,
): Promise<ExtensionIntegrityIndex | null> {
  const { runId, runDir, sourceIntegrityRootSha256 } = options;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  // §1 Path containment.
  assertDirectoryContainment(runDir, runDir);
  assertRunDirBasenameConsistency(runDir, runId);

  // §2 Scan all extension files on disk.
  const scannedFiles = await scanExtensionFiles(runDir);

  // §3 Read existing chain to find already-indexed paths.
  const existingChain = await readExtensionChain(runDir, sourceIntegrityRootSha256);
  const indexedPaths = new Set<string>();
  if (existingChain) {
    for (const rev of existingChain.revisions) {
      for (const entry of rev.entries) {
        indexedPaths.add(entry.relativePath);
      }
    }
    // Verify runId consistency with existing chain.
    if (existingChain.mergedIndex.runId !== runId) {
      throw new EvaluationValidationError(
        `extension integrity: runId "${runId}" 与现有 chain runId "${existingChain.mergedIndex.runId}" 不一致`,
      );
    }
  }

  // §4 Identify new files.
  const newFiles = scannedFiles.filter((f) => !indexedPaths.has(f.relativePath));

  // §5 If no new files and chain exists, return the existing index.
  if (newFiles.length === 0) {
    if (existingChain) return existingChain.mergedIndex;
    // No chain and no files — valid null state.
    return null;
  }

  // §6 If extension files exist but no chain yet, check for orphan risk.
  // Having new files with no chain is the normal first-revision case.
  // But if there are ALSO already-indexed files (which shouldn't happen
  // without a chain), that's a corrupt state.
  if (!existingChain && indexedPaths.size > 0) {
    throw new EvaluationInfrastructureError(
      `extension integrity: 检测到已索引文件 (${indexedPaths.size} 个) 但没有 revision chain; 数据损坏`,
    );
  }

  // §7 Build the new revision entries.
  const newEntries: ExtensionRevisionEntry[] = newFiles.map((f) => ({
    relativePath: f.relativePath,
    sha256: f.sha256,
    type: f.type,
    version: f.version,
  }));
  newEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // §8 Determine revision number and previous SHA.
  const revisionNumber = existingChain ? existingChain.revisions.length + 1 : 1;
  const previousRevisionSha256 = existingChain
    ? existingChain.revisions[existingChain.revisions.length - 1]!.integritySha256
    : null;

  // §9 Build the revision.
  const revision: Omit<ExtensionRevision, "integritySha256"> = {
    schemaVersion: EXTENSION_INTEGRITY_SCHEMA_VERSION,
    revisionNumber,
    runId,
    sourceIntegrityRootSha256,
    previousRevisionSha256,
    generatedAt,
    entries: newEntries,
  };

  const integritySha256 = sha256(stableStringify(revision));
  const fullRevision: ExtensionRevision = { ...revision, integritySha256 };

  // §10 Atomically publish.
  await publishRevision(fullRevision, runDir);

  // §11 Re-read the chain to return the verified merged index.
  const verified = await readExtensionChain(runDir, sourceIntegrityRootSha256);
  if (!verified) {
    throw new EvaluationInfrastructureError(
      `extension integrity: revision ${revisionNumber} 发布后 chain 读取返回 null; 注册失败`,
    );
  }
  return verified.mergedIndex;
}

// ---------------------------------------------------------------------------
// §9 Atomic revision publish
// ---------------------------------------------------------------------------

async function publishRevision(revision: ExtensionRevision, runDir: string): Promise<string> {
  const revPath = revisionPath(runDir, revision.revisionNumber);
  const tempPath = join(
    runDir,
    `.extension-integrity.${String(revision.revisionNumber).padStart(4, "0")}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(revision, null, 2)}\n`;
  await writeFile(tempPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });

  try {
    await link(tempPath, revPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await rm(tempPath, { force: true });
      throw new EvaluationInfrastructureError(
        `extension integrity revision ${revision.revisionNumber} 拒绝覆盖已存在的 revision: ${revPath}`,
      );
    }
    // Publishing failed → clean up temp file.
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }

  return revPath;
}

// ---------------------------------------------------------------------------
// §10 Consumer API (backward-compatible with old readExtensionIntegrityIndex)
// ---------------------------------------------------------------------------

/**
 * Read and verify the extension integrity chain from a run directory.
 *
 * Returns null when:
 *  - No revision chain exists AND no extension files exist on disk
 *    (valid state for runs that haven't been diagnosed/calibrated).
 *
 * Throws (fail-closed) when:
 *  - Extension files exist on disk but no chain indexes them.
 *  - The chain is broken/gapped/forked/tampered.
 *  - Any path containment check fails.
 *  - The chain's runId does not match expectedRunId.
 *
 * Issue #100 batch 4: expectedRunId binds the chain to the canonical
 * run directory identity. Callers MUST pass the runId from the verified
 * artifact so a chain from run B cannot be loaded under run A's directory.
 */
export async function readExtensionIntegrityIndex(
  runDir: string,
  sourceIntegrityRootSha256: string,
  expectedRunId?: string,
): Promise<ExtensionIntegrityIndex | null> {
  // §0 Path containment.
  assertDirectoryContainment(runDir, runDir);

  const chain = await readExtensionChain(runDir, sourceIntegrityRootSha256);

  if (chain) {
    // Issue #100 batch 4: verify the chain's runId matches the expected
    // runId when provided. This prevents cross-run chain misidentification.
    if (expectedRunId !== undefined && chain.mergedIndex.runId !== expectedRunId) {
      throw new EvaluationInfrastructureError(
        `extension integrity: chain runId "${chain.mergedIndex.runId}" 与 expectedRunId "${expectedRunId}" 不一致`,
      );
    }
    return chain.mergedIndex;
  }

  // No chain exists. Check for orphan extension files.
  const orphans = await extensionFilesExist(runDir);
  if (orphans) {
    throw new EvaluationInfrastructureError(
      `extension integrity: 检测到 extension 文件但没有 trusted revision chain; ` +
      `请先通过 appendExtensionRevision 注册这些文件; runDir=${runDir}`,
    );
  }

  // No chain AND no extension files = valid null.
  return null;
}

/**
 * Verify and read a single extension file through the trusted chain.
 *
 * Issue #100 fix #1: all showcase/repair CLI consumers MUST consume
 * extension files through this verified path.
 */
export async function readVerifiedExtensionFile(
  index: ExtensionIntegrityIndex,
  runDir: string,
  relativePath: string,
): Promise<{ content: string; entry: ExtensionRevisionEntry }> {
  const entry = index.entries.find((e) => e.relativePath === relativePath);
  if (!entry) {
    throw new EvaluationValidationError(
      `extension file ${relativePath} 不在 verified extension integrity chain 中`,
    );
  }
  assertFileContainment(runDir, join(runDir, relativePath));
  const content = await readFile(join(runDir, relativePath), "utf-8");
  const actualHash = sha256(content);
  if (actualHash !== entry.sha256) {
    throw new EvaluationInfrastructureError(
      `extension file ${relativePath} 哈希不匹配: expected ${entry.sha256}, got ${actualHash}`,
    );
  }
  return { content, entry };
}

/**
 * Get the list of verified extension file entries of a given type.
 */
export function getExtensionEntriesByType(
  index: ExtensionIntegrityIndex | null,
  type: ExtensionFileType,
): ExtensionRevisionEntry[] {
  if (!index) return [];
  return index.entries.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// §11 Legacy compatibility — single-shot build & publish
//
// These preserve the old API surface used by diagnosis-runner.ts and
// calibration-runner.ts, which call buildExtensionIntegrityIndex +
// publishExtensionIntegrityIndex. Under the hood they now use the
// revision chain.
// ---------------------------------------------------------------------------

export interface BuildExtensionIndexOptions {
  runId: string;
  runDir: string;
  sourceIntegrityRootSha256: string;
  generatedAt?: string;
}

/**
 * Build and publish an extension revision covering all new extension
 * files. Equivalent to the old `buildExtensionIntegrityIndex` +
 * `publishExtensionIntegrityIndex`.
 *
 * Returns the merged index (all revisions). When no extension files
 * exist and no chain exists, returns a valid empty index that can
 * still be verified — publishExtensionIntegrityIndex is a no-op for
 * empty indices.
 */
export async function buildExtensionIntegrityIndex(
  options: BuildExtensionIndexOptions,
): Promise<ExtensionIntegrityIndex> {
  // Check existing chain first.
  const existing = await readExtensionChain(options.runDir, options.sourceIntegrityRootSha256);

  // Scan for extension files on disk.
  const files = await scanExtensionFiles(options.runDir);

  if (files.length === 0) {
    // No extension files on disk. Return existing chain if present,
    // otherwise return a valid empty index.
    if (existing) return existing.mergedIndex;
    return {
      schemaVersion: EXTENSION_INTEGRITY_SCHEMA_VERSION,
      runId: options.runId,
      sourceIntegrityRootSha256: options.sourceIntegrityRootSha256,
      entries: [],
      revisionCount: 0,
      tipRevisionSha256: "",
    };
  }

  // Append a new revision (or return existing if nothing new).
  const result = await appendExtensionRevision(options);
  if (!result) {
    // Should not happen: files exist but append returned null.
    // This means all files were already indexed (no new files).
    if (existing) return existing.mergedIndex;
    throw new EvaluationInfrastructureError(
      "extension integrity: appendExtensionRevision 返回 null 但有文件存在; 这是 bug",
    );
  }
  return result;
}

/**
 * Backward-compatible publish. When the index has 0 revisions (empty
 * extension index), this is a no-op — no revision files exist on disk
 * and none are published. When revisions exist, the latest was already
 * published by appendExtensionRevision, so this is also effectively a
 * no-op that returns the tip revision path.
 */
export async function publishExtensionIntegrityIndex(
  index: ExtensionIntegrityIndex,
  runDir: string,
): Promise<string> {
  if (index.revisionCount === 0) {
    // Empty index — no revision file to publish. This is valid.
    return revisionPath(runDir, 1); // Returns path that doesn't exist, but callers handle ENIENT.
  }
  // Revisions were already published by appendExtensionRevision.
  const revPath = revisionPath(runDir, index.revisionCount);
  return revPath;
}

/**
 * Verify a single revision file by path. Used for testing.
 */
export async function verifyExtensionIntegrityIndex(
  indexPath: string,
  expectedSourceIntegrityRootSha256: string,
): Promise<ExtensionIntegrityIndex> {
  // Derive runDir from indexPath.
  const runDir = indexPath.substring(0, indexPath.lastIndexOf("/extension-integrity."));
  if (!runDir || runDir === indexPath) {
    throw new EvaluationValidationError(`无法从 ${indexPath} 推导 runDir`);
  }
  return readExtensionIntegrityIndex(runDir, expectedSourceIntegrityRootSha256).then((result) => {
    if (!result) throw new EvaluationInfrastructureError(`extension integrity chain 为空: ${indexPath}`);
    return result;
  });
}

// ---------------------------------------------------------------------------
// §12 Helpers
// ---------------------------------------------------------------------------

const SAFE_RELATIVE_PATH = /^[a-zA-Z0-9_./-]+$/;

function isSafeRelativePath(path: string): boolean {
  if (!SAFE_RELATIVE_PATH.test(path)) return false;
  if (path.startsWith("/")) return false;
  if (path.split(/[\\/]/).includes("..")) return false;
  return true;
}
