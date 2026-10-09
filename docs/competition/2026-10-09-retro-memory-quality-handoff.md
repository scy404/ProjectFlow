# 项目记忆排版与 AI 复盘链路修复交接记录

日期：2026-10-09  
基线：阶段 4 commit `81ee0c83647e7ee41a5cecbd3770f8e5f20aa539`  
开发分支：`codex/retro-memory-quality-20261009`  
功能实现提交：`695ec63`

## 1. 范围与边界

本分支修复“项目记忆”Markdown 可读性和“AI 生成复盘”异常结果导致整页错误边界的问题。以下边界保持不变：

- 保留 Next.js、FastAPI、SQLite、Agent Bridge 架构；
- FastAPI 和数据库仍是业务事实源；
- 复盘是只写 AgentEvent 的分析结果，不创建或确认 Proposal；
- 未新增数据库表、字段、迁移、多 Agent Runtime 或独立 Experiment 系统；
- 未删除现有页面、mock 模型、种子数据、统一导出服务或兼容导出接口；
- 未提交开发服务器产生的 `frontend/next-env.d.ts` 漂移；
- 未引入置信度百分比、节省时间或效率提升等无依据数字。

## 2. 根因

### 2.1 项目记忆

后端原导出把记忆正文直接作为三级标题，状态、来源、权限和有效期缺少统一信息层级；前端使用 `<pre>` 展示原始文本，因此标题、列表、引用和分隔线无法形成可读版式。

### 2.2 AI 复盘

复盘入口存在四个连续断点：

1. 前端把 `retrospective` 错误路由到 `project-status` skill；
2. 复盘事件类型错误映射为 `replan`；
3. Sidecar 完成后按“开始时间后的第一条事件”猜测结果，可能取得无关事件；
4. 页面未经运行时校验直接强转输出，并对缺失数组访问 `.length`，异常结构因此触发整页错误边界。

此外，旧链路允许未选择成员身份时发送空 `viewer_user_id`，新失败还会覆盖或隐藏最近一次成功结果。

## 3. 项目记忆 Markdown

后端导出现在采用：

- `项目名称 · 项目记忆` 主标题；
- 当前身份可见范围和历史内容语义说明；
- 当前有效、历史记录数量概览；
- 五类既有主题分组；
- 编号条目、正文引用块、形成原因和统一元信息；
- 中文来源/状态/可见范围标签及 `YYYY-MM-DD` 日期；
- 已过期、已替代、已归档的明确状态。

权限过滤仍在服务层完成，Markdown 不输出记忆、成员或来源对象的原始 ID。

前端新增复用的 `MarkdownPreview`，项目记忆与成果导出共用标题、列表、引用、表格、代码和滚动样式。项目记忆预览改为 `ReactMarkdown + remark-gfm`，复制和下载仍使用原始 Markdown。下载文件名过滤 Windows 不允许的字符，格式为 `项目名称-项目记忆.md`。

## 4. 结构化复盘 Sidecar 链路

新增 `project-retrospective` skill，只允许：

- `get_workspace_state`
- `get_timeline_slice`
- `generate_retrospective`

skill 要求所有结论基于任务、风险、验证结果和时间线事实，不生成不存在的成果、成员或指标，不修改 Project、Stage、Task 等主事实。

新增内部工具：

```text
POST /internal/agent-tools/retrospective
```

输入严格复用 `RetrospectiveOutput`：

- `project_summary`
- `key_achievements`
- `challenges`
- `lessons_learned`
- `overall_assessment`
- `reason`
- `requires_confirmation=false`

工具 Manifest 为 `riskCategory=analysis`、`effectType=event_write`，要求幂等键、顺序执行、单并发且禁止 provider 并行工具调用。FastAPI 校验 run/conversation/workspace/project 归属后，仅持久化 `event_type=retrospective` 的 AgentEvent；返回 `side_effect_status=event_persisted` 和真实 `agent_event_id`。相同幂等键复用同一事件。

Sidecar `GET /runs/{run_id}` 的工具摘要新增可选 `agent_event_id`。前端优先按该 ID 在项目时间线中取得准确事件，仅为旧 Sidecar 保留“事件类型 + 本次开始时间”的兼容查找。

## 5. 前端稳定性与可信状态

- `retrospective` 正确映射到 `project-retrospective` 和 retrospective AgentEvent；
- 新增 `RetrospectiveSummary` 类型、运行时解析器和必填字段校验；
- 缺少必填字符串、数组或 `requires_confirmation=false` 时显示卡片内契约错误，不进入整页错误边界；
- 未选择当前成员身份时禁用生成按钮，不发送空 viewer ID；
- 页面从最新有效 retrospective 事件恢复最近一次结果；
- 新生成失败或结构异常时保留最近一次成功结果，并显示可重试的局部错误；
- `success`、`repaired`、`fallback` 使用“正常生成”“修复后生成”“基础回退”明确标识；
- 页面显示结构化项目回顾、成就、挑战、经验、整体评价和生成依据，不显示伪精确置信度。

本次 UI 调整遵循现有视觉系统，重点加强排版层级、长文本可读性、移动端布局和错误状态，没有另起一套设计语言。

## 6. 契约与兼容性

- 新增一个 Sidecar skill 和一个内部 Agent Tool，不新增公开业务 API；
- run 状态响应只新增可选字段，旧消费者可忽略；
- 历史项目、旧数据库和现有导出 API 不需要迁移；
- 旧 Coordinator 的 retrospective schema 仍可复用，但不会恢复为主要模型调用路径；
- Proposal → Confirm 边界没有改变，复盘不会自动修改计划。

## 7. 测试记录

### 7.1 定向测试

| 范围 | 结果 |
|---|---|
| Backend：复盘工具、幂等、错误结构、跨项目归属、Markdown 格式 | `7 passed` |
| Agent Bridge：tool/skill/run event ID/runtime | `339 passed` |
| Frontend：Markdown 预览、复制、复盘校验/恢复/失败隔离、精确事件 ID | `40 passed` |

### 7.2 全量门禁

| 范围 | 结果 |
|---|---|
| Backend `pytest -q --basetemp=...` | `945 passed, 6 skipped, 0 failed, 0 errors` |
| Frontend Vitest 串行全量 | `374 passed, 6 skipped, 0 failed` |
| Frontend lint | 通过 |
| Frontend production build | 通过 |
| Frontend TypeScript | 通过 |
| Agent Bridge typecheck | 通过 |
| Agent Bridge build | 通过 |
| Agent Bridge 复盘相关定向测试 | `339 passed` |
| Agent Bridge 串行全量 | `2655 passed, 4 skipped`，2 项重型 showcase 用例未通过首轮门禁 |

Agent Bridge 两项首轮异常均在未改动的 `t46-7-showcase-closeout.test.ts`：

1. Golden Core 用例耗时超过固定 5 秒；使用 30 秒阈值隔离复跑后通过，实际约 3.6 秒。
2. Known-fault CLI 链被 Windows `npx` 的无扩展文本 shim 破坏，Git Bash 报 Node/npm 版本不匹配。将真实 Node 24.15.0 与 npm 11.12.1 同时放入临时隔离 PATH 后，目标用例通过（约 15.4 秒）。临时工具链已删除，未写入仓库。

后端首次全量运行也遇到系统 `%TEMP%/pytest-of-53506` 权限错误；改用仓库内独立 `--basetemp` 后 945 项全绿。临时测试目录和 JUnit 文件均已删除。

## 8. 已知限制

- 本次没有调用真实付费模型；结构化复盘通过 mock/工具契约、持久化和前端恢复链路验证。真实模型异常结构会被 FastAPI 与前端双重拒绝，不会静默写入或崩溃整页。
- Windows 上完整 evaluation showcase 仍需要同时为 PowerShell 与 Git Bash 提供真实的锁定 Node/npm 可执行文件；直接使用 `npx --package=node...` 会把文本 shim 暴露给 Git Bash。
- 当前系统临时目录存在访问权限问题，后端全量测试应继续显式指定可写 `--basetemp`。
