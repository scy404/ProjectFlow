import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateProjectExport } from "@/lib/api";
import type { ProjectExportResult } from "@/lib/types";

import { ExportPanel } from "./export-panel";

vi.mock("@/lib/api", () => ({
  generateProjectExport: vi.fn(),
}));

const result: ProjectExportResult = {
  export_type: "review_summary",
  markdown: "# 项目成果\n\n- 数据库事实",
  facts: {
    generated_at: "2026-10-08T00:00:00Z",
    metrics: {
      project_id: "project-1",
      project_created_at: "2026-10-01T00:00:00Z",
      first_confirmed_plan_at: null,
      created_to_first_plan_seconds: null,
      proposals_total: 0,
      proposals_confirmed: 0,
      proposals_rejected: 0,
      proposals_pending: 0,
      proposal_decision_ratio: { numerator: 0, denominator: 0 },
      assignments_completed: 0,
      assignments_total: 0,
      assignment_completion_ratio: { numerator: 0, denominator: 0 },
      tasks_total: 4,
      tasks_completed: 2,
      task_completion_ratio: { numerator: 2, denominator: 4 },
      validation_tasks_total: 1,
      validation_tasks_with_result: 1,
      validation_conclusion_ratio: { numerator: 1, denominator: 1 },
      risks_total: 0,
      action_cards_total: 0,
      calculation_notes: {},
    },
    validation_results: [{ task_id: "task-1", task_title: "验证需求", result: {} }],
    evidence_refs: [{ entity_type: "task", entity_id: "task-1", field: "status", value: "done" }],
  },
};

describe("ExportPanel", () => {
  beforeEach(() => {
    vi.mocked(generateProjectExport).mockResolvedValue(result);
  });

  it("uses the unified export endpoint and renders markdown plus factual snapshot", async () => {
    render(<ExportPanel projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "生成成果" }));

    await waitFor(() => {
      expect(generateProjectExport).toHaveBeenCalledWith("project-1", "review_summary");
    });
    expect(await screen.findByRole("heading", { name: "项目成果" })).toBeTruthy();
    expect(screen.getByText(/2\/4 个任务完成/)).toBeTruthy();
    expect(screen.getByText(/1 个验证结果/)).toBeTruthy();
    expect(screen.getByText(/1 条结构化证据引用/)).toBeTruthy();
  });
});
