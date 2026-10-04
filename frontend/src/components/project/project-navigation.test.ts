import { describe, expect, it } from "vitest";

import {
  FIXED_PROJECT_VIEWS,
  PROJECT_NAVIGATION_GROUPS,
  getProjectNavigationGroup,
  listProjectNavigationViews,
} from "./project-navigation";

describe("project navigation information architecture", () => {
  it("keeps all ten project pages exactly once", () => {
    const views = listProjectNavigationViews();

    expect(views).toHaveLength(10);
    expect(new Set(views).size).toBe(10);
    expect(views).toEqual([
      "agent",
      "overview",
      "direction",
      "stages",
      "my-tasks",
      "team-tasks",
      "checkin",
      "risks",
      "memory",
      "retro",
    ]);
  });

  it("keeps Agent and Overview fixed while merging planning and execution", () => {
    expect(FIXED_PROJECT_VIEWS).toEqual(["agent", "overview"]);
    const progress = PROJECT_NAVIGATION_GROUPS.find((group) => group.id === "progress");

    expect(progress?.sections.map((section) => section.views)).toEqual([
      ["direction", "stages"],
      ["my-tasks", "team-tasks", "checkin", "risks"],
    ]);
    expect(progress?.sections[1].weakDividerBefore).toBe(true);
    expect(PROJECT_NAVIGATION_GROUPS.find((group) => group.id === "review")?.label).toBe("复盘总结");
  });

  it("maps direct routes to the group that must open", () => {
    expect(getProjectNavigationGroup("overview")).toBeNull();
    expect(getProjectNavigationGroup("direction")).toBe("progress");
    expect(getProjectNavigationGroup("risks")).toBe("progress");
    expect(getProjectNavigationGroup("memory")).toBe("review");
    expect(getProjectNavigationGroup("retro")).toBe("review");
  });
});
