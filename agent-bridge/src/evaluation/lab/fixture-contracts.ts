/**
 * T46-100 S4 — Evaluator-owned executable FixtureContract.
 *
 * FixtureContracts declaratively describe what state the evaluator must
 * pre-seed before SUT execution. They are evaluation-only, instance/nonce-bound,
 * and their fingerprint is included in scenario/registry integrity.
 *
 * Design constraints:
 * - No arbitrary scripts, SQL, paths, or network targets
 * - Instance/nonce-bound access through the internal evaluation fixture API
 * - Precondition verified via evidence snapshot before SUT execution
 * - Fail-closed on missing/mismatch/precondition-violation
 */

export const FIXTURE_CONTRACT_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Discriminated step types — each operation has its own typed params.
// ---------------------------------------------------------------------------

/** Params for the pre_seed_pending_replan operation. */
export interface SeedReplanStepParams {
  workspace_id: string;
  project_id: string;
  summary: string;
}

/** Supported fixture operations. Each maps 1:1 to a backend evaluation fixture endpoint. */
export type FixtureOperation = "pre_seed_pending_replan";

/** Discriminated union of fixture steps. */
export type FixtureStep =
  | { operation: "pre_seed_pending_replan"; params: SeedReplanStepParams };

// ---------------------------------------------------------------------------
// Typed precondition — verified against a real EvidenceSnapshot before SUT.
// ---------------------------------------------------------------------------

/** An assertion against EvidenceSnapshot.proposal_facts. */
export interface FixtureProposalAssertion {
  /** Required proposal_type value. */
  proposal_type: string;
  /** Required status value. */
  status: string;
  /** Expected count of matching proposal_facts. Defaults to 1. */
  count?: number;
}

/** Precondition to verify after fixture execution and before SUT. */
export interface FixturePrecondition {
  /** Evidence snapshot query params. */
  evidenceQuery: {
    workspaceId: string;
    viewerUserId: string;
    projectId: string;
  };
  /** Assertions against EvidenceSnapshot.proposal_facts.
   *  Each assertion must match exactly `count` entries (default 1).
   *  Missing (0) or extra (>count) matches fail-closed. */
  proposalFacts: FixtureProposalAssertion[];
}

/** An evaluator-owned executable fixture contract. */
export interface FixtureContract {
  /** Stable fixture contract ID (used in scenario v3.fixtureContractId). */
  id: string;
  /** Schema version. */
  schemaVersion: typeof FIXTURE_CONTRACT_SCHEMA_VERSION;
  /** Human-readable description. */
  description: string;
  /** Ordered list of fixture steps to execute. */
  steps: FixtureStep[];
  /** Precondition to verify before SUT execution. */
  precondition: FixturePrecondition;
}

// ---------------------------------------------------------------------------
// Fixture contract registry
// ---------------------------------------------------------------------------

/** Pre-seed a pending replan proposal so the SUT encounters Proposal Uniqueness. */
export const FIXTURE_REPLAN_CONFLICT_DUPLICATE: FixtureContract = {
  id: "fixture-replan-conflict-duplicate",
  schemaVersion: FIXTURE_CONTRACT_SCHEMA_VERSION,
  description: "预置一个 pending replan 提案，使 SUT 遇到 Proposal Uniqueness 拒绝",
  steps: [
    {
      operation: "pre_seed_pending_replan",
      params: {
        workspace_id: "demo-workspace-001",
        project_id: "demo-project-001",
        summary: "评测夹具预置的计划调整提案",
      },
    },
  ],
  precondition: {
    evidenceQuery: {
      workspaceId: "demo-workspace-001",
      viewerUserId: "demo-user-001",
      projectId: "demo-project-001",
    },
    proposalFacts: [
      { proposal_type: "replan", status: "pending", count: 1 },
    ],
  },
};

/** Fixture contracts keyed by ID. */
export const FIXTURE_CONTRACTS: Record<string, FixtureContract> = {
  [FIXTURE_REPLAN_CONFLICT_DUPLICATE.id]: FIXTURE_REPLAN_CONFLICT_DUPLICATE,
};

/**
 * Lookup a fixture contract by ID. Returns undefined when the contract
 * is not declared — fail-closed: an undeclared fixture ID is a configuration
 * error and the scenario cannot be executed.
 */
export function getFixtureContract(id: string): FixtureContract | undefined {
  return FIXTURE_CONTRACTS[id];
}

import { sha256, stableStringify } from "./validation.js";
import type { EvidenceSnapshot } from "./contract-v2.js";

/**
 * Compute a stable SHA-256 over the full fixture contract payload.
 *
 * This fingerprint binds the canonical fixture into the scenario/registry
 * fingerprint. Changing fixture steps, params, precondition, or description
 * changes this hash, which changes the scenario fingerprint, which changes
 * the registry fingerprint — making fixture drift auditable.
 *
 * Only the content-bearing fields are hashed (id, schemaVersion, description,
 * steps, precondition). Computed or derived fields are excluded.
 */
export function computeFixtureContractSha256(contract: FixtureContract): string {
  return sha256(stableStringify({
    id: contract.id,
    schemaVersion: contract.schemaVersion,
    description: contract.description,
    steps: contract.steps,
    precondition: contract.precondition,
  }));
}

/** Pre-computed fixture contract SHA-256s, keyed by contract ID. */
export const FIXTURE_CONTRACT_SHA256S: Record<string, string> = Object.fromEntries(
  Object.entries(FIXTURE_CONTRACTS).map(([id, contract]) => [
    id,
    computeFixtureContractSha256(contract),
  ]),
);

/**
 * Verify fixture precondition against a real EvidenceSnapshot.
 *
 * Each assertion in {@link FixturePrecondition.proposalFacts} is checked
 * against the snapshot's proposal_facts. The count of matching proposals
 * must equal the assertion's expected count (default 1).
 *
 * This is a pure function — no side effects, no scenario-ID special cases.
 *
 * @returns { passed: boolean, failures: string[] }
 */
export function verifyFixturePrecondition(
  snapshot: EvidenceSnapshot,
  precondition: FixturePrecondition,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const assertion of precondition.proposalFacts) {
    const matches = snapshot.proposal_facts.filter(
      (p) => p.proposal_type === assertion.proposal_type && p.status === assertion.status,
    );
    const expected = assertion.count ?? 1;
    if (matches.length !== expected) {
      failures.push(
        `期望 proposal_type=${assertion.proposal_type} status=${assertion.status} ` +
        `有 ${expected} 条，实际 ${matches.length} 条`,
      );
    }
  }
  return { passed: failures.length === 0, failures };
}
