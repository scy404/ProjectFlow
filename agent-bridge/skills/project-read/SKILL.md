---
name: project-read
description: 当用户询问项目状态时触发。只读查询项目当前状态，不产生任何副作用。
allowed-tools:
  - get_workspace_state
  - get_timeline_slice
  - list_pending_proposals
references: []
v2:
  version: 2
  triggerExamples:
    - "查看项目状态"
    - "当前进展如何"
    - "项目整体情况"
    - "告诉我项目进展"
    - "现在是什么状态"
    - "有哪些任务"
    - "列出任务"
    - "列出成员"
    - "项目进展如何"
    - "当前项目状态"
    - "回答当前项目状态"
  negativeTriggers:
    - "主动推进"
    - "生成行动卡"
    - "创建风险"
    - "修改"
    - "调整计划"
  prerequisites: []
  outcomeType: answer
  allowedEffects: none
  requiredVerification: none
---

# 项目状态只读查询

当用户询问项目当前状态时触发，只读查询，不产生任何副作用。

## 触发条件

- 用户询问"项目进展如何"、"当前状态是什么"等
- 用户说"查看项目状态"、"告诉我项目进展"
- 用户列出任务、成员等

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区完整状态（阶段、任务、成员）
2. 如果需要了解近期活动，调用 `get_timeline_slice`
3. 如果需要检查待处理提案，调用 `list_pending_proposals`
4. **只读**：只能调用上述只读工具，**禁止**调用任何写入工具（create_checkin、create_risk、generate_*_proposal 等）
5. 基于只读数据回答用户问题，使用中文自然语言

## 输出规范

- 所有输出使用中文
- 引用成员、任务、阶段时用显示名称（如「小林」、「后端 API 与数据模型」）
- 禁止输出任何原始 ID
- 无副作用，不修改任何项目状态
