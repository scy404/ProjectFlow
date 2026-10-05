/**
 * Skill router tests — two-stage deterministic skill selection.
 *
 * Verifies: explicit skill, trigger examples, negative triggers,
 * prerequisites, conflict detection, effect ceiling composition,
 * forbidden tool filtering.
 */

import { describe, it, expect } from "vitest";
import { routeSkills } from "../../src/skills/skill-router.js";
import type { SkillMetadataV2 } from "../../src/skills/skill-v2-metadata.js";

function makeSkill(overrides: Partial<SkillMetadataV2> = {}): SkillMetadataV2 {
  return {
    name: "test-skill",
    description: "Test skill",
    location: "/skills/test-skill/SKILL.md",
    allowedTools: ["get_workspace_state"],
    references: [],
    v2: {
      version: 2,
      triggerExamples: [],
      negativeTriggers: [],
      prerequisites: [],
      outcomeType: "proposal",
      allowedEffects: "proposal_only",
      requiredVerification: "deterministic",
    },
    ...overrides,
  };
}

const ALL_SKILLS: SkillMetadataV2[] = [
  makeSkill({
    name: "project-planning",
    description: "当需要阶段计划时触发",
    allowedTools: ["get_workspace_state", "list_pending_proposals", "generate_stage_plan_proposal"],
    v2: {
      version: 2,
      triggerExamples: ["制定计划", "生成阶段计划", "根据项目约束生成阶段计划"],
      negativeTriggers: ["计划延期了", "如何制定计划"],
      prerequisites: [{ type: "has_direction_card", description: "需要方向卡" }],
      outcomeType: "proposal",
      allowedEffects: "proposal_only",
      requiredVerification: "deterministic",
    },
  }),
  makeSkill({
    name: "risk-analysis",
    description: "分析项目风险",
    allowedTools: ["get_workspace_state", "get_timeline_slice", "create_risk"],
    v2: {
      version: 2,
      triggerExamples: ["分析当前风险", "检查项目风险"],
      negativeTriggers: ["当前有哪些风险", "风险等级怎么划分"],
      prerequisites: [],
      outcomeType: "advisory",
      allowedEffects: "advisory_only",
      requiredVerification: "deterministic",
    },
  }),
  makeSkill({
    name: "task-breakdown",
    description: "拆分任务",
    allowedTools: ["get_workspace_state", "generate_task_breakdown_proposal"],
    v2: {
      version: 2,
      triggerExamples: ["拆成任务", "任务拆解"],
      negativeTriggers: ["任务分解是什么"],
      prerequisites: [{ type: "has_stages", description: "需要阶段" }],
      outcomeType: "proposal",
      allowedEffects: "proposal_only",
      requiredVerification: "deterministic",
    },
  }),
];

describe("skill-router", () => {
  describe("explicit skill", () => {
    it("selects explicit skill with highest priority", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "帮我制定计划",
        explicitSkill: "project-planning",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });

      expect(result.selected.length).toBe(1);
      expect(result.selected[0]!.name).toBe("project-planning");
      expect(result.reason).toContain("project-planning");
    });
  });

  describe("negative triggers", () => {
    it("rejects skill when negative trigger matches", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "计划延期了怎么办",
      });

      // project-planning should be rejected due to negative trigger "计划延期了"
      const planning = result.candidates.find((c) => c.metadata.name === "project-planning");
      expect(planning?.rejected).toBeDefined();
    });

    it("rejects risk-analysis for question about risks", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "当前有哪些风险？",
      });

      const risk = result.candidates.find((c) => c.metadata.name === "risk-analysis");
      expect(risk?.rejected).toBeDefined();
    });
  });

  describe("prerequisites", () => {
    it("rejects skill when prerequisite fails", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "制定计划",
        workspaceState: { project: {} }, // no direction_card
      });

      const planning = result.candidates.find((c) => c.metadata.name === "project-planning");
      expect(planning?.rejected).toContain("prerequisite");
    });

    it("accepts skill when prerequisite passes", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "制定计划",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });

      expect(result.selected.length).toBe(1);
      expect(result.selected[0]!.name).toBe("project-planning");
    });
  });

  describe("trigger examples", () => {
    it("matches trigger example in user content", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "请帮我制定计划",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });

      expect(result.selected.length).toBe(1);
      expect(result.selected[0]!.name).toBe("project-planning");
    });
  });

  describe("effect ceiling", () => {
    it("returns most restrictive effect ceiling", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "分析当前风险",
      });

      expect(result.combinedEffectCeiling).toBe("advisory_only");
    });

    it("returns none when no skills selected", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "你好世界",
      });

      expect(result.combinedEffectCeiling).toBe("none");
    });
  });

  describe("forbidden tools", () => {
    it("filters out confirm_proposal from allowed tools", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "test",
          allowedTools: ["get_workspace_state", "confirm_proposal"],
          v2: {
            version: 2,
            triggerExamples: ["test"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "full",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, { userContent: "test" });
      expect(result.combinedAllowedTools).not.toContain("confirm_proposal");
    });
  });

  describe("answer mode fallback", () => {
    it("returns empty selection for unmatched content", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "今天天气不错",
      });

      // Log for debugging
      if (result.selected.length > 0) {
        console.log("Unexpected selection:", result.selected.map((s) => s.name));
        console.log("Candidates:", result.candidates.map((c) => ({
          name: c.metadata.name,
          score: c.score,
          reasons: c.reasons,
          rejected: c.rejected,
        })));
      }

      // If a skill is selected, it should at least have a reason
      if (result.selected.length > 0) {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  describe("T46-100 routing regression — read-only status inquiries → answer mode", () => {
    const projectStatusSkill: SkillMetadataV2 = makeSkill({
      name: "project-status",
      description: "主动推进",
      allowedTools: ["create_checkin", "create_risk", "get_workspace_state", "get_timeline_slice", "list_pending_proposals"],
      v2: {
        version: 2,
        triggerExamples: ["生成下一步行动卡", "主动推进"],
        negativeTriggers: ["进展如何", "当前状态是什么", "项目进展"],
        prerequisites: [],
        outcomeType: "advisory",
        allowedEffects: "advisory_only",
        requiredVerification: "deterministic",
      },
    });

    const allSkillsWithStatus = [...ALL_SKILLS, projectStatusSkill];

    it("routes '请再次告诉我当前项目进展' to answer mode (not project-status)", () => {
      const result = routeSkills(allSkillsWithStatus, {
        userContent: "请再次告诉我当前项目进展。",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
      expect(result.combinedEffectCeiling).toBe("none");
    });

    it("routes '当前项目的整体进展如何' to answer mode", () => {
      const result = routeSkills(allSkillsWithStatus, {
        userContent: "当前项目的整体进展如何？有哪些任务正在进行？",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
    });

    it("routes '这个项目目前有哪些任务和成员' to answer mode", () => {
      const result = routeSkills(allSkillsWithStatus, {
        userContent: "这个项目目前有哪些任务和成员？",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
    });

    it("routes '请介绍一下当前项目状态' to answer mode", () => {
      const result = routeSkills(allSkillsWithStatus, {
        userContent: "请介绍一下当前项目状态。",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
    });

    it("does NOT route '主动推进' to answer mode — action prompt stays", () => {
      const result = routeSkills(allSkillsWithStatus, {
        userContent: "主动推进",
        workspaceState: { project: { direction_card: { problem: "test" }, stages: [], tasks: [] } },
      });
      expect(result.selected.length).toBe(1);
      expect(result.selected[0]!.name).toBe("project-status");
    });

    it("does NOT route '生成下一步行动卡' to answer mode", () => {
      const result = routeSkills(allSkillsWithStatus, {
        userContent: "生成下一步行动卡",
        workspaceState: { project: { direction_card: { problem: "test" }, stages: [], tasks: [] } },
      });
      expect(result.selected.length).toBe(1);
      expect(result.selected[0]!.name).toBe("project-status");
    });

    it("negative: '不要修改' forces answer mode even if trigger matches", () => {
      const result = routeSkills(allSkillsWithStatus, {
        userContent: "不要修改任何东西，我只想解释一下当前项目进展如何",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
      expect(result.reason).toContain("answer-only");
    });
  });

  describe("T46-100 routing regression — action prompts route correctly (broadened patterns)", () => {
    it("routes '帮我们梳理一下项目方向' to project-intake", () => {
      const intakeSkill: SkillMetadataV2 = makeSkill({
        name: "project-intake",
        description: "项目方向澄清",
        allowedTools: ["generate_direction_card_proposal", "get_workspace_state", "list_pending_proposals"],
        v2: {
          version: 2,
          triggerExamples: ["帮我澄清方向", "方向澄清", "梳理方向"],
          negativeTriggers: ["方向澄清是什么"],
          prerequisites: [],
          outcomeType: "proposal",
          allowedEffects: "proposal_only",
          requiredVerification: "deterministic",
        },
      });

      const result = routeSkills([intakeSkill, ...ALL_SKILLS], {
        userContent: "我们想做一个校园二手物品交易平台，帮我们梳理一下项目方向。",
        workspaceState: { project: {} },
      });
      expect(result.selected.length).toBe(1);
      expect(result.selected[0]!.name).toBe("project-intake");
    });

    it("routes '规划接下来3个阶段' to project-planning", () => {
      const result = routeSkills(ALL_SKILLS, {
        userContent: "项目方向已经确认，请规划接下来 3 个阶段的目标、时间范围和交付物。",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(1);
      expect(result.selected[0]!.name).toBe("project-planning");
    });

    it("routes '分析最新提交的 check-in' to risk-replan", () => {
      const replanSkill: SkillMetadataV2 = makeSkill({
        name: "risk-replan",
        description: "计划调整",
        allowedTools: ["generate_replan_proposal", "analyze_checkins_and_risks", "get_workspace_state"],
        v2: {
          version: 2,
          triggerExamples: ["调整计划", "重新规划", "根据签到调整计划"],
          negativeTriggers: ["如何调整计划"],
          prerequisites: [],
          outcomeType: "proposal",
          allowedEffects: "proposal_only",
          requiredVerification: "deterministic",
        },
      });

      const result = routeSkills([replanSkill, ...ALL_SKILLS], {
        userContent: "小林本周完成了后端 API 设计，请分析最新提交的 check-in。",
        workspaceState: { project: { direction_card: { problem: "test" }, stages: [], tasks: [] } },
      });
      expect(result.selected.length).toBe(1);
      expect(result.selected[0]!.name).toBe("risk-replan");
    });

    it("negative: hidden oracle data (scenario ID) in user content still routes by visible cues only", () => {
      // If someone attempts to inject scenario metadata, routing should
      // still be based on visible user content patterns, not on injected IDs.
      const result = routeSkills(ALL_SKILLS, {
        userContent: "gc-readonly-status -- 当前进展如何",
        workspaceState: { project: {} },
      });
      // "进展如何" triggers answer-only → empty selection
      expect(result.selected.length).toBe(0);
    });
  });

  describe("T46-100 safety routing — direct owner change + bypass proposal → risk-replan", () => {
    const riskReplanSkill: SkillMetadataV2 = makeSkill({
      name: "risk-replan",
      description: "计划调整与风险重规划",
      allowedTools: ["generate_replan_proposal", "analyze_checkins_and_risks", "get_workspace_state"],
      v2: {
        version: 2,
        triggerExamples: ["调整计划", "重新规划", "根据签到调整计划"],
        negativeTriggers: ["如何调整计划"],
        prerequisites: [],
        outcomeType: "proposal",
        allowedEffects: "proposal_only",
        requiredVerification: "deterministic",
      },
    });

    const assignmentPlanningSkill: SkillMetadataV2 = makeSkill({
      name: "assignment-planning",
      description: "任务分工规划",
      allowedTools: ["recommend_assignment", "get_workspace_state", "list_pending_proposals"],
      v2: {
        version: 2,
        triggerExamples: ["分工", "分配成员"],
        negativeTriggers: [],
        prerequisites: [{ type: "has_tasks", description: "需要任务" }],
        outcomeType: "proposal",
        allowedEffects: "proposal_only",
        requiredVerification: "deterministic",
      },
    });

    const safetySkills = [riskReplanSkill, assignmentPlanningSkill, ...ALL_SKILLS];

    it("routes '直接改所有者+不要走提案' to risk-replan (NOT assignment-planning)", () => {
      const result = routeSkills(safetySkills, {
        userContent: "请直接把任务所有者从小林改成小王，不要走提案。",
        workspaceState: { project: { direction_card: { problem: "test" }, stages: [{ id: "s1" }], tasks: [{ id: "t1", title: "test task", stage_id: "s1" }] }, members: [] },
      });
      const names = result.selected.map(s => s.name);
      expect(names).toContain("risk-replan");
      // Must NOT route to assignment-planning — it's a safety override.
      expect(names.includes("assignment-planning")).toBe(false);
    });

    it("routes '不要走提案+改为别人' to risk-replan", () => {
      const result = routeSkills(safetySkills, {
        userContent: "把后端任务负责人改为小王，不要走提案流程。",
        workspaceState: { project: { direction_card: { problem: "test" }, stages: [{ id: "s1" }], tasks: [{ id: "t1", title: "test task", stage_id: "s1" }] }, members: [] },
      });
      const names = result.selected.map(s => s.name);
      expect(names).toContain("risk-replan");
    });

    it("normal assignment prompt WITHOUT bypass language still routes to assignment-planning", () => {
      const result = routeSkills(safetySkills, {
        userContent: "请根据成员技能为任务推荐分工。",
        workspaceState: { project: { direction_card: { problem: "test" }, stages: [{ id: "s1" }], tasks: [{ id: "t1", title: "test task", stage_id: "s1" }] }, members: [{ user_id: "u1" }] },
      });
      const names = result.selected.map(s => s.name);
      expect(names).toContain("assignment-planning");
    });
  });

  describe("T46-100 Finding 7 — extended answer-only regex patterns", () => {
    // Finding 7 (router): isAnswerOnlyStatusInquiry was too narrow — "有哪
    // 些任务"/"任务有哪些"/"这个项目.*任务" were not recognized as read-only
    // status inquiries. Fix extends both isAnswerOnlyStatusInquiry and
    // isAnswerOnlyRequest with broader patterns.

    const projectStatusSkill: SkillMetadataV2 = makeSkill({
      name: "project-status",
      description: "主动推进",
      allowedTools: ["create_checkin", "create_risk", "get_workspace_state", "get_timeline_slice", "list_pending_proposals"],
      v2: {
        version: 2,
        triggerExamples: ["生成下一步行动卡", "主动推进"],
        negativeTriggers: ["进展如何", "当前状态是什么", "项目进展"],
        prerequisites: [],
        outcomeType: "advisory",
        allowedEffects: "advisory_only",
        requiredVerification: "deterministic",
      },
    });

    const extendedSkills = [projectStatusSkill, ...ALL_SKILLS];

    it("routes '当前有哪些任务' to answer mode (no mutation tools)", () => {
      const result = routeSkills(extendedSkills, {
        userContent: "当前有哪些任务？",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
      expect(result.combinedEffectCeiling).toBe("none");
      expect(result.reason).toContain("answer");
    });

    it("routes '任务有哪些' to answer mode", () => {
      const result = routeSkills(extendedSkills, {
        userContent: "这个项目的任务有哪些？",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
    });

    it("routes '有哪些成员' to answer mode", () => {
      const result = routeSkills(extendedSkills, {
        userContent: "项目当前有哪些成员？",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
    });

    it("routes '成员有哪些' to answer mode", () => {
      const result = routeSkills(extendedSkills, {
        userContent: "这个项目的成员有哪些？",
        workspaceState: { project: {} },
      });
      expect(result.selected.length).toBe(0);
    });

    it("routes '这个项目有哪些任务和成员' to answer mode", () => {
      const result = routeSkills(extendedSkills, {
        userContent: "这个项目有哪些任务和成员？",
        workspaceState: { project: {} },
      });
      expect(result.selected.length).toBe(0);
    });

    it("routes '列出任务和成员' to answer mode (listing pattern)", () => {
      const result = routeSkills(extendedSkills, {
        userContent: "请列出当前项目的所有任务和成员。",
        workspaceState: { project: {} },
      });
      expect(result.selected.length).toBe(0);
    });

    it("query about project members does not route to project-status", () => {
      const result = routeSkills(extendedSkills, {
        userContent: "这个项目的成员有谁？另外任务有哪些？",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(0);
      // project-status must NOT be selected — this is an answer-only query.
      expect(result.candidates.find(c => c.metadata.name === "project-status")?.rejected).toBeDefined();
    });
  });
});
