export type ProjectView =
  | "agent"
  | "overview"
  | "direction"
  | "stages"
  | "my-tasks"
  | "team-tasks"
  | "checkin"
  | "risks"
  | "memory"
  | "retro";

export type ProjectNavigationGroupId = "progress" | "review";

export const FIXED_PROJECT_VIEWS = ["agent", "overview"] as const satisfies readonly ProjectView[];

export const PROJECT_NAVIGATION_GROUPS = [
  {
    id: "progress",
    label: "项目推进",
    sections: [
      {
        id: "planning",
        views: ["direction", "stages"],
      },
      {
        id: "execution",
        views: ["my-tasks", "team-tasks", "checkin", "risks"],
        weakDividerBefore: true,
      },
    ],
  },
  {
    id: "review",
    label: "沉淀与评审",
    sections: [
      {
        id: "review-and-memory",
        views: ["memory", "retro"],
      },
    ],
  },
] as const satisfies readonly {
  id: ProjectNavigationGroupId;
  label: string;
  sections: readonly {
    id: string;
    views: readonly ProjectView[];
    weakDividerBefore?: boolean;
  }[];
}[];

export function getProjectNavigationGroup(view: ProjectView): ProjectNavigationGroupId | null {
  const group = PROJECT_NAVIGATION_GROUPS.find((candidate) =>
    candidate.sections.some((section) => section.views.some((item) => item === view)),
  );
  return group?.id ?? null;
}

export function listProjectNavigationViews(): ProjectView[] {
  return [
    ...FIXED_PROJECT_VIEWS,
    ...PROJECT_NAVIGATION_GROUPS.flatMap((group) =>
      group.sections.flatMap((section) => section.views),
    ),
  ];
}
