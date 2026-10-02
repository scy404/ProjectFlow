import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectIntakeForm } from "./project-intake-form";

const apiMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  addResource: vi.fn(),
}));

vi.mock("@/lib/api", () => apiMocks);
vi.mock("./resource-input-panel", () => ({
  ResourceInputPanel: ({ onChange }: { onChange: (resources: unknown[]) => void }) => (
    <button
      type="button"
      onClick={() => onChange([{ type: "text_note", title: "调研记录", content_text: "用户反馈" }])}
    >
      添加测试资源
    </button>
  ),
}));

function fillRequiredFields(container: HTMLElement) {
  fireEvent.change(screen.getByPlaceholderText("例如：校园二手交易平台"), {
    target: { value: "校园项目助手" },
  });
  fireEvent.change(screen.getByPlaceholderText("我们想做一款帮助大学生..."), {
    target: { value: "这是一个帮助大学生团队推进项目的工具" },
  });
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 30);
  fireEvent.change(container.querySelector('input[type="date"]')!, {
    target: { value: deadline.toISOString().slice(0, 10) },
  });
}

describe("ProjectIntakeForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiMocks.createProject.mockResolvedValue({ id: "project-1", name: "校园项目助手" });
  });

  it("submits the selected project type and omits the duplicate team-size field", async () => {
    const { container } = render(
      <ProjectIntakeForm workspaceId="workspace-1" creatorUserId="user-1" />,
    );
    expect(screen.queryByText("团队规模")).toBeNull();
    expect(screen.queryByText("创建者 ID")).toBeNull();

    fillRequiredFields(container);
    fireEvent.click(screen.getByRole("button", { name: "比赛" }));
    fireEvent.click(screen.getByRole("button", { name: /开始规划/ }));

    await waitFor(() => {
      expect(apiMocks.createProject).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
        project_template: "competition",
        created_by: "user-1",
      }));
    });
    expect(JSON.parse(localStorage.getItem("project-intake-draft") ?? "{}"))
      .not.toHaveProperty("teamSize");
    expect(JSON.parse(localStorage.getItem("project-intake-draft") ?? "{}"))
      .not.toHaveProperty("createdBy");
  });

  it("uses general for a project without a selected type", async () => {
    const { container } = render(
      <ProjectIntakeForm workspaceId="workspace-1" creatorUserId="user-1" />,
    );
    fillRequiredFields(container);
    fireEvent.click(screen.getByRole("button", { name: /开始规划/ }));

    await waitFor(() => {
      expect(apiMocks.createProject).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
        project_template: "general",
      }));
    });
  });

  it("uses the workspace project type as the initial project type", async () => {
    const { container } = render(
      <ProjectIntakeForm
        workspaceId="workspace-1"
        creatorUserId="user-1"
        defaultProjectTemplate="research"
      />,
    );
    fillRequiredFields(container);
    fireEvent.click(screen.getByRole("button", { name: /开始规划/ }));

    await waitFor(() => {
      expect(apiMocks.createProject).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
        project_template: "research",
      }));
    });
  });

  it("shows workspace members instead of asking for team size", () => {
    render(
      <ProjectIntakeForm
        workspaceId="workspace-1"
        creatorUserId="user-1"
        teamMembers={[
          { user_id: "user-1", display_name: "小林" },
          { user_id: "user-2", display_name: "小王" },
        ]}
      />,
    );
    expect(screen.getByText("2 名成员：小林、小王")).toBeTruthy();
  });

  it("offers a direct direction-card next step after creation", async () => {
    const onCreated = vi.fn();
    const { container } = render(
      <ProjectIntakeForm workspaceId="workspace-1" creatorUserId="user-1" onCreated={onCreated} />,
    );
    fillRequiredFields(container);
    fireEvent.click(screen.getByRole("button", { name: /开始规划/ }));
    await screen.findByText("项目已创建");
    fireEvent.click(screen.getByRole("button", { name: "生成方向卡" }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "project-1" }), "clarify");
  });

  it("keeps project creation explicit when a resource fails and allows retry", async () => {
    apiMocks.addResource.mockRejectedValueOnce(new Error("offline"));
    const { container } = render(
      <ProjectIntakeForm workspaceId="workspace-1" creatorUserId="user-1" />,
    );
    fillRequiredFields(container);
    fireEvent.click(screen.getByText("资源与约束"));
    fireEvent.click(screen.getByRole("button", { name: "添加测试资源" }));
    fireEvent.click(screen.getByRole("button", { name: /开始规划/ }));

    expect(await screen.findByText("项目已创建")).toBeTruthy();
    expect(screen.getByText(/1 个资源尚未保存/)).toBeTruthy();
    apiMocks.addResource.mockResolvedValueOnce({ id: "resource-1" });
    fireEvent.click(screen.getByRole("button", { name: "重试保存资源" }));
    await waitFor(() => expect(screen.queryByText(/资源尚未保存/)).toBeNull());
    expect(apiMocks.addResource).toHaveBeenCalledTimes(2);
  });
});
