---
name: task-breakdown
description: 当需要拆分任务时触发。将阶段目标分解为可执行的任务。
allowed-tools:
  - generate_task_breakdown_proposal
  - get_workspace_state
references:
  - references/breakdown-checklist.md
v2:
  version: 2
  triggerExamples:
    - "拆成任务"
    - "任务拆解"
    - "分解任务"
    - "把当前阶段拆成任务"
    - "分解为"
  negativeTriggers:
    - "任务分解是什么"
    - "如何拆分任务"
  prerequisites:
    - type: has_stages
      description: 必须有阶段才能拆分任务
  outcomeType: proposal
  allowedEffects: proposal_only
  requiredVerification: deterministic
---

# 任务拆分

当阶段计划已确定，需要将阶段目标分解为具体任务时触发。

## 触发条件

- 用户提到"拆分"、"任务"、"分解"
- 当前阶段需要任务拆分
- 阶段计划已确认

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区状态（阶段目标、交付物、成员技能等）
2. **只拆解当前活跃阶段（状态=进行中）**。忽略已完成和待开始的阶段。如果没有活跃阶段，选择第一个待开始阶段。
3. **自己生成任务拆解内容**：基于当前活跃阶段的目标和完成标准，推理出：
   - `tasks`：每个任务含 stage_id（指向当前活跃阶段，**必填**，Pydantic 校验不通过会拒绝整个输出）、title、description、priority、due_date、estimated_hours、dependency_ids、acceptance_criteria、task_kind、validation_spec、can_cut、order_index、reason
   - 普通交付任务使用 `task_kind=delivery`，不填写 `validation_spec`
   - 当项目方向卡存在与当前阶段相关的验证假设时，可生成 `task_kind=validation`；其 `validation_spec` 必须包含 hypothesis、method、success_criterion，可选 sample_target
   - `project_template=competition` 的 OPC 项目应至少覆盖一个真正影响方向或计划的验证任务，但不能把全部任务都改成验证任务
   - **每个任务的 stage_id 必须与当前活跃阶段的 id 一致，缺失或为空会被后端拒绝**
   - `reason`：生成理由
   - `requires_confirmation`: true
3. **必须调用** `generate_task_breakdown_proposal`，将生成的任务拆解内容作为 `output` 参数传入。
   - 用户点击了此按钮，意味着他们想要生成或更新任务拆解
   - 即使阶段已有任务，也必须生成新提案（标注改进点）
   - **禁止**只做分析不调用工具——工具调用是唯一能落库的方式

## 输出规范

- 任务标题简洁明确
- 包含优先级和预估时间
- 考虑任务间依赖关系
- 可砍标记（can_cut）用于范围管理
- 验证任务用于记录假设、方法、成功标准和样本目标；交付任务行为保持不变
- 普通模板没有验证假设时不要强制生成验证任务
- 到期时间必须从当前日期、阶段边界、依赖与工作量推导，不使用固定周期
- 不直接修改项目状态
- `output` 必须符合 TaskBreakdownOutput schema（tasks 必填，每个 task 含 title/description/priority/due_date）
- **所有任务的 stage_id 必须指向同一个当前活跃阶段**，不要跨阶段拆解
- ⚠️ **命名规则**：引用成员/任务/阶段时必须用「」包裹的显示名（如「Mia」、「后端 API 与数据模型」），依赖项引用任务 title，**禁止**出现任何原始 ID
