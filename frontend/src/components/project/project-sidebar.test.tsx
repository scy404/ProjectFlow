import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectState } from "@/lib/types";
import { ProjectSidebar } from "./project-sidebar";

const searchParamGet = vi.fn<(key: string) => string | null>();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/workspaces/workspace-1",
  useSearchParams: () => ({ get: searchParamGet }),
}));

vi.mock("@/lib/api", () => ({
  listWorkspaces: vi.fn(() => new Promise(() => {})),
}));

vi.mock("@/components/member/member-management-dialog", () => ({
  MemberManagementDialog: () => null,
}));

vi.mock("@/components/workspace/new-workspace-dialog", () => ({
  NewWorkspaceDialog: () => null,
}));

vi.mock("@/components/app-shell", () => ({
  setCurrentUserId: vi.fn(),
  clearLastWorkspaceId: vi.fn(),
}));

const state = {
  workspace: {
    workspace_id: "workspace-1",
    name: "测试工作区",
    owner_user_id: "user-1",
    created_at: "2026-10-04T00:00:00Z",
    updated_at: "2026-10-04T00:00:00Z",
  },
  project: {
    id: "project-1",
    workspace_id: "workspace-1",
    name: "测试项目",
    idea: "验证导航",
    deadline: "2027-06-01",
    deliverables: "原型",
    project_template: "competition",
    is_demo: false,
    status: "active",
    created_by: "user-1",
    created_at: "2026-10-04T00:00:00Z",
    updated_at: "2026-10-04T00:00:00Z",
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
} as ProjectState;

function renderSidebar(overrides: Partial<React.ComponentProps<typeof ProjectSidebar>> = {}) {
  const props: React.ComponentProps<typeof ProjectSidebar> = {
    projectId: "project-1",
    state,
    currentUserId: "user-1",
    collapsed: false,
    onToggle: vi.fn(),
    showWorkspace: false,
    onShowWorkspace: vi.fn(),
    onNavigateView: vi.fn(),
    ...overrides,
  };
  return { ...render(<ProjectSidebar {...props} />), props };
}

describe("ProjectSidebar grouped navigation", () => {
  beforeEach(() => {
    searchParamGet.mockReturnValue(null);
  });

  it("shows fixed destinations and keeps both groups collapsed on Overview", () => {
    renderSidebar();

    expect(screen.getByRole("button", { name: "Agent 对话" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "项目总览" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /项目推进/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /复盘总结/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "方向卡" })).toBeNull();
  });

  it("keeps groups independently expanded and preserves every legacy destination", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: /项目推进/ }));
    expect(screen.getByRole("button", { name: "方向卡" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "阶段计划" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "我的任务" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "团队任务" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "签到与状态" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "风险预警" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /复盘总结/ }));
    expect(screen.getByRole("button", { name: /项目推进/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /复盘总结/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "方向卡" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "项目记忆" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "项目复盘" })).not.toBeNull();
  });

  it("opens the current route group without relying on a saved browser flag", () => {
    searchParamGet.mockImplementation((key) => key === "view" ? "risks" : null);
    renderSidebar();

    expect(screen.getByRole("button", { name: /项目推进/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "风险预警" }).getAttribute("aria-current")).toBe("page");
  });

  it("expands the sidebar before exposing a selected group from icon mode", () => {
    const onToggle = vi.fn();
    const rendered = renderSidebar({ collapsed: true, onToggle });

    fireEvent.click(screen.getByRole("button", { name: /项目推进/ }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "方向卡" })).toBeNull();

    rendered.rerender(<ProjectSidebar {...rendered.props} collapsed={false} />);
    expect(screen.getByRole("button", { name: "方向卡" })).not.toBeNull();
  });

  it("starts the guided tour only when the user asks for it", () => {
    const startTour = vi.fn();
    window.addEventListener("projectflow:start-guided-tour", startTour);
    renderSidebar();

    expect(startTour).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "使用引导" }));
    expect(startTour).toHaveBeenCalledOnce();

    window.removeEventListener("projectflow:start-guided-tour", startTour);
  });
});
