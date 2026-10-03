# ProjectFlow 阶段 2：项目旅程与收敛导航交接

状态：TODO 2.1、2.2 已完成；TODO 2.3、2.4 等待方案审核（2026-10-03）

分支：`codex/stage2-project-journey-20261003`

依赖基线：`codex/stage1-repair-domain-persistence-20261002` @ `afe240b`

## 1. 执行边界

- 保留 Next.js、FastAPI、SQLite、Agent Bridge 与 Proposal → Confirm。
- 不新增数据库字段；旅程状态只由 FastAPI 返回的正式 ProjectState 推导。
- 不新增多 Agent Runtime 或独立 Experiment 系统。
- 不删除现有页面、Mock 模型或演示种子。
- TODO 2.3、2.4 在编码前必须先提交方案并等待用户批准。

## 2. 实施前审计

| TODO | 审计结论 | 本分支动作 |
| --- | --- | --- |
| 2.1 旅程推导器 | 现有前端在 `project-actions.ts`、AgentSidebar 和 AgentConversationPage 各自维护不完整的阶段判断，且无法表达锁定、注意或复盘状态 | 新建唯一纯函数推导器并增加状态矩阵测试 |
| 2.2 旅程条 | Overview 只有项目摘要、下一步行动和统计，缺少六步全局上下文；Agent 页面仍使用重复的旧推断 | 增加响应式旅程条，并让 Agent 两种界面复用同一旅程上下文 |
| 2.3 导航收敛 | 侧栏已有视觉分隔，但十个入口仍全部同权重常显，分组没有标题、展开状态或当前组规则 | 仅提交收敛方案，等待批准 |
| 2.4 GuidedTour | 当前首次进入会自动出现遮罩，引导内容也未覆盖六步旅程 | 仅提交修改方案，等待批准 |

## 3. 数据事实与判定边界

旅程推导允许使用：

- `Project.direction_card/status`
- Stage、Task 的存在与状态、Task owner
- AssignmentProposal、AssignmentNegotiation 的正式状态
- AgentProposal 的类型与确认状态
- Risk 的开放状态
- AgentEvent 中成功的 export 事件

明确禁止使用：localStorage、sessionStorage、页面访问记录、组件内部“看过/点过”状态。

## 4. 修改台账

| 文件 | 修改内容 | 可追溯理由 |
| --- | --- | --- |
| `frontend/src/lib/project-journey.ts` | 新增六步旅程纯推导器、五种状态、每步唯一 CTA 与 Agent 当前焦点 | 统一原先散落在多个组件中的不完整判断；只读取 ProjectState，不写浏览器完成标记 |
| `frontend/src/lib/project-journey.test.ts` | 新增七类状态矩阵测试 | 覆盖空项目、待确认提案、计划/拆解、分工、协商、风险、完成与导出，以及渐进加载兼容 |
| `frontend/src/components/project/project-journey-bar.tsx` | 新增 Overview 响应式旅程条 | 桌面展示六步关系；移动端只突出当前步骤、说明与唯一 CTA |
| `frontend/src/components/project/project-content.tsx` | 在项目摘要后接入旅程条 | 用户进入项目后先获得全局位置和下一步，再看到行动卡与统计 |
| `frontend/src/components/project/agent-sidebar.tsx` | 删除旧 `inferFocus()`，复用旅程推导；补充收尾焦点与移动端自动收起 | 避免 Agent 与 Overview 对当前阶段得出不同结论；窄屏为主内容留出空间 |
| `frontend/src/components/project/agent/AgentConversationPage.tsx` | 删除另一份旧阶段判断，复用旅程焦点 | 完整对话页和侧边栏共享同一事实规则 |
| `frontend/src/components/project/agent/StarterPrompts.tsx` | 增加项目录入、复盘导出的上下文提示 | 让新增旅程首尾状态在 Agent 空会话中有对应操作说明 |
| `frontend/src/components/project/agent-conversation-cards.tsx` | 增加项目录入、复盘导出的焦点原因 | 保证 Agent 上下文卡能解释旅程首尾状态 |
| `frontend/src/components/project/workspace-layout.tsx` | 窄屏自动收起左侧导航 | 满足移动端突出当前旅程步骤的可用空间要求；没有删除或改写任何路由 |

## 5. 关键判定规则

1. 创建项目：存在正式 Project 即完成；聚合数据加载中为 active，不伪造完成。
2. 明确方向：DirectionCard 落库后完成；clarify Proposal 待确认为 active。
3. 制定计划：同时存在 Stage 与 Task 才完成；仅有 Stage 时继续拆解。
4. 完成分工：每个 Task 都有 `owner_user_id` 才完成；拒绝或待协商为 needs_attention。
5. 执行与验证：任务分工完成后开放；阻塞任务、开放风险或项目 at_risk 为 needs_attention；任务全部 done 且无上述问题才完成。
6. 复盘与导出：执行完成后开放；Project 已 completed 但没有成功 export 事件时为 needs_attention；存在非 failed 的 export AgentEvent 后完成。

说明：现阶段尚无独立验证结果模型，未提前虚构验证完成条件。后续“验证任务闭环”仍按总依赖链作为 Task 能力实现，再扩充第 5 步的事实规则。

## 6. 验证结果

- `npm test -- --run src/lib/project-journey.test.ts src/components/project/agent-sidebar.test.tsx`
  - 结果：26 passed，6 skipped。
- `npm run lint`
  - 结果：通过，无新增 ESLint 错误。
- `npm run build`
  - 结果：通过，Next.js 编译、TypeScript、静态页面生成均完成。
- 浏览器桌面核查：六个步骤、状态连接、当前说明与“处理项目风险”唯一 CTA 正常显示。
- 浏览器 390×844 核查：桌面六步列表 `display:none`，当前步骤可见；旅程容器宽 236px，CTA 可操作。
- 浏览器核查曾发现 ProjectState 渐进装载时数组/Project 可为 undefined；已加入兼容规则和测试，页面错误边界不再触发。

备注：一次并行生产构建因项目现有 Google Fonts 网络请求中断；停止并行预览后单独重跑，完整构建通过。这不是代码回归。

## 7. 未实施边界

- TODO 2.3：未修改菜单分组、展开行为或路由。
- TODO 2.4：未修改 GuidedTour 自动触发、入口或内容。
- 两项仅形成待审核方案；批准前不得编码。

## 8. 提交信息

- 实现 commit：`64b7868`（`feat: add data-driven project journey`）。
- 远端：`origin/codex/stage2-project-journey-20261003`（推送后补充确认）。
