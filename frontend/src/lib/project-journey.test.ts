import { describe, expect, it } from "vitest";

import type { ProjectState } from "@/lib/types";
import { deriveProjectJourney, inferJourneyAgentFocus } from "@/lib/project-journey";

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    workspace: {
      workspace_id: "workspace-1",
      name: "测试工作区",
      owner_user_id: "user-1",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
    project: {
      id: "project-1",
      workspace_id: "workspace-1",
      name: "测试项目",
      idea: "验证项目旅程",
      deadline: "2027-06-01",
      deliverables: "可运行原型",
      project_template: "competition",
      is_demo: false,
      status: "active",
      direction_card: null,
      created_by: "user-1",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
    resources: [],
    members: [],
    memberships: [],
    member_profiles: [],
    projects: [],
    stages: [],
    tasks: [],
    agent_proposals: [],
    assignment_proposals: [],
    assignment_responses: [],
    assignment_negotiations: [],
    checkins: [],
    risks: [],
    action_cards: [],
    timeline: [],
    ...overrides,
  };
}

const directionCard = {
  problem: "项目目标不够明确",
  users: "参赛学生团队",
  value: "形成可执行方案",
  deliverables: ["原型"],
  boundaries: [],
  risks: [],
  suggested_questions: [],
};

const stage = {
  id: "stage-1",
  project_id: "project-1",
  name: "原型阶段",
  goal: "完成原型",
  start_date: "2026-10-01",
  end_date: "2026-11-01",
  deliverable: "原型",
  done_criteria: ["可演示"],
  status: "active" as const,
  order_index: 0,
};

function task(status: ProjectState["tasks"][number]["status"] = "not_started", owner = "user-1") {
  return {
    id: "task-1",
    project_id: "project-1",
    stage_id: "stage-1",
    title: "完成原型",
    description: "实现核心链路",
    priority: "P0" as const,
    status,
    owner_user_id: owner || null,
    due_date: "2026-11-01",
    estimated_hours: 8,
    dependency_ids: [],
    acceptance_criteria: ["可演示"],
    task_kind: "delivery" as const,
    can_cut: false,
    created_by_agent: true,
    order_index: 0,
    updated_at: "2026-10-01T00:00:00Z",
  };
}

function plannedState(status: ProjectState["tasks"][number]["status"] = "not_started") {
  const base = makeState();
  return makeState({
    project: { ...base.project, direction_card: directionCard },
    stages: [stage],
    tasks: [task(status)],
  });
}

describe("deriveProjectJourney", () => {
  it("uses persisted project facts and locks steps whose prerequisites are missing", () => {
    const journey = deriveProjectJourney(makeState());

    expect(journey.steps.map((step) => step.status)).toEqual([
      "completed",
      "available",
      "locked",
      "locked",
      "locked",
      "locked",
    ]);
    expect(journey.currentStep.id).toBe("direction");
    expect(journey.currentStep.cta).toMatchObject({ kind: "agent", action: "clarify" });
    expect(inferJourneyAgentFocus(makeState())).toBe("方向澄清");
  });

  it("treats not-yet-loaded aggregate arrays as empty during initial hydration", () => {
    const state = makeState();
    state.agent_proposals = undefined as unknown as ProjectState["agent_proposals"];
    state.assignment_proposals = undefined as unknown as ProjectState["assignment_proposals"];
    state.assignment_negotiations = undefined as unknown as ProjectState["assignment_negotiations"];
    state.stages = undefined as unknown as ProjectState["stages"];
    state.tasks = undefined as unknown as ProjectState["tasks"];
    state.risks = undefined as unknown as ProjectState["risks"];
    state.timeline = undefined as unknown as ProjectState["timeline"];

    expect(() => deriveProjectJourney(state)).not.toThrow();
    expect(deriveProjectJourney(state).currentStep.id).toBe("direction");

    state.project = undefined as unknown as ProjectState["project"];
    expect(deriveProjectJourney(state).currentStep).toMatchObject({
      id: "create",
      status: "active",
      agentFocus: "项目录入",
    });
  });

  it("marks a generated direction proposal active until it is confirmed", () => {
    const state = makeState({
      agent_proposals: [{
        id: "proposal-1",
        project_id: "project-1",
        workspace_id: "workspace-1",
        proposal_type: "clarify",
        status: "pending",
        agent_event_id: "event-1",
        payload: {},
        confirmed_by: null,
        confirmed_at: null,
        created_at: "2026-10-01T00:00:00Z",
      }],
    });

    expect(deriveProjectJourney(state).currentStep).toMatchObject({
      id: "direction",
      status: "active",
      cta: { kind: "navigate", view: "overview" },
    });
  });

  it("distinguishes planning from task breakdown", () => {
    const base = makeState();
    const directionConfirmed = makeState({
      project: { ...base.project, direction_card: directionCard },
    });
    expect(deriveProjectJourney(directionConfirmed).currentStep).toMatchObject({
      id: "plan",
      status: "available",
      cta: { kind: "agent", action: "plan" },
    });

    const stageOnly = makeState({
      project: { ...base.project, direction_card: directionCard },
      stages: [stage],
    });
    expect(deriveProjectJourney(stageOnly).currentStep).toMatchObject({
      id: "plan",
      status: "active",
      cta: { kind: "agent", action: "breakdown" },
    });
  });

  it("requires every persisted task to have an owner before execution", () => {
    const state = plannedState();
    state.tasks = [task("not_started", "")];

    const journey = deriveProjectJourney(state);
    expect(journey.steps[2].status).toBe("completed");
    expect(journey.currentStep).toMatchObject({
      id: "assignment",
      status: "available",
      cta: { kind: "agent", action: "assign" },
    });
  });

  it("surfaces assignment negotiation and execution risks as attention states", () => {
    const assignmentState = plannedState();
    assignmentState.tasks = [task("not_started", "")];
    assignmentState.assignment_negotiations = [{
      id: "negotiation-1",
      project_id: "project-1",
      stage_id: "stage-1",
      from_user_id: "user-1",
      desired_task_id: "task-1",
      status: "pending",
      agent_message: "需要协调",
      created_at: "2026-10-01T00:00:00Z",
    }];
    expect(deriveProjectJourney(assignmentState).currentStep.status).toBe("needs_attention");

    const riskState = plannedState("blocked");
    riskState.risks = [{
      id: "risk-1",
      project_id: "project-1",
      type: "dependency",
      severity: "high",
      title: "依赖阻塞",
      description: "关键依赖尚未就绪",
      evidence: [],
      recommendation: "先处理依赖",
      status: "open",
      created_by_agent: true,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    }];
    expect(deriveProjectJourney(riskState).currentStep).toMatchObject({
      id: "execution",
      status: "needs_attention",
      cta: { kind: "navigate", view: "risks" },
    });
  });

  it("opens review after execution and only completes it after a successful export", () => {
    const state = plannedState("done");
    let journey = deriveProjectJourney(state);
    expect(journey.currentStep).toMatchObject({ id: "review", status: "available" });

    state.project = { ...state.project, status: "completed" };
    journey = deriveProjectJourney(state);
    expect(journey.currentStep.status).toBe("needs_attention");

    state.timeline = [{
      id: "event-1",
      project_id: "project-1",
      workspace_id: "workspace-1",
      event_type: "export",
      status: "success",
      input_snapshot: {},
      output_snapshot: {},
      reasoning_summary: "导出项目评审摘要",
      user_confirmed: true,
      created_at: "2026-10-03T00:00:00Z",
    }];
    journey = deriveProjectJourney(state);
    expect(journey.steps[5].status).toBe("completed");
    expect(journey.isComplete).toBe(true);
    expect(journey.completedCount).toBe(6);
  });
});
