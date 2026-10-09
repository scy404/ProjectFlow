import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getProjectMetrics } from "@/lib/api";
import type { ProjectMetrics } from "@/lib/types";

import { OutcomeMetricsPanel } from "./outcome-metrics-panel";

vi.mock("@/lib/api", () => ({
  getProjectMetrics: vi.fn(),
}));

const metrics: ProjectMetrics = {
  project_id: "project-1",
  project_created_at: "2026-10-01T00:00:00Z",
  first_confirmed_plan_at: "2026-10-01T01:00:00Z",
  created_to_first_plan_seconds: 3600,
  proposals_total: 3,
  proposals_confirmed: 1,
  proposals_rejected: 1,
  proposals_pending: 1,
  proposal_decision_ratio: { numerator: 2, denominator: 3 },
  assignments_completed: 2,
  assignments_total: 3,
  assignment_completion_ratio: { numerator: 2, denominator: 3 },
  tasks_total: 5,
  tasks_completed: 3,
  task_completion_ratio: { numerator: 3, denominator: 5 },
  validation_tasks_total: 2,
  validation_tasks_with_result: 1,
  validation_conclusion_ratio: { numerator: 1, denominator: 2 },
  risks_total: 2,
  action_cards_total: 4,
  calculation_notes: {
    created_to_first_plan_seconds: "项目创建至首个确认计划。",
    proposal_decision_ratio: "已决策 Proposal / Proposal 总数。",
    assignment_completion_ratio: "已完成分工 / 分工总数。",
    task_completion_ratio: "完成任务 / 任务总数。",
    validation_conclusion_ratio: "有结论验证 / 验证总数。",
  },
};

describe("OutcomeMetricsPanel", () => {
  beforeEach(() => {
    vi.mocked(getProjectMetrics).mockResolvedValue(metrics);
  });

  it("renders database-derived ratios and labels demo data", async () => {
    render(<OutcomeMetricsPanel projectId="project-1" isDemo />);

    expect(screen.getByText(/演示种子数据/)).toBeTruthy();
    await waitFor(() => expect(getProjectMetrics).toHaveBeenCalledWith("project-1"));
    expect(await screen.findByText("3/5")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getAllByText("2/3")).toHaveLength(2);
    expect(screen.getByText("1.0 小时")).toBeTruthy();
    expect(screen.queryByText(/节省.*小时/)).toBeNull();
  });
});
