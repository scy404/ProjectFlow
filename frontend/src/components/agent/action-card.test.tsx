import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActionCardItem } from "./action-card";
import type { ActionCard } from "@/lib/types";

const card: ActionCard = {
  id: "card-1",
  project_id: "project-1",
  stage_id: "stage-1",
  user_id: null,
  task_id: null,
  type: "team_next_step",
  title: "确认演示路径",
  content: "从仪表盘跑到导出。",
  reason: "评审需要稳定闭环。",
  goal: "完成一次端到端验收。",
  start_suggestion: "先打开项目仪表盘。",
  completion_standard: "导出内容包含风险和下一步行动。",
  due_date: "2026-06-01",
  status: "active",
  created_by_agent: true,
  created_at: "2026-05-30T00:00:00Z",
  updated_at: "2026-05-30T00:00:00Z",
};

describe("ActionCardItem", () => {
  it("renders active push details with Chinese labels", () => {
    render(<ActionCardItem card={card} />);

    expect(screen.getByText("团队下一步")).toBeTruthy();
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("目标：")).toBeTruthy();
    expect(screen.getByText("如何开始：")).toBeTruthy();
    expect(screen.getByText("完成标准：")).toBeTruthy();
    expect(screen.getByRole("button", { name: /完成/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /忽略/ })).toBeTruthy();
    expect(screen.queryByText("Goal:")).toBeNull();
    expect(screen.queryByText("Done when:")).toBeNull();
  });
});
