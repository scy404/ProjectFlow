import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runRetrospective } from "@/lib/api";
import type { AgentEvent, Project, RetrospectiveSummary } from "@/lib/types";
import { parseRetrospectiveSummary, RetroSummaryPanel } from "./project-content";

vi.mock("@/lib/api", () => ({
  runRetrospective: vi.fn(),
}));

const project: Project = {
  id: "project-1",
  workspace_id: "workspace-1",
  name: "测试项目",
  idea: "验证复盘链路",
  deadline: "2027-01-01",
  deliverables: "可演示成果",
  project_template: "competition",
  is_demo: false,
  status: "active",
  current_stage_id: null,
  direction_card: null,
  created_by: "user-1",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

const summary: RetrospectiveSummary = {
  project_summary: "项目已完成核心闭环。",
  key_achievements: ["完成结构化复盘"],
  challenges: ["证据仍需补充"],
  lessons_learned: ["先验证再扩展"],
  overall_assessment: "具备继续迭代的基础。",
  reason: "基于任务、风险和时间线。",
  requires_confirmation: false,
};

function retrospectiveEvent(
  output: Record<string, unknown> = summary,
  status: AgentEvent["status"] = "success",
): AgentEvent {
  return {
    id: "event-retro-1",
    project_id: "project-1",
    workspace_id: "workspace-1",
    event_type: "retrospective",
    status,
    input_snapshot: {},
    output_snapshot: output,
    reasoning_summary: summary.reason,
    user_confirmed: false,
    created_at: "2026-10-09T08:00:00Z",
  };
}

describe("project retrospective contract", () => {
  beforeEach(() => {
    vi.mocked(runRetrospective).mockReset();
  });

  it("strictly validates required strings, arrays and the confirmation boundary", () => {
    expect(parseRetrospectiveSummary(summary)).toEqual(summary);
    expect(parseRetrospectiveSummary({ ...summary, challenges: "not-an-array" })).toBeNull();
    expect(parseRetrospectiveSummary({ ...summary, reason: "" })).toBeNull();
    expect(parseRetrospectiveSummary({ ...summary, requires_confirmation: true })).toBeNull();
  });

  it("restores the latest valid retrospective event after refresh", () => {
    render(
      <RetroSummaryPanel
        project={project}
        timeline={[retrospectiveEvent(summary, "repaired")]}
        pending={false}
        currentUserId="user-1"
      />,
    );

    expect(screen.getByText(summary.project_summary)).toBeTruthy();
    expect(screen.getByText("修复后生成")).toBeTruthy();
    expect(screen.getByText(`生成依据：${summary.reason}`)).toBeTruthy();
  });

  it("disables generation until a current member identity is selected", () => {
    render(
      <RetroSummaryPanel project={project} timeline={[]} pending={false} />,
    );

    expect((screen.getByRole("button", { name: "生成复盘" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("请先在页面顶部选择当前成员身份。")).toBeTruthy();
    expect(runRetrospective).not.toHaveBeenCalled();
  });

  it("shows malformed output as a local error and preserves the last successful result", async () => {
    vi.mocked(runRetrospective).mockResolvedValue({
      event_type: "retrospective",
      status: "success",
      attempts: 1,
      used_fallback: false,
      output: { project_summary: "缺少数组字段" },
      created_ids: [],
    });
    render(
      <RetroSummaryPanel
        project={project}
        timeline={[retrospectiveEvent()]}
        pending={false}
        currentUserId="user-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "生成复盘" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Agent 返回的复盘结构不完整");
    });
    expect(screen.getByText(summary.project_summary)).toBeTruthy();
  });

  it("labels fallback output instead of presenting it as a normal generation", async () => {
    vi.mocked(runRetrospective).mockResolvedValue({
      event_type: "retrospective",
      status: "fallback",
      attempts: 1,
      used_fallback: true,
      output: summary,
      created_ids: [],
    });
    render(
      <RetroSummaryPanel
        project={project}
        timeline={[]}
        pending={false}
        currentUserId="user-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "生成复盘" }));

    await waitFor(() => expect(screen.getByText("基础回退")).toBeTruthy());
    expect(screen.getByText(summary.overall_assessment)).toBeTruthy();
  });
});
