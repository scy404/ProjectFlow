import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProjectResource, Task } from "@/lib/types";
import { MyTasksView } from "./project-task-views";

const validationTask: Task = {
  id: "task-validation-1",
  project_id: "project-1",
  stage_id: "stage-1",
  title: "访谈目标用户",
  description: "验证用户是否愿意持续使用",
  priority: "P0",
  status: "in_progress",
  owner_user_id: "user-1",
  backup_owner_user_id: null,
  due_date: "2026-10-20",
  estimated_hours: 3,
  dependency_ids: [],
  acceptance_criteria: [],
  task_kind: "validation",
  validation_spec: {
    hypothesis: "用户愿意持续使用",
    method: "半结构化访谈",
    success_criterion: "至少 6 人明确表达使用意愿",
    sample_target: 8,
  },
  validation_result: null,
  can_cut: false,
  assignment_reason: null,
  created_by_agent: true,
  order_index: 0,
  updated_at: "2026-10-05T00:00:00Z",
};

const evidenceResource: ProjectResource = {
  id: "resource-private-id",
  project_id: "project-1",
  type: "text_note",
  title: "用户访谈纪要",
  content_text: "访谈内容",
  created_at: "2026-10-05T00:00:00Z",
};

describe("validation task interaction", () => {
  it("shows the validation contract and submits named evidence without exposing raw IDs", async () => {
    const onSubmitValidationResult = vi.fn().mockResolvedValue(undefined);
    render(
      <MyTasksView
        tasks={[validationTask]}
        currentUserId="user-1"
        proposals={[]}
        resources={[evidenceResource]}
        onSubmitValidationResult={onSubmitValidationResult}
      />,
    );

    expect(screen.getByText("验证任务")).toBeTruthy();
    expect(screen.getByText(/用户愿意持续使用/)).toBeTruthy();
    expect(screen.getByText(/至少 6 人明确表达使用意愿/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "完成" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "填写结果" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("用户访谈纪要")).toBeTruthy();
    expect(screen.queryByText("resource-private-id")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("概括本次验证发现"), {
      target: { value: "核心需求得到初步支持" },
    });
    fireEvent.change(screen.getByPlaceholderText("记录实际样本、反馈或测量结果"), {
      target: { value: "8 人中 7 人愿意继续试用" },
    });
    fireEvent.click(screen.getByLabelText("用户访谈纪要"));
    fireEvent.click(screen.getByLabelText("提交结果后将任务标记为完成"));
    fireEvent.click(screen.getByRole("button", { name: "保存验证结果" }));

    await waitFor(() => {
      expect(onSubmitValidationResult).toHaveBeenCalledWith("task-validation-1", {
        summary: "核心需求得到初步支持",
        observed_value: "8 人中 7 人愿意继续试用",
        decision: "inconclusive",
        evidence_resource_ids: ["resource-private-id"],
        mark_complete: true,
      });
    });
  });
});
