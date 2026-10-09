import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { SessionStore } from "../../src/runtime/session-store.js";
import { handleGetRun } from "../../src/server/routes/get-run.js";
import type { RunContext } from "../../src/server/routes/utils.js";
import { createSkillIndex } from "../../src/skills/skill-index.js";
import { createRunState } from "../../src/types/run-state.js";

describe("project retrospective sidecar contract", () => {
  it("discovers the dedicated skill with only its declared tools", async () => {
    const index = await createSkillIndex();
    const skill = index.get("project-retrospective");

    expect(skill).toBeDefined();
    expect(skill!.allowedTools).toEqual([
      "get_workspace_state",
      "get_timeline_slice",
      "generate_retrospective",
    ]);
    expect(skill!.v2?.allowedEffects).toBe("advisory_only");
  });

  it("returns the persisted agent event id from GET /runs/:runId", async () => {
    const sessionStore = new SessionStore();
    const state = createRunState({
      runId: "run-retro",
      conversationId: "conv-retro",
      workspaceId: "workspace-1",
      projectId: "project-1",
      model: { provider: "mock", name: "mock-model" },
      maxSteps: 10,
      maxToolCalls: 20,
      timeoutMs: 120_000,
    });
    state.status = "completed";
    state.toolResults.push({
      toolCallId: "call-retro",
      toolName: "generate_retrospective",
      sideEffectStatus: "event_persisted",
      observation: "结构化项目复盘已保存到时间线。",
      agentEventId: "event-retro",
    });
    sessionStore.set(state.runId, state);

    const writeHead = vi.fn();
    const end = vi.fn();
    const response = { writeHead, end } as unknown as ServerResponse;
    await handleGetRun(
      {} as IncomingMessage,
      response,
      { runId: state.runId },
      { sessionStore } as RunContext,
    );

    expect(writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    const body = JSON.parse(String(end.mock.calls[0]![0]));
    expect(body.tool_results).toEqual([
      expect.objectContaining({
        tool_name: "generate_retrospective",
        side_effect_status: "event_persisted",
        agent_event_id: "event-retro",
      }),
    ]);
  });
});
