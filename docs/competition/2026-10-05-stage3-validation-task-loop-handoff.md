# 阶段 3：验证任务闭环 Handoff

## 1. 分支与基线

- 实施日期：2026-10-04 至 2026-10-05
- 实施分支：`codex/stage3-validation-loop-20261004`
- 基线提交：`1dc8d87`（阶段 2.4 回退完成，保留左侧栏修改）
- 分支关系：本分支直接包含上一轮 `codex/revert-stage2-guided-tour-20261004` 的完整提交历史。
- 架构边界：保留 Next.js、FastAPI、SQLite、Agent Bridge 和 Proposal → Confirm；没有新增 Experiment 表、独立验证系统或多 Agent Runtime。

## 2. 实施结论

TODO 3.1 至 3.6 已按依赖顺序完成。验证被实现为 Task 的一种类型：普通任务继续默认为 `delivery`，验证任务使用 `validation`，验证要求与结果随 Task 正式落库、经 FastAPI 返回、进入 Agent 状态并在前端读写。

计划调整仍然遵循 Proposal → Confirm：提交验证结果只记录事实、可由用户明确选择完成任务并写入时间线，不会直接修改阶段计划；`adjust`、`stop`、`inconclusive` 由风险分析和 replan skill 解释并生成带证据引用的建议。

## 3. TODO 验收台账

| TODO | 完成内容 | 验收结论 |
| --- | --- | --- |
| 3.1 扩展 Task | 新增 `task_kind` 索引、`validation_spec`、`validation_result`，并增加 `ValidationSpec`、`ValidationResult` | 历史行由 SQLite 默认值读取为 `delivery`；没有新增 Experiment 表 |
| 3.2 同步读写链路 | 同步 Task Create/Update/Read、服务序列化、TaskBreakdownItem、Proposal 确认、Project/WorkspaceState、前端类型与标准化 | Agent 验证任务可落库，刷新后字段保持；交付任务默认行为不变 |
| 3.3 结果提交接口 | 新增 `PUT /api/tasks/{task_id}/validation-result?viewer_user_id=...` | 拒绝交付任务、跨项目证据和伪造署名；服务端写入用户与时间，并记录 validation 时间线事件 |
| 3.4 Agent 生成验证任务 | `project_template` 进入 WorkspaceState/上下文；更新 intake、planning、task-breakdown、risk-analysis、risk-replan 现有 skills 与工具 Schema | competition/OPC 上下文可产生验证任务；普通模板不强制；无固定“三周”周期 |
| 3.5 前端交互 | 验证徽标、要求卡片、结果对话框、资源证据选择、结果决策、Agent 影响 CTA | 用户不接触 JSON；资源显示标题而非裸 ID；未提交/已提交状态可区分 |
| 3.6 风险与重规划 | 风险/replan 上下文包含验证结果；task change 支持 `evidence_refs`；skills 明确处理 adjust/stop/inconclusive | 建议可引用 task/resource；确认前不改计划，拒绝 Proposal 不落地 |

## 4. 数据契约与迁移

### Task 新字段

```text
task_kind: delivery | validation  (NOT NULL, default delivery, indexed)
validation_spec: JSON text | null
  hypothesis
  method
  success_criterion
  sample_target
validation_result: JSON text | null
  summary
  observed_value
  decision: validated | adjust | stop | inconclusive
  evidence_resource_ids
  recorded_by
  recorded_at
```

SQLite 迁移是幂等的：对旧 `tasks` 表逐列补齐，历史任务获得数据库级默认值 `delivery`，验证 JSON 保持 `NULL`，并创建 `ix_tasks_task_kind`。测试覆盖重复执行迁移和旧行保留，不依赖删除数据库重建。

### 写入边界

- `recorded_by`、`recorded_at` 不属于提交 body，`ValidationResultSubmit` 禁止额外字段。
- 当前应用尚无统一登录 token，因此沿用现有受验证的 `viewer_user_id` 会话上下文：服务端检查用户存在且属于项目工作区，再以该身份署名。
- 证据资源逐个检查存在性和 `project_id`，跨项目引用返回 400。
- `mark_complete=true` 复用现有任务状态更新路径；否则只写验证结果。
- 无论是否完成任务，都会写入 `AgentEvent(event_type=validation)`，输出快照明确记录 `plan_changed=false`。

## 5. Agent 行为变更

- `project-intake`：competition/OPC 场景形成可检验假设与成功信号；assumptions 和 unknowns 分离，普通项目允许为空。
- `project-planning`：把交付活动和验证活动共同排入真实截止日期范围，不使用固定天数或“三周”模板。
- `task-breakdown`：输出 `task_kind` 和完整 `validation_spec`；只有上下文需要时才生成验证任务。
- `risk-analysis`：理解 `adjust`、`stop`、`inconclusive`，无结论不被误写成失败，建议引用任务或资源证据。
- `risk-replan`：只生成待确认 Proposal；验证结果触发的 task change 必须附 `evidence_refs`，拒绝时原计划保持不变。
- Agent Bridge 工具清单同步公开 task breakdown 与 replan 的结构化字段，防止 Sidecar 输出在 FastAPI 校验前丢失语义。

## 6. 前端交互记录

- “我的任务”和“团队任务”显示验证任务徽标、假设、方法、成功标准、样本目标和结果状态。
- 未提交结果时显示明确空状态，并隐藏直接“完成”快捷操作；用户通过“填写结果”决定是否同时完成任务。
- 结果对话框支持摘要、观察值、四种决策、项目资源多选和完成选项。
- 已绑定证据只展示资源标题；前端不把数据库 ID 当用户文案展示。
- 已提交结果显示决策与观察值，并提供“查看 Agent 影响”入口，入口触发现有 replan 流程而非直接改计划。
- 阶段计划中的任务拆解板同步显示验证类型、验证要求和结果，避免同一 Task 在不同页面语义不一致。

## 7. 文件级修改台账

| 层 | 文件 | 主要修改 |
| --- | --- | --- |
| Model/Enum | `backend/app/models/enums.py`, `backend/app/models/task.py` | TaskKind、ValidationDecision、validation 时间线类型及三项 Task 字段 |
| Schema | `backend/app/schemas/task.py`, `backend/app/schemas/replan.py`, `backend/app/schemas/workspace_state.py` | 验证 Schema、提交契约、replan 证据引用、Agent 状态字段 |
| Migration | `backend/app/core/database.py` | 旧 SQLite 的幂等列迁移、默认值和索引 |
| Service/API | `backend/app/services/task_service.py`, `backend/app/api/routes_tasks.py` | JSON 读写、结果校验/署名/时间线、PUT 接口 |
| State | `backend/app/services/project_state_service.py`, `backend/app/services/workspace_state_service.py` | Task 验证字段与 project_template 进入正式状态 |
| Agent | `backend/app/agent/output_schemas.py`, `backend/app/agent/prompts.py`, `backend/app/services/agent_proposal_service.py` | breakdown 输出、上下文、验证任务持久化和 replan 证据 |
| Bridge | `agent-bridge/src/tools/projectflow-tools.ts`, `agent-bridge/skills/*/SKILL.md` | 工具 JSON Schema 与五个现有 skill 行为更新 |
| Frontend contract | `frontend/src/lib/types.ts`, `frontend/src/lib/api.ts` | Task 类型、标准化、结果提交 API |
| Frontend UI | `frontend/src/components/project/project-task-views.tsx`, `project-content.tsx`, `workspace-layout.tsx`, workspace page | 验证结果完整交互及回调链 |
| Frontend secondary views | `frontend/src/components/task/task-breakdown-board.tsx`, `task-status-update.tsx` | 验证语义展示与完整 TaskStatus 类型一致性 |
| Tests | `backend/app/tests/test_task_validation_loop.py`, `test_task_validation_migration.py`, `frontend/src/lib/api.test.ts`, `project-task-views.test.tsx` | 迁移、持久化、安全边界、时间线、API 和 UI 交互 |

## 8. 验证结果

通过项：

- Backend 定向契约：`41 passed`。
- Backend 受影响扩展集：`149 passed`；另有 5 个既有固定日期用例失败，均在 `test_replan_proposal_flow.py` 使用已经过去的 2026-08 截止日，失败发生在创建 Project 阶段。
- Backend 全量：`865 passed, 4 skipped, 67 failed, 2 errors`。相较阶段 0 记录的 `855 passed`，本阶段新增后端测试全部进入通过数；67/2 的失败结构仍由过期固定日期与 Windows symlink 权限构成。
- Frontend 全量（加入新交互测试前）：`359 passed, 6 skipped`；新增验证任务交互测试：`1 passed`。
- Frontend `npm run lint`：通过。
- Frontend `npm run build`：通过，包括 TypeScript 检查和静态页面生成。
- Agent Bridge `npm run build`：通过。
- Agent Bridge 本次直接相关用例：`276 passed`（`projectflow-tools.test.ts`、`skill-lint.test.ts`、`skills.test.ts`）。
- 浏览器烟测：开发服务热更新后“我的任务”页正常打开，原演示任务及阶段 2 左侧导航无崩溃或路由回归。

全量基线说明：

- Agent Bridge 全量为 `2617 passed / 36 failed / 24 errors`。失败集中在既有 Evaluation Lab 对 Linux `bash`、`cat`、`ln`、`backend/.venv/bin/python`、Unix `node_modules/.bin/tsx`、Node 24.15.0 和 Windows symlink 权限的环境假设，以及过期价格表/环境校验；本次直接修改的工具与 skill 测试通过。
- 不为使测试变绿而放宽生产截止日期校验，也不在本功能分支批量改写历史测试日期或 Evaluation Lab 跨平台基础设施。

## 9. 风险与后续边界

- 当前会话身份仍是项目既有的 `viewer_user_id` 模式；阶段 5“会话和权限”完成后，应改为认证中间件提供的主体，接口 body 无需变化。
- 当前演示种子没有强制新增验证结果，以保留 mock/种子兼容；通过 Agent 生成或普通 API 创建的 validation Task 可完整演示闭环。
- 旧测试固定日期与 Evaluation Lab Windows 兼容属于独立测试维护工作，应另开分支处理，避免污染阶段 3 数据与业务改造。

## 10. 提交与推送

- 实现提交：待提交后补充。
- 远端分支：待推送后补充。
- 上一轮分支：`codex/revert-stage2-guided-tour-20261004`，按用户要求与本分支一起推送。
