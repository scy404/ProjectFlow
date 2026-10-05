# 阶段 2.4 GuidedTour 回退 Handoff

## 1. 分支与基线

- 实施日期：2026-10-04
- 实施分支：`codex/revert-stage2-guided-tour-20261004`
- 基线提交：`dc87550`
- 回退范围：仅撤销 TODO 2.4 GuidedTour 改造
- 保留范围：阶段 2.3 左侧导航交互修正

## 2. 回退决定

根据产品复核，当前阶段不再保留 2.4 的手动 GuidedTour 方案，因此将 GuidedTour 恢复到 `dc87550` 之前的实现状态。

撤销内容：

- 左侧栏底部“使用引导”入口；
- Agent 侧栏标题区“使用引导”入口；
- Agent 完整对话页的 GuidedTour 接入；
- `projectflow:start-guided-tour` 自定义事件；
- 手动 `start()`、重复会话重置和五步新文案；
- 本次手动引导方案新增的测试。

恢复内容：

- 原有首次进入自动检查；
- 原有 `projectflow-agent-tour-seen` 浏览器标记；
- 原有四步 Agent 引导内容和完成/跳过行为。

## 3. 明确保留的左侧栏修改

- “项目推进”和“复盘总结”分别维护展开状态，可以同时展开；
- 打开一个分组不会自动关闭另一个分组；
- 路由切换仅确保当前页面所属分组展开，不关闭已经展开的分组；
- 第二分组名称保持“复盘总结”；
- 原有十个项目页面、路由、徽标与分组内弱分隔保持不变。

## 4. 文件级记录

| 文件 | 回退内容 |
| --- | --- |
| `frontend/src/components/project/project-sidebar.tsx` | 删除手动引导入口，保留 `openGroups` 独立展开实现 |
| `frontend/src/components/project/agent-sidebar.tsx` | 删除手动启动事件和标题区帮助按钮 |
| `frontend/src/components/project/agent/AgentConversationPage.tsx` | 删除完整对话页 GuidedTour 接入 |
| `frontend/src/components/project/agent/AgentGuidedTour.tsx` | 恢复 2.4 修改前实现 |
| `frontend/src/components/project/project-sidebar.test.tsx` | 删除手动触发测试，保留独立展开测试 |
| `frontend/src/components/project/agent/AgentGuidedTour.test.tsx` | 删除 2.4 新增测试文件 |

## 5. 数据与架构影响

- 无数据库字段变化；
- 无 SQLite 迁移；
- 无 FastAPI、Agent Bridge、Proposal → Confirm 业务逻辑变化；
- 不影响 mock 模型、演示种子数据或任何项目页面。

## 6. 验证结果

- GuidedTour 相关三个实现文件与 `dc87550` 的父提交逐文件对照一致。
- 导航与 Agent 定向测试：`26 passed, 6 skipped`。
- 前端全量测试：`358 passed, 6 skipped`。
- `npm run lint -- --quiet`：通过。
- `npm run build`：通过，包含 TypeScript 检查与静态页面生成。
- 浏览器实测：左侧栏不再显示“使用引导”；“项目推进”和“复盘总结”仍同时保持展开。

测试输出中存在仓库既有的错误路径 stderr、Vite CJS 弃用提示和 TagInput ref 警告，均未导致测试失败，本次不扩大范围处理。
