---
name: project-retrospective
description: 当用户要求生成项目复盘时使用。基于项目事实和时间线形成结构化复盘，不修改项目主事实。
allowed-tools:
  - get_workspace_state
  - get_timeline_slice
  - generate_retrospective
references: []
v2:
  version: 2
  triggerExamples:
    - "生成项目复盘"
    - "总结项目经验"
    - "回顾项目成果和挑战"
  negativeTriggers:
    - "导出项目成果"
    - "调整项目计划"
  prerequisites: []
  outcomeType: advisory
  allowedEffects: advisory_only
  requiredVerification: deterministic
---

# 项目复盘

基于数据库中的项目状态和近期时间线，生成一份可追溯、结构化的项目复盘。

## 工作流程

1. 调用 `get_workspace_state` 读取项目、阶段、任务、验证结果、风险和行动项。
2. 调用 `get_timeline_slice` 读取近期关键决策与事件。
3. 只总结可由上述事实支持的成果、挑战和经验；不得编造完成情况、成员行为、指标或影响。
4. 调用 `generate_retrospective`，且只调用一次，提交以下结构：
   - `project_summary`：从启动到当前状态的客观回顾。
   - `key_achievements`：真实完成或已确认的成果；无成果时允许空数组。
   - `challenges`：有事实依据的风险、阻塞或取舍；无记录时允许空数组。
   - `lessons_learned`：由实际过程推导的可复用经验；证据不足时允许空数组。
   - `overall_assessment`：当前状态的客观评价，不使用无法计算的效率或成功率。
   - `reason`：说明本次复盘使用了哪些项目事实类型。
   - `requires_confirmation`：固定为 `false`。
5. 工具成功后结束，不创建 Proposal，不修改 Project、Stage、Task、负责人或日期。

## 输出约束

- 所有面向用户的文本使用中文。
- 引用成员、任务、阶段时使用显示名称，不输出原始 ID。
- 不把建议写成已完成事实。
- 不输出百分比置信度，不声称节省时间或提升效率。
- 禁止绕过 `generate_retrospective` 仅返回自由文本；页面只读取经 FastAPI 校验并持久化的结构化结果。
