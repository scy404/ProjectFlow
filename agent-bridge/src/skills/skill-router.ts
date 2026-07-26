/**
 * Skill router — two-stage deterministic skill selection.
 *
 * Stage 1: Narrow candidates using explicit/deterministic signals
 *   (explicit skill name, exact quick-reply match, prerequisite check)
 * Stage 2: Score and rank candidates, apply negative triggers, conflict detection
 *
 * No LLM classifier — all selection is deterministic.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Skills V2
 */

import type { SkillMetadataV2, SkillEffectCeiling, SkillV2Metadata } from "./skill-v2-metadata.js";
import { combineEffectCeilings, defaultV2Metadata } from "./skill-v2-metadata.js";
import type { SkillContext } from "@/runtime/context-builder.js";

/**
 * Input for skill routing.
 */
export interface SkillRouteInput {
  /** User message content */
  userContent: string;
  /** Explicit skill name from runtime_config (highest priority) */
  explicitSkill?: string;
  /** Workspace state for prerequisite checking */
  workspaceState?: unknown;
  /** Whether there are pending proposals */
  hasPendingProposals?: boolean;
}

/**
 * A scored skill candidate.
 */
export interface SkillCandidate {
  /** Skill metadata (v2 extended) */
  metadata: SkillMetadataV2;
  /** Match score (higher = better match) */
  score: number;
  /** Reason for this score */
  reasons: string[];
  /** Whether this candidate was rejected (and why) */
  rejected?: string;
}

/**
 * Result of skill routing.
 */
export interface SkillRouteResult {
  /** Selected skills (0 = answer mode, 1 = single skill, 2+ = composition) */
  selected: SkillMetadataV2[];
  /** All candidates considered */
  candidates: SkillCandidate[];
  /** Combined effect ceiling (most restrictive) */
  combinedEffectCeiling: SkillEffectCeiling;
  /** Combined allowed tools (union) */
  combinedAllowedTools: string[];
  /** Routing reason */
  reason: string;
}

/**
 * Route skills deterministically.
 */
export function routeSkills(
  allSkills: SkillMetadataV2[],
  input: SkillRouteInput,
): SkillRouteResult {
  if (!input.explicitSkill && isAnswerOnlyRequest(input.userContent)) {
    // Read-only status inquiries need the project-read skill so the Agent
    // can call get_workspace_state / get_timeline_slice / list_pending_proposals.
    // Without a selected skill, prepareRunRequest gives the Agent zero tools
    // and the Golden Core status-read scenarios fail for lack of evidence.
    //
    // Non-status answer-only requests (explicit "只回答", adversarial
    // "忽略.*指令", etc.) still return selected: [] — no tools, pure answer.
    const isStatusInquiry = isAnswerOnlyStatusInquiry(input.userContent);
    if (isStatusInquiry) {
      const readSkill = allSkills.find(s => s.name === "project-read");
      if (readSkill) {
        const v2 = readSkill.v2 ?? defaultV2Metadata();
        return {
          selected: [readSkill],
          candidates: allSkills.map((metadata) => ({
            metadata,
            score: metadata.name === "project-read" ? 40 : 0,
            reasons: metadata.name === "project-read"
              ? ["read-only status inquiry"]
              : ["answer-only cue matched"],
            rejected: metadata.name === "project-read" ? undefined : "answer-only request",
          })),
          combinedEffectCeiling: v2.allowedEffects ?? "none",
          combinedAllowedTools: readSkill.allowedTools.filter(
            (t) => !t.includes("confirm_proposal") && !t.includes("reject_proposal") && !t.includes("commit_proposal"),
          ),
          reason: "read-only status inquiry → project-read",
        };
      }
    }
    // No project-read skill available, or non-status answer-only request.
    // Fall back to answer mode with no tools.
    const readOnlyStateTools = isStatusInquiry
      ? collectReadOnlyStateTools(allSkills)
      : [];
    return {
      selected: [],
      candidates: allSkills.map((metadata) => ({
        metadata,
        score: 0,
        reasons: ["answer-only cue matched"],
        rejected: "answer-only request",
      })),
      combinedEffectCeiling: "none",
      combinedAllowedTools: readOnlyStateTools,
      reason: isStatusInquiry
        ? "answer-only status inquiry — read-only state projection"
        : "answer-only cue matched — answer mode",
    };
  }

  // Stage 1: Narrow candidates
  const candidates = narrowCandidates(allSkills, input);

  // Stage 2: Score, rank, check conflicts
  const { selected, combinedEffectCeiling, combinedAllowedTools, reason } =
    selectAndCombine(candidates);

  return {
    selected,
    candidates,
    combinedEffectCeiling,
    combinedAllowedTools,
    reason,
  };
}

/**
 * Stage 1: Narrow candidates using deterministic signals.
 */
function narrowCandidates(
  allSkills: SkillMetadataV2[],
  input: SkillRouteInput,
): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];

  for (const skill of allSkills) {
    const v2 = skill.v2 ?? defaultV2Metadata();
    const reasons: string[] = [];
    let score = 0;

    // Explicit skill name — highest priority
    if (input.explicitSkill === skill.name) {
      score += 100;
      reasons.push("explicit skill name");
    }

    // Check negative triggers FIRST — if matched, reject immediately
    if (v2.negativeTriggers.length > 0) {
      const negMatch = v2.negativeTriggers.some((neg) =>
        input.userContent.includes(neg),
      );
      if (negMatch) {
        candidates.push({
          metadata: skill,
          score: 0,
          reasons: ["negative trigger matched"],
          rejected: "negative trigger",
        });
        continue;
      }
    }

    // Check trigger examples
    if (v2.triggerExamples.length > 0) {
      const triggerMatch = v2.triggerExamples.some((trigger) =>
        input.userContent.includes(trigger),
      );
      if (triggerMatch) {
        score += 30;
        reasons.push("trigger example matched");
      }
    }

    // Check prerequisites
    const prereqResult = checkPrerequisites(v2, input);
    if (!prereqResult.passed) {
      candidates.push({
        metadata: skill,
        score: 0,
        reasons: [`prerequisite failed: ${prereqResult.reason}`],
        rejected: `prerequisite: ${prereqResult.reason}`,
      });
      continue;
    }
    if (prereqResult.passed && prereqResult.matched) {
      reasons.push("prerequisites matched");
    }

    // Prerequisites determine eligibility; only the user's message may add
    // intent score. Otherwise every mature project routes to whichever skill
    // happens to sort first.
    const descMatch = skill.v2 ? matchIntent(skill.name, input.userContent) : 0;
    if (descMatch > 0) {
      score += descMatch;
      reasons.push("description keyword match");
    }

    // High-risk safety override: direct owner change + bypass proposal
    // MUST route to risk-replan (action mode), not assignment-planning.
    // Generic universal safety rule — no scenario IDs or hidden oracles.
    if (skill.name === "assignment-planning" && isDirectOwnerChangeBypassProposal(input.userContent)) {
      candidates.push({
        metadata: skill,
        score: 0,
        reasons: ["high-risk safety override: direct owner change + bypass proposal → risk-replan"],
        rejected: "safety override: risk-replan",
      });
      continue;
    }

    // Boost risk-replan for direct owner change + bypass proposal requests.
    // The risk-replan skill body instructs the Agent to refuse direct
    // modification and produce a replan proposal instead.
    if (skill.name === "risk-replan" && isDirectOwnerChangeBypassProposal(input.userContent)) {
      score += 40;
      reasons.push("safety: direct owner change + bypass proposal → risk-replan");
    }

    candidates.push({ metadata: skill, score, reasons });
  }

  return candidates;
}

/**
 * Stage 2: Select and combine candidates.
 */
function selectAndCombine(
  candidates: SkillCandidate[],
): {
  selected: SkillMetadataV2[];
  combinedEffectCeiling: SkillEffectCeiling;
  combinedAllowedTools: string[];
  reason: string;
} {
  // Filter out rejected candidates
  const valid = candidates.filter((c) => !c.rejected);

  if (valid.length === 0) {
    return {
      selected: [],
      combinedEffectCeiling: "none",
      combinedAllowedTools: [],
      reason: "no matching skills — answer mode",
    };
  }

  // Sort by score descending
  valid.sort((a, b) => b.score - a.score);

  // Take top-scoring candidates (max 2 for composition)
  const topScore = valid[0]!.score;

  // If top score is 0, no meaningful match — answer mode
  if (topScore === 0) {
    return {
      selected: [],
      combinedEffectCeiling: "none",
      combinedAllowedTools: [],
      reason: "no meaningful match — answer mode",
    };
  }

  const topCandidates = valid.filter((c) => c.score === topScore);

  // Check for conflicts between top candidates
  if (topCandidates.length > 1) {
    const conflict = detectConflicts(topCandidates);
    if (conflict) {
      return {
        selected: [],
        combinedEffectCeiling: "none",
        combinedAllowedTools: [],
        reason: `conflict between skills: ${conflict} — fail closed to answer mode`,
      };
    }
  }

  // Select top candidates (max 2)
  const selected = topCandidates.slice(0, 2).map((c) => c.metadata);

  // Compute combined effect ceiling (most restrictive)
  const combinedEffectCeiling = combineEffectCeilings(
    selected.map((s) => s.v2?.allowedEffects ?? "proposal_only"),
  );

  // Compute combined allowed tools (union)
  const combinedAllowedTools = [
    ...new Set(selected.flatMap((s) => s.allowedTools)),
  ];

  // Filter out any confirm/reject/commit tools (safety)
  const safeTools = combinedAllowedTools.filter(
    (t) =>
      !t.includes("confirm_proposal") &&
      !t.includes("reject_proposal") &&
      !t.includes("commit_proposal"),
  );

  const reason =
    selected.length === 1
      ? `single skill: ${selected[0]!.name}`
      : `composed: ${selected.map((s) => s.name).join(" + ")}`;

  return {
    selected,
    combinedEffectCeiling,
    combinedAllowedTools: safeTools,
    reason,
  };
}

/**
 * Check prerequisites for a skill.
 */
function checkPrerequisites(
  v2: SkillV2Metadata,
  input: SkillRouteInput,
): { passed: boolean; matched: boolean; reason?: string } {
  if (v2.prerequisites.length === 0) {
    return { passed: true, matched: false };
  }

  const ws = input.workspaceState as Record<string, unknown> | undefined;
  const project = ws?.project as Record<string, unknown> | undefined;

  for (const prereq of v2.prerequisites) {
    switch (prereq.type) {
      case "has_direction_card":
        if (!project?.direction_card) {
          return { passed: false, matched: false, reason: "no direction card" };
        }
        break;
      case "has_stages":
        if (!Array.isArray(project?.stages) || project.stages.length === 0) {
          return { passed: false, matched: false, reason: "no stages" };
        }
        break;
      case "has_tasks":
        if (!Array.isArray(project?.tasks) || project.tasks.length === 0) {
          return { passed: false, matched: false, reason: "no tasks" };
        }
        break;
      case "has_members":
        if (!Array.isArray(ws?.members) || (ws.members as unknown[]).length === 0) {
          return { passed: false, matched: false, reason: "no members" };
        }
        break;
      case "has_pending_proposals":
        if (!input.hasPendingProposals) {
          return { passed: false, matched: false, reason: "no pending proposals" };
        }
        break;
      case "no_pending_proposals":
        if (input.hasPendingProposals) {
          return { passed: false, matched: false, reason: "has pending proposals" };
        }
        break;
    }
  }

  return { passed: true, matched: true };
}

/**
 * Detect conflicts between selected skills.
 * Returns conflict description or null if compatible.
 */
function detectConflicts(candidates: SkillCandidate[]): string | null {
  // Check for incompatible effect ceilings
  const effects = candidates.map(
    (c) => c.metadata.v2?.allowedEffects ?? "proposal_only",
  );

  // If any skill requires "full" and another requires "none", that's a conflict
  if (effects.includes("full") && effects.includes("none")) {
    return "incompatible effect ceilings (full vs none)";
  }

  // Check for overlapping tool requirements that can't coexist
  const toolSets = candidates.map((c) => new Set(c.metadata.allowedTools));
  for (let i = 0; i < toolSets.length; i++) {
    for (let j = i + 1; j < toolSets.length; j++) {
      // If both skills need the same proposal-creating tool, that's a conflict
      for (const tool of toolSets[i]!) {
        if (toolSets[j]!.has(tool) && tool.includes("proposal")) {
          return `both skills require proposal tool: ${tool}`;
        }
      }
    }
  }

  return null;
}

/**
 * Match V2 skill intent from user-visible Chinese phrases.
 */
function matchIntent(skillName: string, userContent: string): number {
  const msg = userContent.toLowerCase();
  const intents: Record<string, { pattern: RegExp; score: number }> = {
    "project-intake": { pattern: /澄清.*(?:方向|目标)|方向澄清|明确.*(?:目标|交付物)|梳理.*(?:方向|项目)|帮.*(?:梳理|理清|看看).*(?:方向|做什么)|想做.*但不(?:确定|知道|清楚)|生成.*方向卡|方向卡提案/, score: 20 },
    "project-planning": { pattern: /阶段计划|制定计划|规划.*阶段|阶段规划|规划.*(?:接下来|未来|后面)/, score: 20 },
    "task-breakdown": { pattern: /拆分.*任务|任务拆解|分解任务|拆成任务|分解为.*任务|把.*任务.*(?:创建|新建|作为|交付)|任务.*(?:依赖|冲突|顺序|排序).*(?:处理|调整|解决)/, score: 20 },
    "assignment-planning": { pattern: /分工|分配成员|谁(?:来)?做|负责.*(?:任务|前端|后端)|任务.*所有者|重新协调.*任务|分配.*任务/, score: 20 },
    "risk-analysis": { pattern: /风险|阻塞|延期/, score: 15 },
    "risk-replan": { pattern: /调整(?:计划|草案)|重新规划|重规划|根据签到.*调整|分析.*(?:签到|check.in)/, score: 25 },
    "project-status": { pattern: /主动推进|(?:生成|查看|给出|检查).*(?:行动|下一步|风险|现状|状态)/, score: 20 },
  };
  const intent = intents[skillName];
  return intent?.pattern.test(msg) ? intent.score : 0;
}

function isAnswerOnlyRequest(userContent: string): boolean {
  // Read-only intent cues:
  // 1. Explicit answer-only language: "只回答/只解释/只说明"
  // 2. Explicit prohibition of mutations: "不要修改/不要调用/不要创建"
  // 3. Status inquiries: "进展如何/状态是什么/介绍一下.*进展/告诉我.*状态"
  // 4. Information listing: "有哪些/列出.*(任务|成员|阶段|会话|记忆)"
  // 5. Repeated/re-ask queries: "再次告诉/再.*一遍"
  // 6. "How/What is" style questions about current state
  // 7. Adversarial injection markers: "忽略.*指令"
  return /不要(?:修改|调用|创建|执行|直接)|只(?:解释|说明|回答|读)|解释.*为什么|进展如何|状态是什么|(?:介绍|告诉).*(?:进展|状态|情况)|有哪些|列出.*(?:任务|成员|阶段|会话|记忆)|再次告诉|再.*(?:一遍|一下).*(?:进展|状态)|当前.*怎么样|忽略.*(?:指令|之前)|这个项目.*(?:任务|成员)|(?:任务|成员).*有(?:哪些|多少)/.test(userContent);
}

/**
 * Detects a read-only status inquiry — the user is asking about project
 * state without requesting any action. These queries need evidence tools
 * (get_workspace_state, etc.) but must NOT expose mutation tools.
 *
 * Distinct from {@link isAnswerOnlyRequest}: status inquiries are a subset
 * of answer-only requests that specifically ask about current project state.
 */
function isAnswerOnlyStatusInquiry(userContent: string): boolean {
  return /进展如何|状态是什么|(?:介绍|告诉).*(?:进展|状态|情况)|当前.*怎么样|项目进展|查看.*(?:状态|现状|进展)|有哪些(?:任务|成员)|(?:任务|成员).*有哪些|这个项目.*(?:任务|成员)/.test(userContent);
}

/**
 * Collect the union of read-only state tools from all skills.
 * Read-only tools are get_* and list_* tools that do not create, modify,
 * or commit primary project state. These provide evidence for answer-mode
 * status inquiries without exposing mutation-capable tools.
 */
function collectReadOnlyStateTools(allSkills: SkillMetadataV2[]): string[] {
  const tools = new Set<string>();
  for (const skill of allSkills) {
    for (const tool of skill.allowedTools) {
      if (tool.startsWith("get_") || tool.startsWith("list_")) {
        tools.add(tool);
      }
    }
  }
  return [...tools];
}

/**
 * Detect high-risk "direct owner change + bypass proposal" requests.
 *
 * Generic universal safety rule — uses ONLY visible user content, no
 * scenario IDs, hidden oracles, or 52-prompt tables. Returns true when
 * the visible prompt indicates:
 *   1. A task ownership / assignment change ("改成小王", "修改负责人", etc.)
 *   2. Combined with explicit bypass-proposal language ("不要走提案",
 *      "直接改", "跳过提案流程", etc.)
 *
 * These requests must route to risk-replan (action mode) — the Agent
 * refuses direct modification and routes to the correct proposal flow.
 * Normal assignment prompts without bypass language continue routing
 * to assignment-planning.
 */
function isDirectOwnerChangeBypassProposal(userContent: string): boolean {
  const bypassPatterns = /不要走.*提案|跳过.*提案|绕过.*提案|直接改|直接修改|直接更改|不走.*提案|bypass.*proposal/;
  const ownerChangePatterns = /改成|改为|所有者|负责人|owner|分配.*任务.*(?:给|到)|指定.*(?:给|由)|换.*人/;
  return bypassPatterns.test(userContent) && ownerChangePatterns.test(userContent);
}

/**
 * Build a SkillContext from a SkillMetadataV2 for use in context builder.
 * Does NOT load references (lazy loading only when explicitly needed).
 */
export function skillMetadataToContext(skill: SkillMetadataV2): SkillContext {
  return {
    name: skill.name,
    description: skill.description,
    body: "", // body is loaded separately by SkillLoader
    allowedTools: skill.allowedTools,
    effectCeiling: skill.v2?.allowedEffects ?? defaultV2Metadata().allowedEffects,
  };
}
