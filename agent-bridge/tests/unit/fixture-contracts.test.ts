/**
 * T46-100 — FixtureContract tests.
 *
 * Covers:
 *  - computeFixtureContractSha256 determinism and sensitivity
 *  - FIXTURE_CONTRACT_SHA256S coverage
 *  - FIXTURE_REPLAN_CONFLICT_DUPLICATE structure (discriminated step params)
 *  - verifyFixturePrecondition: positive (exactly one match)
 *  - verifyFixturePrecondition: negative (zero matches)
 *  - verifyFixturePrecondition: negative (two matches — ambiguous state)
 *  - verifyFixturePrecondition: multiple assertions
 *  - FixtureOperation excludes unimplemented operations
 *  - FixtureStep params are typed (no Record<string, unknown>)
 *  - fixturContractSha256 mandatory enforcement tests
 */

import { describe, expect, it } from "vitest";
import {
  FIXTURE_CONTRACTS,
  FIXTURE_CONTRACT_SHA256S,
  computeFixtureContractSha256,
  verifyFixturePrecondition,
  FIXTURE_REPLAN_CONFLICT_DUPLICATE,
} from "../../src/evaluation/lab/fixture-contracts.js";
import type {
  EvidenceSnapshot,
  ProposalFacts,
} from "../../src/evaluation/lab/contract-v2.js";

// ---------------------------------------------------------------------------
// Minimal valid EvidenceSnapshot for precondition testing.
// ---------------------------------------------------------------------------

function makeSnapshot(proposalFacts: ProposalFacts[]): EvidenceSnapshot {
  return {
    schema_version: 1,
    snapshot_id: "test-snapshot",
    captured_at: "2026-07-26T00:00:00Z",
    workspace_id: "ws-1",
    project_id: "proj-1",
    conversation_id: "conv-1",
    viewer_user_id: "user-1",
    run_id: "run-1",
    state_facts: {
      workspace_id: "ws-1",
      workspace_name: "test",
      project_id: "proj-1",
      project_name: "test",
      project_status: "active",
      project_current_stage_id: null,
      project_deadline: null,
      stage_count: 1,
      stages: [{ stage_id: "s1", name: "S1", status: "in_progress", order_index: 0 }],
      task_count: 1,
      tasks: [
        {
          task_id: "t1",
          title: "T1",
          status: "not_started",
          priority: "P0",
          stage_id: "s1",
          owner_user_id: null,
          backup_owner_user_id: null,
        },
      ],
      assignment_proposal_count: 0,
      assignment_proposals: [],
      member_count: 1,
      members: [{ user_id: "user-1", display_name: "User 1" }],
    },
    proposal_facts: proposalFacts,
    event_facts: [],
    memory_facts: [],
    conversation_facts: [],
    trajectory_facts: [],
    side_effect_facts: [],
    metric_facts: null,
    context_receipt_facts: null,
    hidden_field_probe_facts: null,
  };
}

function makeProposalFact(overrides: Partial<ProposalFacts> = {}): ProposalFacts {
  return {
    proposal_id: "prop-1",
    proposal_type: "replan",
    status: "pending",
    confirmed_by_present: false,
    confirmed_at_present: false,
    rejection_reason_present: false,
    payload_keys: ["tasks"],
    created_at: "2026-07-26T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeFixtureContractSha256
// ---------------------------------------------------------------------------

describe("computeFixtureContractSha256", () => {
  it("is deterministic — same input produces same hash", () => {
    const hash1 = computeFixtureContractSha256(FIXTURE_REPLAN_CONFLICT_DUPLICATE);
    const hash2 = computeFixtureContractSha256(FIXTURE_REPLAN_CONFLICT_DUPLICATE);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a fixture param is modified", () => {
    const original = computeFixtureContractSha256(FIXTURE_REPLAN_CONFLICT_DUPLICATE);
    const modified = structuredClone(FIXTURE_REPLAN_CONFLICT_DUPLICATE);
    // With discriminated types, workspace_id is typed on the params.
    (modified.steps[0]! as { operation: "pre_seed_pending_replan"; params: { workspace_id: string; project_id: string; summary: string } }).params.workspace_id = "different-workspace";
    const modifiedHash = computeFixtureContractSha256(modified);
    expect(modifiedHash).not.toBe(original);
  });

  it("changes when precondition proposalFacts changes", () => {
    const original = computeFixtureContractSha256(FIXTURE_REPLAN_CONFLICT_DUPLICATE);
    const modified = structuredClone(FIXTURE_REPLAN_CONFLICT_DUPLICATE);
    modified.precondition.proposalFacts[0]!.count = 2;
    const modifiedHash = computeFixtureContractSha256(modified);
    expect(modifiedHash).not.toBe(original);
  });

  it("changes when the description changes", () => {
    const original = computeFixtureContractSha256(FIXTURE_REPLAN_CONFLICT_DUPLICATE);
    const modified = { ...FIXTURE_REPLAN_CONFLICT_DUPLICATE, description: "modified description" };
    const modifiedHash = computeFixtureContractSha256(modified);
    expect(modifiedHash).not.toBe(original);
  });

  it("produces different hashes for different contracts", () => {
    const contract1 = FIXTURE_REPLAN_CONFLICT_DUPLICATE;
    const contract2 = { ...contract1, id: "fixture-different", description: "different fixture" };
    const hash1 = computeFixtureContractSha256(contract1);
    const hash2 = computeFixtureContractSha256(contract2);
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// FIXTURE_CONTRACT_SHA256S
// ---------------------------------------------------------------------------

describe("FIXTURE_CONTRACT_SHA256S", () => {
  it("covers every declared fixture contract", () => {
    for (const id of Object.keys(FIXTURE_CONTRACTS)) {
      expect(FIXTURE_CONTRACT_SHA256S[id]).toBeDefined();
      expect(FIXTURE_CONTRACT_SHA256S[id]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("has no extra entries beyond declared contracts", () => {
    const declared = Object.keys(FIXTURE_CONTRACTS);
    const sha256Keys = Object.keys(FIXTURE_CONTRACT_SHA256S);
    expect(sha256Keys.sort()).toEqual(declared.sort());
  });

  it("each entry matches computeFixtureContractSha256", () => {
    for (const [id, contract] of Object.entries(FIXTURE_CONTRACTS)) {
      const expected = computeFixtureContractSha256(contract);
      const actual = FIXTURE_CONTRACT_SHA256S[id];
      expect(actual, `SHA-256 mismatch for ${id}`).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// FIXTURE_REPLAN_CONFLICT_DUPLICATE structure
// ---------------------------------------------------------------------------

describe("FIXTURE_REPLAN_CONFLICT_DUPLICATE", () => {
  it("uses snake_case params matching the backend Pydantic model", () => {
    const step = FIXTURE_REPLAN_CONFLICT_DUPLICATE.steps[0]!;
    expect(step.operation).toBe("pre_seed_pending_replan");
    // With discriminated types, params are typed.
    const params = step.params;
    expect(params.workspace_id).toBeDefined();
    expect(params.project_id).toBeDefined();
    expect(params.summary).toBeDefined();
    // Must NOT contain camelCase variants on the typed params.
    expect((params as Record<string, unknown>).workspaceId).toBeUndefined();
    expect((params as Record<string, unknown>).projectId).toBeUndefined();
  });

  it("declares precondition with typed proposalFacts assertions", () => {
    const { evidenceQuery, proposalFacts } = FIXTURE_REPLAN_CONFLICT_DUPLICATE.precondition;
    expect(evidenceQuery.workspaceId).toBeDefined();
    expect(evidenceQuery.viewerUserId).toBeDefined();
    expect(evidenceQuery.projectId).toBeDefined();
    expect(proposalFacts).toHaveLength(1);
    expect(proposalFacts[0]!.proposal_type).toBe("replan");
    expect(proposalFacts[0]!.status).toBe("pending");
    expect(proposalFacts[0]!.count ?? 1).toBe(1);
  });

  it("has a well-formed schema version", () => {
    expect(FIXTURE_REPLAN_CONFLICT_DUPLICATE.schemaVersion).toBe(1);
    expect(FIXTURE_REPLAN_CONFLICT_DUPLICATE.id).toBeTruthy();
  });

  it("has only implemented operations (no pre_create_private_conversation)", () => {
    for (const step of FIXTURE_REPLAN_CONFLICT_DUPLICATE.steps) {
      expect(step.operation).toBe("pre_seed_pending_replan");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyFixturePrecondition
// ---------------------------------------------------------------------------

describe("verifyFixturePrecondition", () => {
  it("passes when exactly one matching proposal_fact exists (default count=1)", () => {
    const snapshot = makeSnapshot([
      makeProposalFact({ proposal_type: "replan", status: "pending" }),
    ]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [{ proposal_type: "replan", status: "pending" }],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("fails when zero matching proposal_facts exist", () => {
    const snapshot = makeSnapshot([
      makeProposalFact({ proposal_type: "plan", status: "pending" }),
    ]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [{ proposal_type: "replan", status: "pending" }],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("期望 proposal_type=replan status=pending 有 1 条，实际 0 条");
  });

  it("fails when two matching proposal_facts exist (ambiguous state)", () => {
    const snapshot = makeSnapshot([
      makeProposalFact({ proposal_id: "prop-1", proposal_type: "replan", status: "pending" }),
      makeProposalFact({ proposal_id: "prop-2", proposal_type: "replan", status: "pending" }),
    ]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [{ proposal_type: "replan", status: "pending" }],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("实际 2 条");
  });

  it("passes with explicit count when exactly that many exist", () => {
    const snapshot = makeSnapshot([
      makeProposalFact({ proposal_id: "prop-1", proposal_type: "replan", status: "pending" }),
      makeProposalFact({ proposal_id: "prop-2", proposal_type: "replan", status: "pending" }),
    ]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [{ proposal_type: "replan", status: "pending", count: 2 }],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(true);
  });

  it("fails when explicit count does not match", () => {
    const snapshot = makeSnapshot([
      makeProposalFact({ proposal_type: "replan", status: "pending" }),
    ]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [{ proposal_type: "replan", status: "pending", count: 2 }],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("实际 1 条");
  });

  it("passes with multiple assertions against different proposal types", () => {
    const snapshot = makeSnapshot([
      makeProposalFact({ proposal_id: "prop-1", proposal_type: "replan", status: "pending" }),
      makeProposalFact({ proposal_id: "prop-2", proposal_type: "clarify", status: "confirmed" }),
    ]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [
        { proposal_type: "replan", status: "pending" },
        { proposal_type: "clarify", status: "confirmed" },
      ],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(true);
  });

  it("fails when empty snapshot has no matching proposals", () => {
    const snapshot = makeSnapshot([]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [{ proposal_type: "replan", status: "pending" }],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("实际 0 条");
  });

  it("fails when status does not match even though proposal_type matches", () => {
    const snapshot = makeSnapshot([
      makeProposalFact({ proposal_type: "replan", status: "confirmed" }),
    ]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [{ proposal_type: "replan", status: "pending" }],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("实际 0 条");
  });

  it("returns multiple failures when multiple assertions fail", () => {
    const snapshot = makeSnapshot([]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [
        { proposal_type: "replan", status: "pending" },
        { proposal_type: "clarify", status: "confirmed" },
      ],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
  });

  it("only counts exact proposal_type + status matches", () => {
    // There's a replan/pending but also a replan/confirmed — only count the pending one.
    const snapshot = makeSnapshot([
      makeProposalFact({ proposal_id: "prop-1", proposal_type: "replan", status: "pending" }),
      makeProposalFact({ proposal_id: "prop-2", proposal_type: "replan", status: "confirmed" }),
      makeProposalFact({ proposal_id: "prop-3", proposal_type: "plan", status: "pending" }),
    ]);
    const precondition = {
      evidenceQuery: { workspaceId: "ws-1", viewerUserId: "user-1", projectId: "proj-1" },
      proposalFacts: [{ proposal_type: "replan", status: "pending" }],
    };
    const result = verifyFixturePrecondition(snapshot, precondition);
    expect(result.passed).toBe(true);
  });
});
