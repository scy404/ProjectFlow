/**
 * T46-7 (Issue #100) batch 2 — Versioned scenario metadata map.
 *
 * Explicit, versioned source of truth for capability domain and
 * scenario class classification. Replaces the heuristic
 * `inferCapabilityDomain()` / `inferScenarioClass()` functions
 * that guessed metadata from scenarioId substrings.
 *
 * Boundary invariants:
 *  - One entry per scenario — exactly one. No duplicates.
 *  - This covers ALL scenarios in demo/smoke/smoke-v2/full presets.
 *  - Golden Core scenarios carry their own metadata via the registry.
 *  - Unknown scenario IDs fail-closed (throw, never guess).
 *  - Schema version must be bumped when the map shape changes.
 */

import type { CapabilityDomain, ScenarioClass } from "./golden-core-contract.js";

export const SCENARIO_METADATA_SCHEMA_VERSION = 1;

export interface ScenarioMetadata {
  scenarioId: string;
  capabilityDomain: CapabilityDomain;
  scenarioClass: ScenarioClass;
}

/**
 * ALL non-Golden-Core scenarios with their authoritative capability
 * domain and scenario class. One entry per scenarioId — no duplicates.
 *
 * Coverage:
 *  - RELEASE_SCENARIOS (5): answer-no-tool, status-read, risk-proposal,
 *    planning, privacy
 *  - SMOKE_V2 scenarios (3): answer-no-tool-v2, plan-proposal-confirm,
 *    plan-proposal-reject
 *  - FULL/DEMO scenarios (12): multi-turn-controller-p0,
 *    skill-eval-project-planning-p0, + 10 runtime-fault-* scenarios
 */
export const NON_GOLDEN_CORE_SCENARIO_METADATA: ReadonlyArray<ScenarioMetadata> = [
  // ── RELEASE_SCENARIOS (smoke preset) ─────────────────────────────────

  {
    scenarioId: "answer-no-tool",
    capabilityDomain: "status-read",
    scenarioClass: "normal",
  },
  {
    scenarioId: "status-read",
    capabilityDomain: "status-read",
    scenarioClass: "normal",
  },
  {
    scenarioId: "risk-proposal",
    capabilityDomain: "checkin-risk-replan",
    scenarioClass: "normal",
  },
  {
    scenarioId: "planning",
    capabilityDomain: "stage-planning",
    scenarioClass: "normal",
  },
  {
    scenarioId: "privacy",
    capabilityDomain: "assignment",
    scenarioClass: "normal",
  },

  // ── SMOKE_V2 scenarios ───────────────────────────────────────────────

  {
    scenarioId: "answer-no-tool-v2",
    capabilityDomain: "status-read",
    scenarioClass: "normal",
  },
  {
    scenarioId: "plan-proposal-confirm",
    capabilityDomain: "stage-planning",
    scenarioClass: "normal",
  },
  {
    scenarioId: "plan-proposal-reject",
    capabilityDomain: "stage-planning",
    scenarioClass: "negative",
  },

  // ── FULL/DEMO scenarios ──────────────────────────────────────────────

  {
    scenarioId: "multi-turn-controller-p0",
    capabilityDomain: "stage-planning",
    scenarioClass: "multi-turn",
  },
  {
    scenarioId: "skill-eval-project-planning-p0",
    capabilityDomain: "stage-planning",
    scenarioClass: "normal",
  },

  // ── Runtime fault scenarios (full preset) ────────────────────────────

  {
    scenarioId: "runtime-fault-cancellation-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "negative",
  },
  {
    scenarioId: "runtime-fault-duplicate-terminal-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "negative",
  },
  {
    scenarioId: "runtime-fault-timeout-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "boundary",
  },
  {
    scenarioId: "runtime-fault-infrastructure-retry-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "boundary",
  },
  {
    scenarioId: "runtime-fault-agent-retry-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "boundary",
  },
  {
    scenarioId: "runtime-fault-invalid-arguments-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "negative",
  },
  {
    scenarioId: "runtime-fault-partial-results-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "boundary",
  },
  {
    scenarioId: "runtime-fault-checkpoint-resume-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "boundary",
  },
  {
    scenarioId: "runtime-fault-steering-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "boundary",
  },
  {
    scenarioId: "runtime-fault-idempotency-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "negative",
  },
  {
    scenarioId: "runtime-fault-contradictory-terminal-p0",
    capabilityDomain: "runtime-recovery-security",
    scenarioClass: "conflict",
  },
];

/**
 * Look up explicit scenario metadata by scenarioId.
 * Returns `undefined` when the scenario ID is not in the map.
 * Callers MUST throw on missing — heuristic guessing is forbidden.
 */
export function getScenarioMetadata(scenarioId: string): ScenarioMetadata | undefined {
  return NON_GOLDEN_CORE_SCENARIO_METADATA.find((m) => m.scenarioId === scenarioId);
}

/**
 * Assert no duplicate scenario IDs in the metadata map.
 * Called at module load time to fail-fast on any duplication.
 * Also called by tests to verify integrity.
 */
export function assertNoDuplicateMetadata(): void {
  const seen = new Set<string>();
  for (const entry of NON_GOLDEN_CORE_SCENARIO_METADATA) {
    if (seen.has(entry.scenarioId)) {
      throw new Error(
        `Duplicate scenario metadata entry: ${entry.scenarioId}`,
      );
    }
    seen.add(entry.scenarioId);
  }
}

// Fail-fast: verify no duplicates at module load time.
assertNoDuplicateMetadata();
