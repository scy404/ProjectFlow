import { describe, expect, it } from "vitest";

import { deriveTrustState, resolveEvidenceRefs } from "@/lib/evidence-resolver";
import type { AgentEvent, ProjectState } from "@/lib/types";

const state = {
  project: { id: "project-1", name: "可信项目" },
  resources: [{ id: "resource-1", title: "访谈记录" }],
  tasks: [{ id: "task-1", title: "验证导航假设" }],
  stages: [{ id: "stage-1", name: "验证阶段" }],
  risks: [],
  action_cards: [],
  assignment_proposals: [],
  members: [],
} as unknown as ProjectState;

describe("resolveEvidenceRefs", () => {
  it("resolves only entities present in the visible project state", () => {
    const resolved = resolveEvidenceRefs([
      {
        entity_type: "resource",
        entity_id: "resource-1",
        field: "validation_result",
        value: "3/5 用户反馈一致",
      },
    ], state);

    expect(resolved[0]).toMatchObject({
      status: "resolved",
      entityLabel: "访谈记录",
      field: "验证结果",
    });
  });

  it("does not expose raw ids for deleted or invisible evidence", () => {
    const resolved = resolveEvidenceRefs([
      {
        entity_type: "resource",
        entity_id: "secret-resource-id",
        field: "status",
        value: "private",
      },
    ], state);

    expect(resolved[0].status).toBe("unavailable");
    expect(JSON.stringify(resolved[0])).not.toContain("secret-resource-id");
  });
});

describe("deriveTrustState", () => {
  it("keeps repaired and fallback generation distinguishable without percentages", () => {
    const event = {
      id: "event-1",
      project_id: "project-1",
      workspace_id: "workspace-1",
      event_type: "breakdown",
      status: "repaired",
      input_snapshot: {},
      output_snapshot: { tasks: [] },
      reasoning_summary: "Schema repaired before persistence.",
      user_confirmed: false,
      created_at: "2026-10-08T00:00:00Z",
    } satisfies AgentEvent;
    expect(deriveTrustState({
      event,
      proposalStatus: "pending",
      unknowns: ["真实样本量"],
    })).toEqual({
      outputMode: "structured",
      generationStatus: "repaired",
      proposalStatus: "pending",
      unknownCount: 1,
    });
  });
});
