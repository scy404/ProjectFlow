import type { AgentEvent, AgentProposal, EvidenceRef, ProjectState } from "@/lib/types";

export type ResolvedEvidence = {
  status: "resolved" | "inline" | "unavailable";
  entityLabel: string;
  field: string;
  value: string;
  note?: string | null;
};

export type TrustState = {
  outputMode: "structured" | "narrative" | "none";
  generationStatus: AgentEvent["status"] | "unknown";
  proposalStatus: AgentProposal["status"] | "not_applicable";
  unknownCount: number;
};

const FIELD_LABELS: Record<string, string> = {
  skills: "技能",
  hours: "可用时间",
  available_hours: "可用时间",
  available_hours_per_week: "每周可用时间",
  status: "状态",
  deadline: "截止日期",
  due_date: "截止日期",
  blocker: "阻塞",
  priority: "优先级",
  constraints: "成员限制",
  validation_result: "验证结果",
};

function findEntityLabel(ref: EvidenceRef, state?: ProjectState): string | null {
  if (!ref.entity_id || !state) return null;
  const type = ref.entity_type.toLowerCase();
  if (["resource", "project_resource"].includes(type)) {
    return state.resources.find((item) => item.id === ref.entity_id)?.title ?? null;
  }
  if (["task", "validation", "validation_result"].includes(type)) {
    return state.tasks.find((item) => item.id === ref.entity_id)?.title ?? null;
  }
  if (type === "stage") {
    return state.stages.find((item) => item.id === ref.entity_id)?.name ?? null;
  }
  if (type === "risk") {
    return state.risks.find((item) => item.id === ref.entity_id)?.title ?? null;
  }
  if (["action_card", "actioncard"].includes(type)) {
    return state.action_cards.find((item) => item.id === ref.entity_id)?.title ?? null;
  }
  if (["assignment", "assignment_proposal"].includes(type)) {
    const proposal = state.assignment_proposals.find((item) => item.id === ref.entity_id);
    const task = proposal
      ? state.tasks.find((item) => item.id === proposal.task_id)
      : null;
    return task ? `分工：${task.title}` : null;
  }
  if (["user", "member", "member_profile"].includes(type)) {
    return state.members.find((item) => item.user_id === ref.entity_id)?.display_name ?? null;
  }
  if (type === "project" && state.project.id === ref.entity_id) return state.project.name;
  return null;
}

export function resolveEvidenceRefs(
  refs: EvidenceRef[] | undefined,
  state?: ProjectState,
): ResolvedEvidence[] {
  return (refs ?? []).map((ref) => {
    const field = FIELD_LABELS[ref.field] ?? ref.field.replaceAll("_", " ");
    if (!ref.entity_id) {
      return {
        status: "inline",
        entityLabel: "项目事实",
        field,
        value: ref.value,
        note: ref.note,
      };
    }
    const label = findEntityLabel(ref, state);
    if (!label) {
      return {
        status: "unavailable",
        entityLabel: "引用已失效或当前不可见",
        field,
        value: "无法展示该证据的详细内容",
        note: null,
      };
    }
    return {
      status: "resolved",
      entityLabel: label,
      field,
      value: ref.value,
      note: ref.note,
    };
  });
}

export function deriveTrustState({
  event,
  proposalStatus,
  unknowns,
}: {
  event?: AgentEvent | null;
  proposalStatus?: AgentProposal["status"] | null;
  unknowns?: string[];
}): TrustState {
  const hasStructured = Boolean(
    event?.output_snapshot && Object.keys(event.output_snapshot).length > 0,
  );
  const hasNarrative = Boolean(event?.reasoning_summary?.trim());
  return {
    outputMode: hasStructured ? "structured" : hasNarrative ? "narrative" : "none",
    generationStatus: event?.status ?? "unknown",
    proposalStatus: proposalStatus ?? "not_applicable",
    unknownCount: unknowns?.length ?? 0,
  };
}
