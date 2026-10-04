# ProjectFlow 阶段 2.3：项目导航收敛交接

状态：已完成（2026-10-04）

分支：`codex/stage2-navigation-consolidation-20261004`

依赖基线：`codex/stage2-project-journey-20261003` @ `7011315`

## 1. 执行边界

- 保留 Next.js、FastAPI、SQLite、Agent Bridge 与 Proposal → Confirm。
- 未新增或修改数据库字段、API、Agent Runtime、Mock 模型或演示种子。
- 十个项目页面及其现有路由全部保留。
- 本分支仅实施 TODO 2.3；TODO 2.4 GuidedTour 未修改。

## 2. 审核决定

根据用户对方案的批注，不再将“规划与决策”和“执行与协作”作为两个同级折叠组，而是合并为一个“项目推进”组，并在内部保留弱分割：

```text
固定入口
├─ Agent 对话
└─ 项目总览

项目推进
├─ 方向卡
├─ 阶段计划
├─ ── 弱分割 ──
├─ 我的任务
├─ 团队任务
├─ 签到与状态
└─ 风险预警

沉淀与评审
├─ 项目记忆
└─ 项目复盘
```

## 3. 修改台账

| 文件 | 修改内容 | 目的 |
| --- | --- | --- |
| `frontend/src/components/project/project-navigation.ts` | 新增十页面导航契约、固定入口、两个分组、内部 section 与路由映射 | 将信息架构从 JSX 过滤条件中抽离为唯一可测试配置 |
| `frontend/src/components/project/project-navigation.test.ts` | 增加页面完整性、合并分组和直达路由映射测试 | 防止页面遗漏、重复或错误归组 |
| `frontend/src/components/project/project-sidebar.tsx` | 固定 Agent/Overview；增加“项目推进”“沉淀与评审”折叠组；同组内增加弱分割；聚合任务和风险 badge；支持当前路由组自动展开 | 降低十个同权重入口带来的认知负担，同时保留旧功能 |
| `frontend/src/components/project/project-sidebar.test.tsx` | 增加默认收敛、互斥展开、旧页面可达、直达 URL、图标模式展开测试 | 固定实际侧栏交互行为 |

## 4. 交互规则

1. Agent 对话和项目总览始终作为固定主入口。
2. 项目总览默认不展开任何页面组，首屏只呈现四个高层入口。
3. 访问方向、阶段、任务、签到或风险页面时，“项目推进”自动展开。
4. 访问记忆或复盘页面时，“沉淀与评审”自动展开。
5. 两个页面组互斥展开；用户可手动收起当前组。
6. 侧栏图标模式只显示固定入口和两个组图标；点击组图标先展开侧栏，再显示子页面。
7. 移动端禁用鼠标 hover 自动展开，避免窄屏侧栏意外覆盖主内容。
8. 所有导航仍调用既有 `onNavigateView()`，不增加重定向或改变 URL 契约。

## 5. 验证结果

- `npm test -- --run src/components/project/project-navigation.test.ts src/components/project/project-sidebar.test.tsx src/lib/project-journey.test.ts`
  - 结果：14 passed。
- `npm run lint`
  - 结果：通过。
- `npm run build`
  - 结果：Next.js 编译、TypeScript 检查、静态页面生成全部通过。
- 桌面视觉检查：总览默认收敛；项目推进展开后六个页面顺序正确，阶段计划与我的任务之间存在弱分割；旧风险页面可正常进入。
- 390×844 检查：左右侧栏保持收起，主内容可用，项目页面仍可通过图标组展开访问。

## 6. 未实施边界

- GuidedTour 仍保持原行为，等待 TODO 2.4 单独批准和实施。
- 未新增导航偏好持久化；展开状态属于当前页面会话，页面归组由 URL 事实推导。

## 7. 提交信息

- commit：提交后补充。
- 远端：`origin/codex/stage2-navigation-consolidation-20261004`（推送后确认）。
