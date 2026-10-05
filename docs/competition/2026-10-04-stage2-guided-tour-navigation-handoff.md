# 阶段 2 导航交互与手动引导 Handoff

> 状态：部分撤销。提交 `dc87550` 中的导航交互调整继续保留；TODO 2.4 GuidedTour 改造已在后续分支 `codex/revert-stage2-guided-tour-20261004` 撤销。最终状态以 `2026-10-04-stage2-guided-tour-rollback-handoff.md` 为准。

## 1. 分支与基线

- 实施日期：2026-10-04
- 实施分支：`codex/stage2-guided-tour-navigation-20261004`
- 基线分支：`codex/stage2-navigation-consolidation-20261004`
- 基线提交：`325b4e8`
- 变更范围：阶段 2.3 交互修正、阶段 2.4 GuidedTour 手动触发
- 未修改：FastAPI、SQLite、Agent Bridge、Proposal → Confirm 业务机制、数据库字段、演示种子数据

## 2. 需求决策

### 2.1 导航分组

- 将两个导航分组从互斥手风琴改为独立展开。
- 用户展开“项目推进”后再展开第二组，“项目推进”保持展开；每组仍可单独收起。
- 路由进入某个分组内页面时，仅确保对应分组展开，不关闭用户已经展开的其他分组。
- 第二组由“沉淀与评审”改名为“复盘总结”。该名称保持四字结构，并直接覆盖“项目记忆”和“项目复盘”的用户心智。
- 原有十个项目页面、路由、徽标计算与分组内弱分隔全部保留。

### 2.2 GuidedTour

- 删除首次进入后延时自动弹出的行为。
- 删除 `projectflow-agent-tour-seen` 的 localStorage 一次性标记；引导不再依赖浏览器本地状态。
- 增加三个可重复触发的入口：
  - 左侧栏底部“使用引导”；
  - Agent 侧栏标题区帮助按钮；
  - Agent 完整对话页标题区帮助按钮。
- 从左侧栏启动时，如 Agent 侧栏已折叠，会先展开再显示引导。
- 引导内容按项目旅程、收敛导航、旅程上下文、Proposal → Confirm、主动输入五步组织。
- 保留上一步、下一步、跳过、完成与键盘 Escape/方向键/Enter 操作。
- 每次重新打开都会从第一步开始；目标节点暂未渲染时使用安全定位，不抛出异常。

## 3. 文件级变更记录

| 文件 | 修改 |
| --- | --- |
| `frontend/src/components/project/project-navigation.ts` | 将第二分组显示名改为“复盘总结” |
| `frontend/src/components/project/project-sidebar.tsx` | 用 `openGroups` 独立记录分组展开状态；增加“使用引导”入口 |
| `frontend/src/components/project/agent/AgentGuidedTour.tsx` | 移除自动启动和已读标记；增加显式 `start()`、会话重置、五步内容、缺失目标回退与对话框语义 |
| `frontend/src/components/project/agent-sidebar.tsx` | 监听手动引导事件，启动时展开 Agent 侧栏，并增加标题区帮助按钮 |
| `frontend/src/components/project/agent/AgentConversationPage.tsx` | 完整对话页接入同一手动引导和标题区帮助按钮 |
| `frontend/src/components/project/project-sidebar.test.tsx` | 覆盖独立展开、旧页面保留与手动触发事件 |
| `frontend/src/components/project/project-navigation.test.ts` | 固定“复盘总结”命名契约 |
| `frontend/src/components/project/agent/AgentGuidedTour.test.tsx` | 覆盖不自动启动、重复打开从头开始、缺失目标与 Escape 退出 |

## 4. 验证结果

- `npm run lint -- --quiet`：通过。
- 前端定向测试：`4` 个测试文件、`17` 个测试全部通过。
- 前端全量测试：`33` 个测试文件通过，`361 passed, 6 skipped`。
- `npm run build`：通过；Next.js 编译、TypeScript、静态页面生成全部成功。
- 浏览器桌面实测：
  - “项目推进”和“复盘总结”可同时保持展开；
  - 切换到 Agent 对话后两个分组仍保持展开；
  - 左侧栏“使用引导”能展开 Agent 侧栏并显示第一步；
  - 完整 Agent 对话页也能从左侧栏或标题区再次打开引导。

测试输出中仍有仓库既有的 Framer Motion/React ref 警告、TagInput ref 警告与用于验证错误路径的 stderr；均未导致失败，本次没有扩大范围处理。

## 5. 回退边界

- 导航交互可通过回退 `project-sidebar.tsx` 的 `openGroups` 变更恢复为互斥分组。
- GuidedTour 改造仅涉及前端状态与自定义浏览器事件，不涉及数据迁移或服务端回退。
- 本分支不应直接合并到 `main` 之外的未知基线；应先确认其父提交 `325b4e8` 已在目标分支中。
