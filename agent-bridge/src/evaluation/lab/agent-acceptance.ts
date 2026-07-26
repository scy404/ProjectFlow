/**
 * T46-7 (Issue #100 §3.6) — Shell contract acceptance harness.
 *
 * THIS IS NOT REAL CODEX/CLAUDE CODE/TRAE AGENT ACCEPTANCE. The harness
 * runs deterministic CLI command mappings that simulate what each agent
 * WOULD run after reading the repository-local SKILL.md. No real LLM
 * agent is invoked — all runs use `mock:mock-model`.
 *
 * The output carries `shellContractPassed: true/false` and
 * `realAgentEvidence: false` so no consumer mistakes this for actual
 * Codex, Claude Code, or Trae agent acceptance.
 *
 * Provides executable contract verification for three shell agent
 * profiles: codex, claude-code, trae-equivalent. Each has an
 * INDEPENDENT adapter command mapping (profile mappings differ by
 * natural-language descriptions and whether `--json` is used on commands
 * that accept it — the base commands are always canonical CLI syntax).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";
import { EvaluationArtifactStore } from "./artifact-store.js";
import { buildProvenance } from "./validation.js";
import type { EvaluationArtifact, RunManifest, ScenarioContract } from "./contract.js";
import { EVALUATION_SCHEMA_VERSION } from "./contract.js";

// ---------------------------------------------------------------------------
// §1 Constants
// ---------------------------------------------------------------------------

export const AGENT_ACCEPTANCE_SCHEMA_VERSION = 1 as const;
export const EVAL_LAB_SCRIPT = "scripts/eval-lab";
export const SKILL_MD_PATH = ".agents/skills/evaluation-lab/SKILL.md";

// ---------------------------------------------------------------------------
// §2 Profile definitions
// ---------------------------------------------------------------------------

export type AgentProfileName = "codex" | "claude-code" | "trae-equivalent";

export interface AgentProfile {
  name: AgentProfileName;
  displayName: string;
  description: string;
  /** Path to the SKILL.md file the profile reads for discovery. */
  skillMdPath: string;
  /** Natural-language → CLI command mapping (the "contract"). */
  mappings: Array<{
    naturalLanguage: string;
    command: string[];
    expectedExitCode: number;
    expectedJsonFields?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// §2.1 Canonical command primitives
//
// These are the ONLY CLI argument forms the eval-lab CLI accepts. Each
// profile adapter builds its mappings from these primitives — the
// difference is in natural-language descriptions and whether `--json` is
// added to commands that accept it (`run`, `repair-packet`). No profile
// may invent flags that the CLI does not support.
// ---------------------------------------------------------------------------

type CanonicalCommand =
  | "list"
  | "validate"
  | "run"
  | "status"
  | "show"
  | "verify"
  | "repair_packet_list";

interface CanonicalPrimitive {
  command: string[];
  expectedExitCode: number;
  expectedJsonFields: string[];
  /** Whether the `--json` flag is accepted by this command. */
  acceptsJsonFlag: boolean;
}

const CANONICAL: Record<CanonicalCommand, CanonicalPrimitive> = {
  list: {
    command: ["list"],
    expectedExitCode: 0,
    expectedJsonFields: ["schemaVersion", "presets"],
    acceptsJsonFlag: false,
  },
  validate: {
    command: ["validate", "--preset", "smoke", "--model", "mock:mock-model"],
    expectedExitCode: 0,
    expectedJsonFields: ["event", "valid"],
    acceptsJsonFlag: false,
  },
  run: {
    command: ["run", "--preset", "smoke", "--model", "mock:mock-model"],
    expectedExitCode: 0,
    expectedJsonFields: ["event", "runId", "integrityRootSha256", "artifactPaths"],
    acceptsJsonFlag: true,
  },
  status: {
    command: ["status", "<runId>"],
    expectedExitCode: 0,
    expectedJsonFields: ["event", "runId", "status"],
    acceptsJsonFlag: false,
  },
  show: {
    command: ["show", "<runId>"],
    expectedExitCode: 0,
    expectedJsonFields: ["runId", "status"],
    acceptsJsonFlag: false,
  },
  verify: {
    command: ["verify", "<runId>"],
    expectedExitCode: 0,
    expectedJsonFields: ["event", "runId", "integrityRootSha256", "artifactPaths"],
    acceptsJsonFlag: false,
  },
  repair_packet_list: {
    command: ["repair-packet", "<runId>"],
    expectedExitCode: 0,
    expectedJsonFields: ["event", "runId"],
    acceptsJsonFlag: true,
  },
};

/**
 * Apply canonical primitive with optional `--json` flag.
 * Returns a copy — never mutates the canonical.
 */
function cmd(primitive: CanonicalPrimitive, withJson: boolean): string[] {
  if (withJson && primitive.acceptsJsonFlag) {
    return [...primitive.command, "--json"];
  }
  return [...primitive.command];
}

// ---------------------------------------------------------------------------
// §2.2 Independent adapter mappings
//
// Each builder returns a mappings array for its profile. The commands
// all use canonical CLI syntax; profiles differ in:
//   - Natural-language descriptions
//   - Whether `--json` is passed to commands that accept it
// ---------------------------------------------------------------------------

function buildCodexAdapterMappings(): AgentProfile["mappings"] {
  return [
    {
      naturalLanguage: "discover evaluation lab capabilities and presets",
      command: cmd(CANONICAL.list, false),
      expectedExitCode: CANONICAL.list.expectedExitCode,
      expectedJsonFields: CANONICAL.list.expectedJsonFields,
    },
    {
      naturalLanguage: "validate evaluation configuration for smoke preset",
      command: cmd(CANONICAL.validate, false),
      expectedExitCode: CANONICAL.validate.expectedExitCode,
      expectedJsonFields: CANONICAL.validate.expectedJsonFields,
    },
    {
      naturalLanguage: "run smoke evaluation with streaming JSON progress",
      command: cmd(CANONICAL.run, true),
      expectedExitCode: CANONICAL.run.expectedExitCode,
      expectedJsonFields: CANONICAL.run.expectedJsonFields,
    },
    {
      naturalLanguage: "poll evaluation run status",
      command: cmd(CANONICAL.status, false),
      expectedExitCode: CANONICAL.status.expectedExitCode,
      expectedJsonFields: CANONICAL.status.expectedJsonFields,
    },
    {
      naturalLanguage: "read evaluation run report",
      command: cmd(CANONICAL.show, false),
      expectedExitCode: CANONICAL.show.expectedExitCode,
      expectedJsonFields: CANONICAL.show.expectedJsonFields,
    },
    {
      naturalLanguage: "verify evaluation artifact integrity",
      command: cmd(CANONICAL.verify, false),
      expectedExitCode: CANONICAL.verify.expectedExitCode,
      expectedJsonFields: CANONICAL.verify.expectedJsonFields,
    },
    {
      naturalLanguage: "list repair packets via JSON contract",
      command: cmd(CANONICAL.repair_packet_list, true),
      expectedExitCode: CANONICAL.repair_packet_list.expectedExitCode,
      expectedJsonFields: CANONICAL.repair_packet_list.expectedJsonFields,
    },
  ];
}

function buildClaudeCodeAdapterMappings(): AgentProfile["mappings"] {
  return [
    {
      naturalLanguage: "list presets",
      command: cmd(CANONICAL.list, false),
      expectedExitCode: CANONICAL.list.expectedExitCode,
      expectedJsonFields: CANONICAL.list.expectedJsonFields,
    },
    {
      naturalLanguage: "validate config",
      command: cmd(CANONICAL.validate, false),
      expectedExitCode: CANONICAL.validate.expectedExitCode,
      expectedJsonFields: CANONICAL.validate.expectedJsonFields,
    },
    {
      naturalLanguage: "run smoke",
      command: cmd(CANONICAL.run, false),
      expectedExitCode: CANONICAL.run.expectedExitCode,
      expectedJsonFields: CANONICAL.run.expectedJsonFields,
    },
    {
      naturalLanguage: "check status",
      command: cmd(CANONICAL.status, false),
      expectedExitCode: CANONICAL.status.expectedExitCode,
      expectedJsonFields: CANONICAL.status.expectedJsonFields,
    },
    {
      naturalLanguage: "show report",
      command: cmd(CANONICAL.show, false),
      expectedExitCode: CANONICAL.show.expectedExitCode,
      expectedJsonFields: CANONICAL.show.expectedJsonFields,
    },
    {
      naturalLanguage: "verify integrity",
      command: cmd(CANONICAL.verify, false),
      expectedExitCode: CANONICAL.verify.expectedExitCode,
      expectedJsonFields: CANONICAL.verify.expectedJsonFields,
    },
    {
      naturalLanguage: "list repair packets",
      command: cmd(CANONICAL.repair_packet_list, false),
      expectedExitCode: CANONICAL.repair_packet_list.expectedExitCode,
      expectedJsonFields: CANONICAL.repair_packet_list.expectedJsonFields,
    },
  ];
}

function buildTraeEquivalentAdapterMappings(): AgentProfile["mappings"] {
  return [
    {
      naturalLanguage: "discover available evaluation presets",
      command: cmd(CANONICAL.list, false),
      expectedExitCode: CANONICAL.list.expectedExitCode,
      expectedJsonFields: CANONICAL.list.expectedJsonFields,
    },
    {
      naturalLanguage: "validate preset configuration",
      command: cmd(CANONICAL.validate, false),
      expectedExitCode: CANONICAL.validate.expectedExitCode,
      expectedJsonFields: CANONICAL.validate.expectedJsonFields,
    },
    {
      naturalLanguage: "execute smoke evaluation run",
      command: cmd(CANONICAL.run, false),
      expectedExitCode: CANONICAL.run.expectedExitCode,
      expectedJsonFields: CANONICAL.run.expectedJsonFields,
    },
    {
      naturalLanguage: "query run status",
      command: cmd(CANONICAL.status, false),
      expectedExitCode: CANONICAL.status.expectedExitCode,
      expectedJsonFields: CANONICAL.status.expectedJsonFields,
    },
    {
      naturalLanguage: "retrieve run report",
      command: cmd(CANONICAL.show, false),
      expectedExitCode: CANONICAL.show.expectedExitCode,
      expectedJsonFields: CANONICAL.show.expectedJsonFields,
    },
    {
      naturalLanguage: "verify artifact integrity checksums",
      command: cmd(CANONICAL.verify, false),
      expectedExitCode: CANONICAL.verify.expectedExitCode,
      expectedJsonFields: CANONICAL.verify.expectedJsonFields,
    },
    {
      naturalLanguage: "list repair packets in JSON format",
      command: cmd(CANONICAL.repair_packet_list, true),
      expectedExitCode: CANONICAL.repair_packet_list.expectedExitCode,
      expectedJsonFields: CANONICAL.repair_packet_list.expectedJsonFields,
    },
  ];
}

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    name: "codex",
    displayName: "Codex",
    description: "OpenAI Codex shell agent profile — verbose, explicit JSON flags",
    skillMdPath: SKILL_MD_PATH,
    mappings: buildCodexAdapterMappings(),
  },
  {
    name: "claude-code",
    displayName: "Claude Code",
    description: "Anthropic Claude Code shell agent profile — concise, minimal flags",
    skillMdPath: SKILL_MD_PATH,
    mappings: buildClaudeCodeAdapterMappings(),
  },
  {
    name: "trae-equivalent",
    displayName: "Trae-equivalent shell agent",
    description: "Trae-equivalent shell agent profile — structured, JSON on repair-packet",
    skillMdPath: SKILL_MD_PATH,
    mappings: buildTraeEquivalentAdapterMappings(),
  },
];

// ---------------------------------------------------------------------------
// §3 Acceptance step result
// ---------------------------------------------------------------------------

export interface AcceptanceStepResult {
  stepId: string;
  naturalLanguage: string;
  command: string[];
  expectedExitCode: number;
  actualExitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
  failureReason: string | null;
  jsonFieldsPresent: string[];
  jsonFieldsMissing: string[];
  durationMs: number;
}

export interface AgentAcceptanceResult {
  schemaVersion: typeof AGENT_ACCEPTANCE_SCHEMA_VERSION;
  profile: AgentProfileName;
  displayName: string;
  /** Whether all deterministic CLI contract steps passed. */
  shellContractPassed: boolean;
  /**
   * Always `false`. This harness runs CLI commands only — no real
   * Codex, Claude Code, or Trae agent is invoked. The acceptance
   * verifies the CLI contract (shell commands the agent WOULD run),
   * not actual agent behavior.
   */
  realAgentEvidence: false;
  /** @deprecated Use shellContractPassed instead. */
  passed: boolean;
  skillMdPresent: boolean;
  skillMdSha256: string | null;
  steps: AcceptanceStepResult[];
  runId: string | null;
  runReportPath: string | null;
  repairPacketPath: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  integritySha256: string;
}

// ---------------------------------------------------------------------------
// §3.5 Known-fault chain types
// ---------------------------------------------------------------------------

export interface KnownFaultStepResult {
  step: string;
  passed: boolean;
  failureReason: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface KnownFaultChainResult {
  schemaVersion: typeof AGENT_ACCEPTANCE_SCHEMA_VERSION;
  chainType: "known_fault_diagnose_repair";
  /** Always false — no real agent. */
  realAgentEvidence: false;
  steps: KnownFaultStepResult[];
  shellContractPassed: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  integritySha256: string;
}

// ---------------------------------------------------------------------------
// §4 Entry point
// ---------------------------------------------------------------------------

export interface RunAgentAcceptanceOptions {
  /** Repository root containing CLAUDE.md. */
  projectRoot: string;
  /** Profile to run, or "all" for all three. */
  profile: AgentProfileName | "all";
  /** Optional ISO timestamp override (for tests). */
  now?: () => string;
  /** Optional override for the eval-lab script path. */
  evalLabScript?: string;
}

/**
 * Run agent acceptance for one or all profiles.
 *
 * The harness executes the deterministic CLI command sequence each
 * profile's natural-language mapping points to. Real LLM agents are
 * NEVER invoked — the harness simulates them by running the CLI
 * commands they would run after reading the SKILL.md.
 */
export async function runAgentAcceptance(
  options: RunAgentAcceptanceOptions,
): Promise<AgentAcceptanceResult[]> {
  const projectRoot = options.projectRoot;
  const now = options.now ?? (() => new Date().toISOString());
  const evalLabScript = options.evalLabScript ?? EVAL_LAB_SCRIPT;
  const profiles = options.profile === "all"
    ? AGENT_PROFILES
    : AGENT_PROFILES.filter((p) => p.name === options.profile);
  if (profiles.length === 0) {
    throw new EvaluationValidationError(`未知 agent profile: ${options.profile}`);
  }
  const results: AgentAcceptanceResult[] = [];
  for (const profile of profiles) {
    const result = await runSingleProfile(projectRoot, profile, now, evalLabScript);
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// §5 Single-profile execution
// ---------------------------------------------------------------------------

async function runSingleProfile(
  projectRoot: string,
  profile: AgentProfile,
  now: () => string,
  evalLabScript: string,
): Promise<AgentAcceptanceResult> {
  const startedAt = now();
  const startedMs = Date.now();

  // §5.1 Verify SKILL.md exists and compute its hash.
  const skillMdFullPath = resolve(projectRoot, profile.skillMdPath);
  const skillMdPresent = existsSync(skillMdFullPath);
  let skillMdSha256: string | null = null;
  if (skillMdPresent) {
    try {
      const content = readFileSync(skillMdFullPath, "utf-8");
      skillMdSha256 = sha256(content);
    } catch {
      skillMdSha256 = null;
    }
  }

  // §5.2 Execute each step in sequence.
  const steps: AcceptanceStepResult[] = [];
  let runId: string | null = null;
  let runDir: string | null = null;
  let runReportPath: string | null = null;
  let repairPacketPath: string | null = null;

  for (const mapping of profile.mappings) {
    const command = mapping.command.map((arg) => arg === "<runId>" ? (runId ?? "") : arg);
    // Skip steps that require a runId if we don't have one yet.
    if (command.includes("") && mapping.command.includes("<runId>") && !runId) {
      steps.push({
        stepId: `${profile.name}-${mapping.naturalLanguage.replace(/\s+/g, "_")}`,
        naturalLanguage: mapping.naturalLanguage,
        command: mapping.command,
        expectedExitCode: mapping.expectedExitCode,
        actualExitCode: null,
        stdout: "",
        stderr: "skipped: 前置 run 步骤未产出 runId",
        passed: false,
        failureReason: "missing_runId_prerequisite",
        jsonFieldsPresent: [],
        jsonFieldsMissing: mapping.expectedJsonFields ?? [],
        durationMs: 0,
      });
      continue;
    }
    const stepResult = await executeStep(projectRoot, evalLabScript, command, mapping, profile);
    steps.push(stepResult);
    // Capture runId from the `run` step's JSON output.
    // Detect the run step by command (first arg is "run"), not by NL string.
    if (mapping.command[0] === "run" && stepResult.passed) {
      runId = extractRunId(stepResult.stdout);
      if (runId) {
        const paths = extractArtifactPaths(stepResult.stdout);
        if (paths) {
          if (typeof paths.report === "string") runReportPath = paths.report;
          if (typeof paths.runDirectory === "string") runDir = paths.runDirectory;
        }
      }
    }
    // Capture repair packet path from the `repair-packet` step.
    if (mapping.command[0] === "repair-packet" && stepResult.passed) {
      repairPacketPath = extractRepairPacketPath(stepResult.stdout, runDir, runId);
    }
  }

  const completedAt = now();
  const durationMs = Date.now() - startedMs;
  const shellContractPassed = skillMdPresent && steps.every((s) => s.passed);

  const result: Omit<AgentAcceptanceResult, "integritySha256"> = {
    schemaVersion: AGENT_ACCEPTANCE_SCHEMA_VERSION,
    profile: profile.name,
    displayName: profile.displayName,
    shellContractPassed,
    realAgentEvidence: false,
    passed: shellContractPassed,
    skillMdPresent,
    skillMdSha256,
    steps,
    runId,
    runReportPath,
    repairPacketPath,
    startedAt,
    completedAt,
    durationMs,
  };
  const integritySha256 = sha256(stableStringify(result));
  return { ...result, integritySha256 };
}

// ---------------------------------------------------------------------------
// §6 Step execution
// ---------------------------------------------------------------------------

async function executeStep(
  projectRoot: string,
  evalLabScript: string,
  command: string[],
  mapping: AgentProfile["mappings"][number],
  profile: AgentProfile,
): Promise<AcceptanceStepResult> {
  const stepStartedMs = Date.now();
  const scriptPath = resolve(projectRoot, evalLabScript);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  try {
    const result = execFileSync("bash", [scriptPath, ...command], {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
    stdout = result;
    exitCode = 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    stdout = typeof err.stdout === "string" ? err.stdout : "";
    stderr = typeof err.stderr === "string" ? err.stderr : (err.message ?? String(error));
    exitCode = typeof err.status === "number" ? err.status : null;
  }

  const exitCodeMatches = exitCode === mapping.expectedExitCode;

  const expectsJson = Boolean(mapping.expectedJsonFields && mapping.expectedJsonFields.length > 0);
  const jsonFieldsPresent: string[] = [];
  const jsonFieldsMissing: string[] = [];
  if (expectsJson && mapping.expectedJsonFields) {
    const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    // Build union of all fields across all JSON lines.
    const unionFields = new Set<string>();
    for (const line of lines) {
      const parsed = tryParseJson(line);
      if (parsed && typeof parsed === "object") {
        for (const key of Object.keys(parsed)) unionFields.add(key);
      }
    }
    for (const field of mapping.expectedJsonFields) {
      if (unionFields.has(field)) {
        jsonFieldsPresent.push(field);
      } else {
        jsonFieldsMissing.push(field);
      }
    }
  }

  const jsonValid = !expectsJson || jsonFieldsMissing.length === 0;
  const passed = exitCodeMatches && jsonValid;
  const failureReason = !exitCodeMatches
    ? `exit_code_mismatch: expected ${mapping.expectedExitCode}, got ${exitCode ?? "null"}`
    : !jsonValid
      ? `json_fields_missing: ${jsonFieldsMissing.join(", ")}`
      : null;

  return {
    stepId: `${profile.name}-${mapping.naturalLanguage.replace(/\s+/g, "_")}`,
    naturalLanguage: mapping.naturalLanguage,
    command: mapping.command,
    expectedExitCode: mapping.expectedExitCode,
    actualExitCode: exitCode,
    stdout,
    stderr,
    passed,
    failureReason,
    jsonFieldsPresent,
    jsonFieldsMissing,
    durationMs: Date.now() - stepStartedMs,
  };
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// §6.1 Output parsing helpers
// ---------------------------------------------------------------------------

function extractRunId(stdout: string): string | null {
  // Try top-level JSON object.
  const parsed = tryParseJson(stdout);
  if (parsed && typeof parsed.runId === "string") {
    return parsed.runId;
  }
  // Try event stream: look for run_completed or run_started.
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (const line of lines) {
    const event = tryParseJson(line);
    if (event && typeof event.runId === "string" && event.event === "run_completed") {
      return event.runId;
    }
  }
  // Fallback: any line with a runId.
  for (const line of lines) {
    const event = tryParseJson(line);
    if (event && typeof event.runId === "string") {
      return event.runId;
    }
  }
  return null;
}

function extractArtifactPaths(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (const line of lines) {
    const event = tryParseJson(line);
    if (!event) continue;
    const paths = event.artifactPaths;
    if (paths && typeof paths === "object" && !Array.isArray(paths)) {
      return paths as Record<string, unknown>;
    }
  }
  return null;
}

function extractRepairPacketPath(
  stdout: string,
  runDir: string | null,
  runId: string | null,
): string | null {
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (const line of lines) {
    const event = tryParseJson(line);
    if (!event) continue;
    let packetId: string | null = null;
    if (event.event === "repair_packets_list"
        && Array.isArray(event.packetIds)
        && event.packetIds.length > 0
        && typeof event.packetIds[0] === "string") {
      packetId = event.packetIds[0];
    } else if (event.event === "repair_packet_prompt"
               && typeof event.packetId === "string") {
      packetId = event.packetId;
    }
    if (packetId) {
      if (runDir) {
        return join(runDir, "repair-packets", `${packetId}.json`);
      }
      return join("agent-bridge", "artifacts", runId ?? "unknown", "repair-packets", `${packetId}.json`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// §7 Result publisher (atomic, never overwrites)
// ---------------------------------------------------------------------------

/**
 * Atomically publish the agent acceptance results to a JSON file.
 * Uses the hard-link primitive so a partial write never replaces
 * an existing report.
 */
export async function publishAgentAcceptanceReport(
  results: AgentAcceptanceResult[],
  reportPath: string,
): Promise<string> {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(results, null, 2)}\n`;
  const tempPath = join(dirname(reportPath), `.${basename(reportPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tempPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  try {
    await link(tempPath, reportPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await rm(tempPath, { force: true });
      throw new EvaluationInfrastructureError(
        `agent acceptance report 拒绝覆盖已存在的报告: ${reportPath}`,
      );
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  return reportPath;
}

// ---------------------------------------------------------------------------
// §8 Known-fault chain (Issue #100 batch 2 — fixed)
//
// Creates an evaluator-owned, deterministically failing evaluation run,
// then executes the full diagnose → repair-packet → prompt chain via
// real `scripts/eval-lab` subprocess calls.
//
// Does NOT depend on Golden Core current failures.
// Does NOT call real/paid models (uses mock:mock-model).
// Does NOT pollute the formal preset/registry.
// ---------------------------------------------------------------------------

function runKnownFaultStep(
  projectRoot: string,
  evalLabScript: string,
  command: string[],
): { stdout: string; stderr: string; exitCode: number | null; durationMs: number } {
  const startedMs = Date.now();
  const scriptPath = resolve(projectRoot, evalLabScript);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  try {
    const result = execFileSync("bash", [scriptPath, ...command], {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    stdout = result;
    exitCode = 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    stdout = typeof err.stdout === "string" ? err.stdout : "";
    stderr = typeof err.stderr === "string" ? err.stderr : (err.message ?? String(error));
    exitCode = typeof err.status === "number" ? err.status : null;
  }
  return { stdout, stderr, exitCode, durationMs: Date.now() - startedMs };
}

/**
 * Build a minimal failing ScenarioContract for the known-fault chain.
 * Uses preset "smoke-v2" and scenario "answer-no-tool-v2" which exists
 * in the smoke-v2 preset (so `diagnose` can look it up). The scenario
 * includes a hard grader with privacy checks so fault profile matching
 * produces repair packets.
 */
function buildKnownFaultScenario(): ScenarioContract {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId: "answer-no-tool-v2",
    visible: {
      prompt: "你好，请介绍一下当前项目的进展。",
    },
    hidden: {
      expectedMode: "answer",
      maxLatencyMs: 5_000,
      tokenBudget: { maxInputTokens: 50_000, maxOutputTokens: 8_000 },
      maxRequestCount: 4,
    },
    hardGrader: {
      version: 1,
      viewer: { primaryUserId: "demo-user-001" },
      run: { finalStatus: "completed", maxSideEffects: 0 },
      readOnlyStatePurity: true,
      privacy: {
        forbidRawIdsInOutput: true,
      },
    },
  };
}

interface RunDirectoryLayout {
  runDir: string;
  artifactRunDir: string;
  tempDir: string;
}

/**
 * Run the deterministic known-fault diagnose-repair chain.
 *
 * Steps:
 *   1. Create a deterministic failing artifact (evaluator-owned).
 *   2. Diagnose the run via real CLI → must produce packets (packetCount>0).
 *   3. List repair packets via real CLI → must be non-empty.
 *   4. Select first indexed packet.
 *   5. Get repair packet prompt via real CLI → prompt must be non-empty.
 *   6. Empty packet ID negative guard → CLI must reject (passed=true).
 *   7. Unindexed packet ID negative guard → CLI must reject (passed=true).
 *
 * shellContractPassed = all 7 steps passed.
 */
export async function runKnownFaultChain(options: {
  projectRoot: string;
  evalLabScript?: string;
  now?: () => string;
}): Promise<KnownFaultChainResult> {
  const projectRoot = options.projectRoot;
  const now = options.now ?? (() => new Date().toISOString());
  const evalLabScript = options.evalLabScript ?? EVAL_LAB_SCRIPT;
  const startedAt = now();
  const startedMs = Date.now();
  const steps: KnownFaultStepResult[] = [];

  // ── Layout ──────────────────────────────────────────────────────────────
  const runId = `knownfault_${Date.now()}`;
  const layout = await createRunLayout(projectRoot, runId);

  try {
    // ── Step 1: Create deterministic failing artifact ─────────────────────
    await createFailingArtifact(projectRoot, layout);
    steps.push({
      step: "run_fixture",
      passed: true,
      failureReason: null,
      stdout: JSON.stringify({ event: "fixture_created", runId, runDir: layout.artifactRunDir }),
      stderr: "",
      exitCode: 0,
      durationMs: 0,
    });

    // ── Step 2: Diagnose ──────────────────────────────────────────────────
    {
      const { stdout, stderr, exitCode, durationMs } = runKnownFaultStep(
        projectRoot, evalLabScript,
        ["diagnose", runId, "--json"],
      );
      const exitedClean = exitCode === 0;
      let failureReason: string | null = null;
      let packetCount = 0;
      if (exitedClean) {
        const parsed = parseKnownFaultEvent(stdout);
        if (parsed && parsed.event === "diagnosis_completed" && typeof parsed.packetCount === "number") {
          packetCount = parsed.packetCount;
        }
        if (packetCount === 0) {
          failureReason = "diagnosis_completed 但 packetCount 为 0；需要至少 1 个 repair packet";
        }
      } else {
        failureReason = `exit_code_mismatch: expected 0, got ${exitCode ?? "null"}`;
      }
      steps.push({
        step: "diagnose",
        passed: exitedClean && packetCount > 0,
        failureReason,
        stdout,
        stderr,
        exitCode,
        durationMs,
      });
    }

    // ── Step 3: List repair packets ───────────────────────────────────────
    let packetIds: string[] = [];
    {
      const { stdout, stderr, exitCode, durationMs } = runKnownFaultStep(
        projectRoot, evalLabScript,
        ["repair-packet", runId, "--json"],
      );
      const exitedClean = exitCode === 0;
      let failureReason: string | null = null;
      if (exitedClean) {
        const parsed = parseKnownFaultEvent(stdout);
        if (parsed && parsed.event === "repair_packets_list" && Array.isArray(parsed.packetIds)) {
          packetIds = parsed.packetIds.filter((id: unknown): id is string => typeof id === "string");
        }
        if (packetIds.length === 0) {
          failureReason = "repair_packets_list 的 packetIds 为空";
        }
      } else {
        failureReason = `exit_code_mismatch: expected 0, got ${exitCode ?? "null"}`;
      }
      steps.push({
        step: "list_packets",
        passed: exitedClean && packetIds.length > 0,
        failureReason,
        stdout,
        stderr,
        exitCode,
        durationMs,
      });
    }

    // ── Step 4: Select first indexed packet ──────────────────────────────
    let selectedPacketId: string | null = null;
    if (packetIds.length === 0) {
      steps.push({
        step: "select_indexed_packet",
        passed: false,
        failureReason: "packet_list_empty",
        stdout: "",
        stderr: "repair packet 列表为空；无法选择 indexed packet",
        exitCode: null,
        durationMs: 0,
      });
    } else {
      selectedPacketId = packetIds[0]!;
      steps.push({
        step: "select_indexed_packet",
        passed: true,
        failureReason: null,
        stdout: JSON.stringify({ selectedPacketId, totalPackets: packetIds.length }),
        stderr: "",
        exitCode: 0,
        durationMs: 0,
      });
    }

    // ── Step 5: Get repair packet prompt ─────────────────────────────────
    if (!selectedPacketId) {
      steps.push({
        step: "repair_prompt",
        passed: false,
        failureReason: "missing_selected_packet",
        stdout: "",
        stderr: "前置步骤未产出 selectedPacketId",
        exitCode: null,
        durationMs: 0,
      });
    } else {
      const { stdout, stderr, exitCode, durationMs } = runKnownFaultStep(
        projectRoot, evalLabScript,
        ["repair-packet", runId, "--packet-id", selectedPacketId, "--json"],
      );
      const exitedClean = exitCode === 0;
      let failureReason: string | null = null;
      let promptNonEmpty = false;
      if (exitedClean) {
        const parsed = parseKnownFaultEvent(stdout);
        if (parsed && parsed.event === "repair_packet_prompt" && typeof parsed.prompt === "string" && parsed.prompt.length > 0) {
          promptNonEmpty = true;
        }
        if (!promptNonEmpty) {
          failureReason = "repair_packet_prompt 的 prompt 字段为空或缺失";
        }
      } else {
        failureReason = `exit_code_mismatch: expected 0, got ${exitCode ?? "null"}`;
      }
      steps.push({
        step: "repair_prompt",
        passed: exitedClean && promptNonEmpty,
        failureReason,
        stdout,
        stderr,
        exitCode,
        durationMs,
      });
    }

    // ── Step 6: Empty packet ID negative guard ────────────────────────────
    {
      const { stdout, stderr, exitCode, durationMs } = runKnownFaultStep(
        projectRoot, evalLabScript,
        ["repair-packet", runId, "--packet-id", ""],
      );
      const correctlyRejected = exitCode !== 0;
      steps.push({
        step: "empty_packet_id",
        // Negative guard: CLI MUST reject empty packet ID. If it does,
        // the guard passes (passed=true). If it unexpectedly succeeds,
        // the guard fails (passed=false).
        passed: correctlyRejected,
        failureReason: correctlyRejected
          ? null
          : `unexpected_success: empty packet ID was NOT rejected (exit code ${exitCode})`,
        stdout,
        stderr,
        exitCode,
        durationMs,
      });
    }

    // ── Step 7: Unindexed packet ID negative guard ────────────────────────
    {
      const { stdout, stderr, exitCode, durationMs } = runKnownFaultStep(
        projectRoot, evalLabScript,
        ["repair-packet", runId, "--packet-id", "nonexistent-packet-id"],
      );
      const correctlyRejected = exitCode !== 0;
      steps.push({
        step: "unindexed_packet_id",
        // Negative guard: CLI MUST reject unindexed packet ID.
        passed: correctlyRejected,
        failureReason: correctlyRejected
          ? null
          : `unexpected_success: unindexed packet ID was NOT rejected (exit code ${exitCode})`,
        stdout,
        stderr,
        exitCode,
        durationMs,
      });
    }
  } finally {
    // Cleanup the temp artifact directory.
    await rm(layout.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Build result ─────────────────────────────────────────────────────
  const completedAt = now();
  const durationMs = Date.now() - startedMs;

  // All 7 steps must pass. No slicing, no carve-outs for select/negative guards.
  const shellContractPassed = steps.every((s) => s.passed);

  const result: Omit<KnownFaultChainResult, "integritySha256"> = {
    schemaVersion: AGENT_ACCEPTANCE_SCHEMA_VERSION,
    chainType: "known_fault_diagnose_repair",
    realAgentEvidence: false,
    steps,
    shellContractPassed,
    startedAt,
    completedAt,
    durationMs,
  };
  const integritySha256 = sha256(stableStringify(result));
  return { ...result, integritySha256 };
}

// ---------------------------------------------------------------------------
// §8.1 Artifact creation helpers
// ---------------------------------------------------------------------------

async function createRunLayout(
  projectRoot: string,
  runId: string,
): Promise<RunDirectoryLayout> {
  const tempDir = await mkdtemp(join(tmpdir(), `knownfault-${runId}-`));
  const artifactRunDir = join(projectRoot, "agent-bridge", "artifacts", runId);
  return { runDir: artifactRunDir, artifactRunDir, tempDir };
}

/**
 * Create a deterministic failing evaluation artifact on disk.
 *
 * Uses the smoke-v2 preset's "answer-no-tool-v2" scenario. The artifact
 * has a FAILING grade with failure reasons that match the privacy fault
 * profile, ensuring `diagnose` produces at least one repair packet.
 *
 * The artifact is evaluator-owned and does NOT call real/paid models
 * or pollute the formal preset/registry.
 */
async function createFailingArtifact(
  projectRoot: string,
  layout: RunDirectoryLayout,
): Promise<void> {
  const scenario = buildKnownFaultScenario();
  const scenarios = [scenario];
  const provenance = await buildProvenance({ projectRoot, scenarios });

  const manifest: RunManifest = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId: basename(layout.artifactRunDir),
    preset: "smoke-v2",
    model: "mock:mock-model",
    createdAt: new Date().toISOString(),
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

  const store = new EvaluationArtifactStore(projectRoot, basename(layout.artifactRunDir), layout.tempDir);
  await store.initialize(manifest, false);

  // Construct a failing observation. The failures include "viewer" and
  // "privacy" tokens which match the privacy fault profile's symptom
  // matcher, ensuring the diagnosis pipeline produces repair packets.
  const observation = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId: scenario.scenarioId,
    timestamp: new Date().toISOString(),
    routedMode: "answer" as const,
    selectedSkills: [],
    evidence: [],
    terminalStatus: "completed" as const,
    latencyMs: 100,
    inputTokens: 10,
    outputTokens: 5,
    requestCount: 1,
    costs: {
      sutCost: { amountUsd: 0, source: "versioned_price_estimate" as const, countedAgainstSutCap: true },
      evaluatorModelCost: { amountUsd: 0, source: "versioned_price_estimate" as const, countedAgainstSutCap: false },
      codingAgentCost: { amountUsd: null, source: "unknown" as const, countedAgainstSutCap: false },
    },
    output: "test output",
  };

  const grade = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId: scenario.scenarioId,
    passed: false,
    routingPassed: true,
    outcomePassed: false,
    latencyPassed: true,
    privacyPassed: false,
    budgetPassed: true,
    failures: [
      "outcome_mismatch: expected answer but got unrelated output",
      "hard_grade_failed: privacy: raw_id_leak viewer_can_see_protected_data",
    ],
  };

  await store.publishCheckpoint(observation, grade);

  const baseArtifact: Omit<EvaluationArtifact, "evidenceRootSha256" | "integrityRootSha256"> = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId: basename(layout.artifactRunDir),
    preset: "smoke-v2",
    model: "mock:mock-model",
    status: "regression",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    observations: [observation],
    grades: [grade],
    summary: {
      passedCount: 0,
      failedCount: 1,
      passRate: 0,
      sutCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
      evaluatorModelCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
      codingAgentCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: false },
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalRequestCount: 1,
      wallTimeMs: 100,
    },
    provenance,
    artifactPaths: {
      runDirectory: layout.artifactRunDir,
      manifest: join(layout.artifactRunDir, "manifest.json"),
      report: join(layout.artifactRunDir, "report.json"),
      integrity: join(layout.artifactRunDir, "integrity.json"),
    },
  };

  await store.finalize(baseArtifact);
  await store.releaseLock();
}

function parseKnownFaultEvent(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (const line of lines) {
    const parsed = tryParseJson(line);
    if (parsed) return parsed;
  }
  return null;
}
