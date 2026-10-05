import type { ProjectState } from "@/lib/types";

export type ProjectJourneyStatus =
  | "locked"
  | "available"
  | "active"
  | "completed"
  | "needs_attention";

export type ProjectJourneyStepId =
  | "create"
  | "direction"
  | "plan"
  | "assignment"
  | "execution"
  | "review";

export type ProjectJourneyView =
  | "overview"
  | "direction"
  | "stages"
  | "my-tasks"
  | "team-tasks"
  | "risks"
  | "retro";

export type ProjectJourneyAgentAction =
  | "clarify"
  | "plan"
  | "breakdown"
  | "assign";

export type ProjectJourneyCta =
  | {
      kind: "navigate";
      label: string;
      view: ProjectJourneyView;
      disabled?: boolean;
    }
  | {
      kind: "agent";
      label: string;
      action: ProjectJourneyAgentAction;
      disabled?: boolean;
    };

export type ProjectJourneyStep = {
  id: ProjectJourneyStepId;
  order: number;
  title: string;
  status: ProjectJourneyStatus;
  detail: string;
  cta: ProjectJourneyCta;
  agentFocus: string;
};

export type ProjectJourney = {
  steps: ProjectJourneyStep[];
  currentStep: ProjectJourneyStep;
  currentStepIndex: number;
  completedCount: number;
  isComplete: boolean;
  agentContext: string;
};

const pendingProposal = (
  state: ProjectState,
  ...types: ProjectState["agent_proposals"][number]["proposal_type"][]
) => (state.agent_proposals ?? []).some(
  (proposal) => proposal.status === "pending" && types.includes(proposal.proposal_type),
);

function directionStep(state: ProjectState): ProjectJourneyStep {
  const hasPending = pendingProposal(state, "clarify");
  if (state.project.direction_card) {
    return {
      id: "direction",
      order: 2,
      title: "明确方向",
      status: "completed",
      detail: "方向卡已经确认并写入项目。",
      cta: { kind: "navigate", label: "查看方向卡", view: "direction" },
      agentFocus: "方向澄清",
    };
  }
  if (hasPending) {
    return {
      id: "direction",
      order: 2,
      title: "明确方向",
      status: "active",
      detail: "方向提案已生成，等待负责人确认。",
      cta: { kind: "navigate", label: "确认方向提案", view: "overview" },
      agentFocus: "方向澄清",
    };
  }
  return {
    id: "direction",
    order: 2,
    title: "明确方向",
    status: "available",
    detail: "根据项目资料生成并确认方向卡。",
    cta: { kind: "agent", label: "生成方向卡", action: "clarify" },
    agentFocus: "方向澄清",
  };
}

function planStep(state: ProjectState, direction: ProjectJourneyStep): ProjectJourneyStep {
  if (direction.status !== "completed") {
    return {
      id: "plan",
      order: 3,
      title: "制定计划",
      status: "locked",
      detail: "确认方向卡后才能制定阶段与任务计划。",
      cta: { kind: "navigate", label: "先完成方向", view: "direction", disabled: true },
      agentFocus: "阶段计划",
    };
  }

  const stages = state.stages ?? [];
  const tasks = state.tasks ?? [];
  const hasStages = stages.length > 0;
  const hasTasks = tasks.length > 0;
  const planPending = pendingProposal(state, "plan");
  const breakdownPending = pendingProposal(state, "breakdown");
  if (hasStages && hasTasks) {
    return {
      id: "plan",
      order: 3,
      title: "制定计划",
      status: "completed",
      detail: `已有 ${stages.length} 个阶段和 ${tasks.length} 个任务。`,
      cta: { kind: "navigate", label: "查看阶段计划", view: "stages" },
      agentFocus: "任务拆解",
    };
  }
  if (planPending || breakdownPending) {
    return {
      id: "plan",
      order: 3,
      title: "制定计划",
      status: "active",
      detail: `${planPending ? "阶段" : "任务"}提案已生成，等待负责人确认。`,
      cta: { kind: "navigate", label: "确认计划提案", view: "overview" },
      agentFocus: hasStages ? "任务拆解" : "阶段计划",
    };
  }
  if (hasStages) {
    return {
      id: "plan",
      order: 3,
      title: "制定计划",
      status: "active",
      detail: "阶段已经建立，还需要拆解为可执行任务。",
      cta: { kind: "agent", label: "拆解阶段任务", action: "breakdown" },
      agentFocus: "任务拆解",
    };
  }
  return {
    id: "plan",
    order: 3,
    title: "制定计划",
    status: "available",
    detail: "生成阶段、时间窗口和交付物计划。",
    cta: { kind: "agent", label: "生成阶段计划", action: "plan" },
    agentFocus: "阶段计划",
  };
}

function assignmentStep(state: ProjectState, plan: ProjectJourneyStep): ProjectJourneyStep {
  if (plan.status !== "completed") {
    return {
      id: "assignment",
      order: 4,
      title: "完成分工",
      status: "locked",
      detail: "任务拆解完成后才能进行分工。",
      cta: { kind: "navigate", label: "先完成计划", view: "stages", disabled: true },
      agentFocus: "分工确认",
    };
  }

  const tasks = state.tasks ?? [];
  const assignmentProposals = state.assignment_proposals ?? [];
  const assignmentNegotiations = state.assignment_negotiations ?? [];
  const assignedCount = tasks.filter((task) => Boolean(task.owner_user_id)).length;
  const allAssigned = tasks.length > 0 && assignedCount === tasks.length;
  const needsAttention = assignmentProposals.some(
    (proposal) => proposal.status === "owner_rejected" || proposal.status === "negotiating",
  ) || assignmentNegotiations.some((negotiation) => negotiation.status === "pending");
  const hasActiveProposal = assignmentProposals.some(
    (proposal) => proposal.status === "proposed" || proposal.status === "owner_confirmed",
  );

  if (needsAttention) {
    return {
      id: "assignment",
      order: 4,
      title: "完成分工",
      status: "needs_attention",
      detail: "存在拒绝或待处理的分工协商。",
      cta: { kind: "navigate", label: "处理分工协商", view: "team-tasks" },
      agentFocus: "分工确认",
    };
  }
  if (allAssigned) {
    return {
      id: "assignment",
      order: 4,
      title: "完成分工",
      status: "completed",
      detail: `${assignedCount} 个任务均已有负责人。`,
      cta: { kind: "navigate", label: "查看团队分工", view: "team-tasks" },
      agentFocus: "分工确认",
    };
  }
  if (assignedCount > 0 || hasActiveProposal) {
    return {
      id: "assignment",
      order: 4,
      title: "完成分工",
      status: "active",
      detail: `已有 ${assignedCount}/${tasks.length} 个任务确定负责人。`,
      cta: { kind: "navigate", label: "继续完成分工", view: "team-tasks" },
      agentFocus: "分工确认",
    };
  }
  return {
    id: "assignment",
    order: 4,
    title: "完成分工",
    status: "available",
    detail: "根据技能、时间和偏好生成分工建议。",
    cta: { kind: "agent", label: "生成分工建议", action: "assign" },
    agentFocus: "分工确认",
  };
}

function executionStep(state: ProjectState, assignment: ProjectJourneyStep): ProjectJourneyStep {
  if (assignment.status !== "completed") {
    return {
      id: "execution",
      order: 5,
      title: "执行与验证",
      status: "locked",
      detail: "完成分工后进入执行与验证。",
      cta: { kind: "navigate", label: "先完成分工", view: "team-tasks", disabled: true },
      agentFocus: "执行推进",
    };
  }

  const tasks = state.tasks ?? [];
  const risks = state.risks ?? [];
  const blockedTasks = tasks.filter((task) => task.status === "blocked");
  const openRisks = risks.filter((risk) => risk.status === "open");
  const allDone = tasks.length > 0 && tasks.every((task) => task.status === "done");
  const startedCount = tasks.filter((task) => task.status !== "not_started").length;

  if (state.project.status === "at_risk" || blockedTasks.length > 0 || openRisks.length > 0) {
    const detail = openRisks.length > 0
      ? `${openRisks.length} 个开放风险需要处理。`
      : `${blockedTasks.length} 个任务处于阻塞状态。`;
    return {
      id: "execution",
      order: 5,
      title: "执行与验证",
      status: "needs_attention",
      detail,
      cta: openRisks.length > 0
        ? { kind: "navigate", label: "处理项目风险", view: "risks" }
        : { kind: "navigate", label: "处理阻塞任务", view: "team-tasks" },
      agentFocus: "执行推进",
    };
  }
  if (allDone) {
    return {
      id: "execution",
      order: 5,
      title: "执行与验证",
      status: "completed",
      detail: `${tasks.length} 个任务均已完成。`,
      cta: { kind: "navigate", label: "查看执行结果", view: "team-tasks" },
      agentFocus: "执行推进",
    };
  }
  if (startedCount > 0) {
    return {
      id: "execution",
      order: 5,
      title: "执行与验证",
      status: "active",
      detail: `${startedCount}/${tasks.length} 个任务已经开始或完成。`,
      cta: { kind: "navigate", label: "继续我的任务", view: "my-tasks" },
      agentFocus: "执行推进",
    };
  }
  return {
    id: "execution",
    order: 5,
    title: "执行与验证",
    status: "available",
    detail: "按分工开始任务，并持续更新真实状态。",
    cta: { kind: "navigate", label: "开始我的任务", view: "my-tasks" },
    agentFocus: "执行推进",
  };
}

function reviewStep(state: ProjectState, execution: ProjectJourneyStep): ProjectJourneyStep {
  const exported = (state.timeline ?? []).some(
    (event) => event.event_type === "export" && event.status !== "failed",
  );
  if (execution.status !== "completed") {
    return {
      id: "review",
      order: 6,
      title: "复盘与导出",
      status: "locked",
      detail: "完成执行任务并处理风险后才能收尾。",
      cta: { kind: "navigate", label: "先完成执行", view: "my-tasks", disabled: true },
      agentFocus: "复盘导出",
    };
  }
  if (exported) {
    return {
      id: "review",
      order: 6,
      title: "复盘与导出",
      status: "completed",
      detail: "项目评审摘要已经从当前数据库状态导出。",
      cta: { kind: "navigate", label: "查看项目复盘", view: "retro" },
      agentFocus: "复盘导出",
    };
  }
  if (state.project.status === "completed") {
    return {
      id: "review",
      order: 6,
      title: "复盘与导出",
      status: "needs_attention",
      detail: "项目已标记完成，但尚未生成评审摘要。",
      cta: { kind: "navigate", label: "生成复盘与导出", view: "retro" },
      agentFocus: "复盘导出",
    };
  }
  return {
    id: "review",
    order: 6,
    title: "复盘与导出",
    status: "available",
    detail: "基于已完成任务、风险和时间线生成复盘。",
    cta: { kind: "navigate", label: "开始项目复盘", view: "retro" },
    agentFocus: "复盘导出",
  };
}

export function deriveProjectJourney(state: ProjectState): ProjectJourney {
  if (!state.project) {
    const steps: ProjectJourneyStep[] = [
      {
        id: "create",
        order: 1,
        title: "创建项目",
        status: "active",
        detail: "正在读取已保存的项目数据。",
        cta: { kind: "navigate", label: "等待项目载入", view: "overview", disabled: true },
        agentFocus: "项目录入",
      },
      ...([
        ["direction", 2, "明确方向", "确认项目后才能明确方向。", "direction", "方向澄清"],
        ["plan", 3, "制定计划", "确认方向后才能制定计划。", "stages", "阶段计划"],
        ["assignment", 4, "完成分工", "任务拆解后才能完成分工。", "team-tasks", "分工确认"],
        ["execution", 5, "执行与验证", "完成分工后才能开始执行。", "my-tasks", "执行推进"],
        ["review", 6, "复盘与导出", "完成执行后才能进行复盘。", "retro", "复盘导出"],
      ] as const).map(([id, order, title, detail, view, agentFocus]) => ({
        id,
        order,
        title,
        status: "locked" as const,
        detail,
        cta: { kind: "navigate" as const, label: "尚未开放", view, disabled: true },
        agentFocus,
      })),
    ];
    return {
      steps,
      currentStep: steps[0],
      currentStepIndex: 0,
      completedCount: 0,
      isComplete: false,
      agentContext: "项目旅程第 1/6 步：创建项目。正在读取已保存的项目数据。",
    };
  }

  const create: ProjectJourneyStep = {
    id: "create",
    order: 1,
    title: "创建项目",
    status: "completed",
    detail: "项目已经保存到工作区。",
    cta: { kind: "navigate", label: "查看项目概况", view: "overview" },
    agentFocus: "项目录入",
  };
  const direction = directionStep(state);
  const plan = planStep(state, direction);
  const assignment = assignmentStep(state, plan);
  const execution = executionStep(state, assignment);
  const review = reviewStep(state, execution);
  const steps = [create, direction, plan, assignment, execution, review];
  const currentStepIndex = steps.findIndex(
    (step) => step.status !== "completed" && step.status !== "locked",
  );
  const resolvedIndex = currentStepIndex === -1 ? steps.length - 1 : currentStepIndex;
  const currentStep = steps[resolvedIndex];
  const completedCount = steps.filter((step) => step.status === "completed").length;

  return {
    steps,
    currentStep,
    currentStepIndex: resolvedIndex,
    completedCount,
    isComplete: completedCount === steps.length,
    agentContext: `项目旅程第 ${currentStep.order}/6 步：${currentStep.title}。${currentStep.detail}`,
  };
}

export function inferJourneyAgentFocus(state: ProjectState): string {
  return deriveProjectJourney(state).currentStep.agentFocus;
}
