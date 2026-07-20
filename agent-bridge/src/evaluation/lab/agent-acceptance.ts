/**
 * T46-7 (Issue #100 §3.6) — Agent-first acceptance harness.
 *
 * Provides executable acceptance for three shell Coding Agent profiles:
 *   - Codex
 *   - Claude Code
 *   - Trae-equivalent shell agent
 *
 * Issue #100 §3.6 "Agent-first acceptance":
 *  "验收必须证明它们能从 repository-local Agent Skill / 自然语言映射中：
 *   - discover Evaluation Lab
 *   - validate
 *   - run 或启动 live preview
 *   - poll/status
 *   - verify artifact
 *   - 返回 Run Report 和 Repair Packet 路径
 *   不要用一段 LLM 自述冒充验收。使用确定性的 CLI/Skill contract
 *   fixtures、shell-driver 或等价的可执行 acceptance harness，并测试
 *   bounded JSON 输出和退出码。"
 *
 * Implementation:
 *  - Each profile has a deterministic natural-language → CLI command
 *    mapping (the "contract"). The contract is what an agent would
 *    interpret after reading the repository-local SKILL.md.
 *  - The harness executes each mapped command via `execFileSync`,
 *    capturing stdout/stderr/exit code.
 *  - For commands that produce JSON, the harness parses the output
 *    and verifies the expected bounded schema fields are present.
 *  - The harness NEVER invokes real LLM agents — it simulates them
 *    by running the CLI commands they would run.
 *  - All runs use `mock:mock-model` — paid models are never invoked.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";

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

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    name: "codex",
    displayName: "Codex",
    description: "OpenAI Codex shell agent profile (deterministic CLI driver)",
    skillMdPath: SKILL_MD_PATH,
    mappings: [
      {
        naturalLanguage: "discover evaluation lab",
        command: ["list", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["schemaVersion", "presets"],
      },
      {
        naturalLanguage: "validate evaluation config",
        command: ["validate", "--preset", "smoke", "--model", "mock:mock-model"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "valid"],
      },
      {
        naturalLanguage: "run smoke evaluation",
        command: ["run", "--preset", "smoke", "--model", "mock:mock-model", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "integrityRootSha256", "artifactPaths"],
      },
      {
        naturalLanguage: "poll run status",
        command: ["status", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "status"],
      },
      {
        naturalLanguage: "verify artifact integrity",
        command: ["verify", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "integrityRootSha256", "artifactPaths"],
      },
      {
        naturalLanguage: "show run report",
        command: ["show", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["runId", "status"],
      },
      {
        naturalLanguage: "produce repair packet",
        command: ["repair-packet", "<runId>", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["event"],
      },
    ],
  },
  {
    name: "claude-code",
    displayName: "Claude Code",
    description: "Anthropic Claude Code shell agent profile (deterministic CLI driver)",
    skillMdPath: SKILL_MD_PATH,
    mappings: [
      {
        naturalLanguage: "discover evaluation lab",
        command: ["list", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["schemaVersion", "presets"],
      },
      {
        naturalLanguage: "validate evaluation config",
        command: ["validate", "--preset", "smoke", "--model", "mock:mock-model"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "valid"],
      },
      {
        naturalLanguage: "run smoke evaluation",
        command: ["run", "--preset", "smoke", "--model", "mock:mock-model", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "integrityRootSha256", "artifactPaths"],
      },
      {
        naturalLanguage: "poll run status",
        command: ["status", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "status"],
      },
      {
        naturalLanguage: "verify artifact integrity",
        command: ["verify", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "integrityRootSha256", "artifactPaths"],
      },
      {
        naturalLanguage: "show run report",
        command: ["show", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["runId", "status"],
      },
      {
        naturalLanguage: "produce repair packet",
        command: ["repair-packet", "<runId>", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["event"],
      },
    ],
  },
  {
    name: "trae-equivalent",
    displayName: "Trae-equivalent shell agent",
    description: "Trae-equivalent shell agent profile (deterministic CLI driver)",
    skillMdPath: SKILL_MD_PATH,
    mappings: [
      {
        naturalLanguage: "discover evaluation lab",
        command: ["list", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["schemaVersion", "presets"],
      },
      {
        naturalLanguage: "validate evaluation config",
        command: ["validate", "--preset", "smoke", "--model", "mock:mock-model"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "valid"],
      },
      {
        naturalLanguage: "run smoke evaluation",
        command: ["run", "--preset", "smoke", "--model", "mock:mock-model", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "integrityRootSha256", "artifactPaths"],
      },
      {
        naturalLanguage: "poll run status",
        command: ["status", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "status"],
      },
      {
        naturalLanguage: "verify artifact integrity",
        command: ["verify", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["event", "runId", "integrityRootSha256", "artifactPaths"],
      },
      {
        naturalLanguage: "show run report",
        command: ["show", "<runId>"],
        expectedExitCode: 0,
        expectedJsonFields: ["runId", "status"],
      },
      {
        naturalLanguage: "produce repair packet",
        command: ["repair-packet", "<runId>", "--json"],
        expectedExitCode: 0,
        expectedJsonFields: ["event"],
      },
    ],
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
 * Run agent acceptance for one or all profiles. Issue #100 §3.6.
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

  // §5.1 Verify SKILL.md exists and compute its hash. The agent
  //      would read this file for discovery.
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

  // §5.2 Execute each step in sequence. The `run` step produces a
  //      runId that subsequent steps (status, verify, show,
  //      repair-packet) substitute into their command templates.
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
    if (mapping.naturalLanguage === "run smoke evaluation" && stepResult.passed) {
      const parsed = tryParseJson(stepResult.stdout);
      if (parsed && typeof parsed.runId === "string") {
        runId = parsed.runId;
      }
      // The run step's JSON output may be a sequence of events; look
      // for the `run_completed` event which carries `runId` and
      // `artifactPaths`. The CLI emits `artifactPaths` as an OBJECT
      // {runDirectory, manifest, report, integrity}, NOT an array.
      if (!runId) {
        const lines = stepResult.stdout.split("\n").filter((l) => l.trim().startsWith("{"));
        for (const line of lines) {
          const event = tryParseJson(line);
          if (event && typeof event.runId === "string" && event.event === "run_completed") {
            runId = event.runId;
            const paths = event.artifactPaths;
            if (paths && typeof paths === "object" && !Array.isArray(paths)) {
              const ap = paths as Record<string, unknown>;
              if (typeof ap.report === "string") runReportPath = ap.report;
              if (typeof ap.runDirectory === "string") runDir = ap.runDirectory;
            }
            break;
          }
        }
      } else if (parsed) {
        // runId came from the top-level object; still try to recover
        // artifactPaths from the same object (some CLI commands emit
        // a single JSON object instead of an event stream).
        const paths = (parsed as Record<string, unknown>).artifactPaths;
        if (paths && typeof paths === "object" && !Array.isArray(paths)) {
          const ap = paths as Record<string, unknown>;
          if (typeof ap.report === "string") runReportPath = ap.report;
          if (typeof ap.runDirectory === "string") runDir = ap.runDirectory;
        }
      }
    }
    // Capture repair packet path from the `repair-packet` step.
    // The repair-packet CLI emits either:
    //   { event: "repair_packets_list", runId, packetIds: string[] }
    //   { event: "repair_packet_prompt", runId, packetId, ... }
    // The repair packet file lives at <runDir>/repair-packets/<packetId>.json.
    if (mapping.naturalLanguage === "produce repair packet" && stepResult.passed) {
      const lines = stepResult.stdout.split("\n").filter((l) => l.trim().startsWith("{"));
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
            repairPacketPath = join(runDir, "repair-packets", `${packetId}.json`);
          } else {
            // Fall back to the canonical artifacts path layout when
            // the run_completed event did not carry runDirectory.
            repairPacketPath = join("agent-bridge", "artifacts", runId ?? "unknown", "repair-packets", `${packetId}.json`);
          }
          break;
        }
      }
    }
  }

  const completedAt = now();
  const durationMs = Date.now() - startedMs;
  const passed = skillMdPresent && steps.every((s) => s.passed);

  const result: Omit<AgentAcceptanceResult, "integritySha256"> = {
    schemaVersion: AGENT_ACCEPTANCE_SCHEMA_VERSION,
    profile: profile.name,
    displayName: profile.displayName,
    passed,
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

  // §6.1 Verify exit code matches expected.
  const exitCodeMatches = exitCode === mapping.expectedExitCode;

  // §6.2 Verify expected JSON fields. Many CLI commands (validate,
  // status, show, verify) output JSON natively without a --json flag;
  // the harness verifies expected fields whenever they are declared.
  const expectsJson = Boolean(mapping.expectedJsonFields && mapping.expectedJsonFields.length > 0);
  const jsonFieldsPresent: string[] = [];
  const jsonFieldsMissing: string[] = [];
  if (expectsJson && mapping.expectedJsonFields) {
    // The CLI may emit multiple JSON lines (event stream). We check
    // that at least one line contains all expected fields.
    const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    let allFieldsFound = false;
    for (const line of lines) {
      const parsed = tryParseJson(line);
      if (!parsed) continue;
      const present = mapping.expectedJsonFields.filter((field) => field in parsed);
      if (present.length > jsonFieldsPresent.length) {
        jsonFieldsPresent.length = 0;
        jsonFieldsPresent.push(...present);
      }
      if (mapping.expectedJsonFields.every((field) => field in parsed)) {
        allFieldsFound = true;
        break;
      }
    }
    jsonFieldsMissing.push(...mapping.expectedJsonFields.filter((f) => !jsonFieldsPresent.includes(f)));
    if (!allFieldsFound) {
      // Even if not all fields are in a single line, the step fails
      // unless the expected fields are distributed across events
      // (e.g., run_started + run_completed). We treat the union of
      // all event fields as the "output schema".
      if (jsonFieldsMissing.length > 0 && lines.length > 0) {
        // For event-stream commands, accept union of fields across
        // all events as the bounded schema.
        const unionFields = new Set<string>();
        for (const line of lines) {
          const parsed = tryParseJson(line);
          if (parsed && typeof parsed === "object") {
            for (const key of Object.keys(parsed)) unionFields.add(key);
          }
        }
        const stillMissing = mapping.expectedJsonFields.filter((f) => !unionFields.has(f));
        jsonFieldsMissing.length = 0;
        jsonFieldsMissing.push(...stillMissing);
        if (stillMissing.length === 0) {
          // Union covers all expected fields — accept and update
          // `jsonFieldsPresent` so the reported "present" fields
          // reflect the union, not just one line's fields. Without
          // this update, `jsonFieldsPresent` would underreport the
          // fields actually present in the output, producing a
          // misleading step record even though the step passed.
          jsonFieldsPresent.length = 0;
          jsonFieldsPresent.push(...mapping.expectedJsonFields.filter((f) => unionFields.has(f)));
        }
      }
    }
  }

  const jsonValid = !expectsJson || !mapping.expectedJsonFields || jsonFieldsMissing.length === 0;
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
