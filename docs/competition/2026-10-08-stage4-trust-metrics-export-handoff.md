# 阶段 4：可信解释、事实指标与统一导出交接记录

日期：2026-10-08
基线：fork `origin/main`，commit `678827e`
开发分支：`codex/stage4-trust-metrics-export-20261008`

## 1. 范围与边界

本分支按 TODO 4.1–4.7 完成可信状态、证据解析、数据库事实指标、关键事件、统一导出与成果页改造。以下既有边界未改变：

- Next.js、FastAPI、SQLite、Agent Bridge 架构保持不变；
- FastAPI 和数据库仍是项目事实源；
- Proposal → Confirm 仍是高影响状态修改的确认边界；
- 未新增多 Agent Runtime 或独立 Experiment 系统；
- 未删除项目页面、mock 模型或演示种子数据；
- 未引入“节省时间”“效率提升”“成功率”等无法由数据库计算的指标。

## 2. TODO 4.1：可信状态

新增前端 `deriveTrustState()`，只从现有 AgentEvent、Proposal 和 unknowns 推导：

- 输出形态：结构化、叙述性、无有效输出；
- 生成状态：正常、修复后、fallback、失败、暂无记录；
- Proposal 状态：待确认、已确认、已拒绝、无需 Proposal；
- unknowns 数量。

页面不计算或展示百分比置信度。`repaired`、`fallback` 和 `failed` 使用不同状态文案，不能伪装为正常生成。

## 3. TODO 4.2：EvidenceDrawer 与解析边界

新增：

- `frontend/src/lib/evidence-resolver.ts`
- `frontend/src/components/ui/evidence-drawer.tsx`

Resolver 只在当前已加载、当前身份可见的 `ProjectState` 中解析资源、任务、验证结果、阶段、风险、行动卡、分工、成员和项目引用。引用不存在或不在当前可见状态时，仅显示“引用已失效或当前不可见”，不回显裸 ID。

Drawer 已接入 DirectionCard、Risk、AssignmentProposal、ActionCard 和通用 Agent Proposal。展示生成理由、结构化证据、unknowns、生成状态、确认状态及建议影响对象；没有关联 AgentEvent 时明确显示“暂无生成记录”。

## 4. TODO 4.3 与 4.7：项目事实指标

新增接口：

```text
GET /api/projects/{project_id}/metrics
```

新增 `metrics.py` Schema 和 `metrics_service.py`。指标及计算公式如下：

| 字段 | 计算规则 |
|---|---|
| `created_to_first_plan_seconds` | 项目创建时间到首个 `user_confirmed=true` 且状态非 failed 的 plan 事件的秒数；不存在则为 `null` |
| Proposal 决策比 | `(confirmed + rejected) / proposals_total` |
| 分工完成比 | `status=finalized / assignment proposals total` |
| 任务完成比 | `status=done / tasks total` |
| 验证有结论比 | 持久化了非空 `validation_result` 的 validation task / validation tasks total |
| 风险、行动卡 | 当前项目对应记录总数 |

所有比例均返回分子和分母；无记录时返回 0，不生成默认成果。成果页新增事实面板和计算说明；`is_demo=true` 时显示演示数据横幅。

## 5. TODO 4.4：事件与更新时间

- 验证结果提交事件沿用阶段 3 已完成实现；
- 统一导出成功时写入 export 事件，快照记录导出类型和事实数据；
- Proposal 确认沿用既有事件；
- Proposal 拒绝新增明确事件，记录 `decision=rejected` 和 `project_state_changed=false`；
- Risk、ActionCard 新增 `updated_at`，状态更新时刷新；
- SQLite 启动迁移幂等添加字段，并优先由 `created_at` 回填旧数据。

`updated_at` 已同步 SQLAlchemy/SQLModel、Pydantic、服务层、Project/Workspace Agent State、前端类型、标准化逻辑和测试。

## 6. TODO 4.5：统一导出

唯一核心服务为：

```python
generate_project_export(session, project_id, export_type)
```

支持：

- `review_summary`
- `opc_outcome`

新接口：

```text
POST /api/projects/{project_id}/exports
```

返回 Markdown 和本次导出使用的事实快照（metrics、验证结果、结构化证据引用）。旧接口 `POST /api/projects/{project_id}/export/review-summary` 保留兼容，但已委托给同一核心函数，不再维护第二套业务逻辑。

## 7. TODO 4.6：成果页

- 页面标题由“项目复盘”调整为“成果复盘”；
- 数据库事实面板与“AI 生成复盘”明确分区；
- 导出面板支持评审摘要/OPC 成果报告选择；
- 使用 Markdown 组件正确预览；
- 支持 `.md` 下载和复制；
- 导出纳入验证结果、证据引用、风险和行动项；
- 代码库中未发现用户可见的 `demo handoff` 流程文案，未制造无依据替换。

## 8. Agent 状态同步

WorkspaceState 新增结构化 `risks`、`action_cards`，包含 evidence refs、状态和更新时间；风险分析、重规划和复盘 Prompt 的压缩项目状态同步包含这些字段。Agent Bridge 输入继续使用既有 wire contract，未新增另一套事实源。

## 9. 测试与验收记录

新增/补充覆盖：

- metrics 计算、空值和比例；
- validation result 对指标的影响；
- 两类统一导出、事实快照、timeline 事件和旧接口委托；
- Risk/ActionCard `updated_at` 及旧 SQLite 回填；
- Proposal 拒绝事件；
- WorkspaceState 中 Risk/ActionCard 的 evidence 与更新时间；
- EvidenceRef 当前可见状态解析、失效引用不泄露 ID；
- repaired/fallback 等可信状态推导；
- 事实面板演示横幅和分子/分母展示；
- 导出面板 Markdown 与事实快照；
- 前端 API 契约。

最终回归（2026-10-09）：

| 范围 | 结果 |
|---|---|
| Backend `pytest -q` | `939 passed, 6 skipped, 0 failed` |
| Frontend Vitest | `368 passed, 6 skipped, 0 failed` |
| Frontend lint | 通过 |
| Frontend production build | 通过 |
| Agent Bridge typecheck | 通过 |
| Agent Bridge build | 通过 |
| Agent Bridge Vitest 串行全量 | `2651 passed, 4 skipped`；另有 1 条 Golden Core 测试在整套重型文件尾部耗时 5.09 秒，超过固定 5 秒阈值 |
| 上述超时用例隔离复跑 | `1 passed`，耗时 4.26 秒 |

Agent Bridge 的 4 条 skip 均为当前 Windows 环境无 symlink 权限的条件跳过。未放宽生产校验或测试阈值。全量首次并行运行还暴露了 Windows npx shim 无法将锁定版本传给 Git Bash 子进程的问题；最终使用隔离的 Node.js 24.15.0/npm 11.12.1 工具链同时覆盖 Windows 和 Git Bash 子进程，临时工具链未写入仓库。

## 10. 已知兼容说明

- 旧 SQLite 不需要删除重建；迁移为 Risk/ActionCard 增加并回填 `updated_at`。
- 前端对尚未迁移或旧响应缺少 `updated_at` 的情况暂以 `created_at` 标准化，正式数据库仍会迁移保存新字段。
- 事实指标反映“当前数据库记录”，不等同于因果归因、效率提升或比赛成功率。
