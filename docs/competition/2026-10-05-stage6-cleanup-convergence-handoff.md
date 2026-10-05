# ProjectFlow 阶段 6 删除、收敛与文案清理交接

状态：已完成（2026-10-05）

分支：`codex/stage6-cleanup-convergence-20261005`

基线：fork `origin/main` 的 `f5a8f364f4292a9052d23af37af2855cac005359`（已包含 PR #9 合并回归修复）

## 执行边界

- 保留 Next.js、FastAPI、SQLite、Agent Bridge 架构，FastAPI 继续作为业务事实源。
- 保留 Proposal → Confirm，不新增多 Agent Runtime 或独立 Experiment 系统。
- 不删除十个项目页面、mock 模型或 seed 数据。
- 本阶段不新增数据库字段。
- 所有修改位于 fork 的独立分支，不直接修改 `main`。

## 审计结论

### TODO 6.1：失效或重复输入

- 项目创建表单已经没有 `teamSize` 输入；当前团队区域只读展示 Workspace 成员或 `team_size`，不重复采集。
- 项目创建表单已经没有裸 `createdBy` 输入；`created_by` 由完成身份初始化后的当前用户注入。
- localStorage 草稿保存的名称、想法、截止日期、项目模板和交付物都会进入正式创建请求，属于可恢复草稿，不冒充数据库事实。
- 仍存在旧草稿字段别名 `projectType`，本阶段将其删除，正式字段统一为 `projectTemplate`。

### TODO 6.2：重复导出实现

- `routes_export.py` 内存在完整评审摘要生成逻辑。
- `export_service.py` 还存在另一套未被正式 API 调用的摘要实现。
- `schemas/export.py` 已有 `ReviewSummaryRead`，路由却重复声明 `ExportResponse`。

处理方式：保留旧 API 路径作为兼容入口，但路由只负责 HTTP 错误映射和响应 Schema；完整业务逻辑统一迁入 `export_service.generate_review_summary()`；响应统一使用 `ReviewSummaryRead`。

### TODO 6.3：误导性行为与文案

- 删除首次进入 Agent 侧栏时自动弹出的 GuidedTour 及其未再使用的组件。
- “训练营要求”改为通用“项目要求”；seed 中描述具体演示背景的训练营事实不删除。
- 删除导出时间线中的 `demo handoff` 文案。
- 默认“三周阶段”改为由截止日期、交付物、团队容量和完成标准推导。
- 首页不再把硬编码百分比或数量作为项目成效数字展示，改为状态语义，并明确这些状态来自任务与风险事实。
- 自动重排表述改为“形成可确认建议”，与 Proposal → Confirm 一致。

## 修改台账

| 范围 | 修改 |
| --- | --- |
| 项目创建 | 删除旧 localStorage 草稿别名 `projectType`；保留正式草稿字段与身份注入 |
| 导出 | 统一业务实现、Schema 与兼容 API；新增委托特征测试 |
| Agent 引导 | 移除自动 GuidedTour 调用、导出和废弃组件 |
| 规划提示 | 用项目真实约束替换固定三周节奏，并同步前后端快捷回复与路由测试 |
| 产品文案 | 清理训练营限定、demo handoff、自动重排和无数据来源的展示数字 |
| 本文件 | 记录基线、审计判断、修改和验证结果 |

## 验证记录

- 后端阶段 6 及相邻关键链路：`178 passed`。
- 后端全量：`866 passed, 4 skipped, 67 failed, 2 errors`。失败仍来自基线中使用 2026-07/08 固定截止日期的旧测试，以及当前 Windows 环境缺少符号链接权限；本阶段新增与受影响测试未出现回归。
- 后端新增/重构文件：Ruff 检查通过，`compileall` 通过。
- 前端全量：`361 passed, 6 skipped`。
- 前端 lint 与生产构建：通过。
- Agent Bridge 相关回归：`284 passed`；TypeScript 类型检查通过。
- 清理扫描：产品代码中不再出现自动 GuidedTour、`训练营要求`、`demo handoff` 或固定三周规划提示。

## 已知基线问题与边界

- 本分支不放宽“项目截止日期不能早于当前日期”的生产校验，也不混入大范围旧测试日期维护；固定日期测试应在独立测试维护分支改为相对日期。
- Windows 符号链接用例应在独立维护中增加能力检测或条件跳过，不以降低资源安全校验换取通过。
- seed 数据中用于描述演示项目真实背景的训练营内容按约束保留，不属于通用产品文案。
