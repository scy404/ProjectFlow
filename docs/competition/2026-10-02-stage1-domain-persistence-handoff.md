# ProjectFlow 阶段 1：UI、领域模型与持久化断裂修复交接

状态：代码与回归完成，待提交/推送（2026-10-02）

分支：`codex/stage1-repair-domain-persistence-20261002`

依赖基线：`codex/data-contract-regression-baseline-20261001` @ `f027393`

## 1. 边界

- 保留 Next.js、FastAPI、SQLite、Agent Bridge 与 Proposal → Confirm。
- 不新增多 Agent Runtime 或独立 Experiment 系统。
- 不删除现有项目页面、Mock 模型或演示种子。
- 所有数据库字段同步模型、Schema、迁移、服务、Agent 状态、前端类型、展示与测试。
- `use_case` 不重新成为公开字段；沿用已确认的统一 `project_template`，旧 `use_case` 仅作为迁移输入。

## 2. 实施前审计

| TODO | 审计结论 | 本分支动作 |
| --- | --- | --- |
| 1.1 项目模板 | Create/Read、创建服务、前端创建与 Agent state 已有；缺 ProjectUpdate、数据库索引、前端统一标准化和五枚举修改测试 | 补齐 |
| 1.2 `is_demo` | 未实现 | 全链路新增 |
| 1.3 Workspace 字段 | `team_size/project_template` 已完成；需求文本中的 `use_case` 与此前统一决策冲突 | 保持统一契约并总回归 |
| 1.4 创建表单 | 已移除团队规模；仍有 `projectType`、裸 `createdBy`、资源失败反馈不完整、成功后缺直接 CTA | 修复 |
| 1.5 DirectionCard 既有字段 | Agent Schema、前端类型和展示大部分已有；确认持久化仅保存基础字段，Bridge manifest 不完整 | 补齐持久化与 Bridge |
| 1.6 验证语义 | 未实现 | 新增两个可选 JSON 字段并贯通 |
| 1.7 EvidenceRef | 阶段 0 已完成模型、Schema、迁移、读取和前端展示 | 增加可选 `note` 以明确承载说明并回归 |
| 1.8 EvidenceRef 入口 | 阶段 0 已覆盖 Sidecar、旧 flow、replan 和聚合读取 | 不重复实现，增加/复用回归证据 |

## 3. 修改台账

### 3.1 Project / Workspace 契约

| 文件 | 修改 | 对应 TODO |
| --- | --- | --- |
| `backend/app/models/project.py` | `project_template` 增加索引；新增 `is_demo`，默认 `False` 且有索引 | 1.1、1.2 |
| `backend/app/schemas/project.py` | Create/Update/Read 全部接入 `project_template` 与 `is_demo` | 1.1、1.2 |
| `backend/app/core/database.py` | 幂等增加 `is_demo` 列和两个项目索引，旧行安全回填 | 1.1、1.2 |
| `backend/app/services/project_service.py` | 创建和修改均保存项目模板/演示标记；枚举写库前转为稳定字符串 | 1.1、1.2 |
| `backend/app/api/routes_projects.py` | ProjectRead 转换不再丢失 `is_demo` | 1.2 |
| `backend/app/services/project_state_service.py`、`workspace_state_service.py`、`backend/app/schemas/workspace_state.py` | Project/Agent 聚合状态返回数据库中的模板与演示标记 | 1.1、1.2 |
| `backend/app/seed/demo_projectflow.py`、`demo_seed.py` | 官方种子项目明确设置 `is_demo=True` | 1.2 |
| `frontend/src/lib/types.ts`、`frontend/src/lib/api.ts` | Project 正式类型、创建/修改请求和所有读取入口统一归一化；旧响应缺字段时回退 `general/false` | 1.1、1.2 |

Workspace 继续返回并保留 `team_size/project_template`。根据 2026-10-01 已确认的统一枚举决策，没有重新公开 `use_case`；旧库物理列只参与迁移，避免再次形成两套概念。

### 3.2 创建链路与演示提示

| 文件 | 修改 | 对应 TODO |
| --- | --- | --- |
| `frontend/src/components/project/project-intake-form.tsx` | 局部状态和草稿改为 `projectTemplate`；只对旧草稿读取 `projectType`；移除手填 `createdBy`；展示实际成员；创建后提供“进入项目/生成方向卡” | 1.4 |
| `frontend/src/app/workspaces/[workspaceId]/page.tsx` | 工作区加载时初始化合法当前用户；“生成方向卡”调用既有 clarify 提案链路，仍需 Confirm 后落库 | 1.4 |
| `frontend/src/components/project/new-project-dialog.tsx`、`workspace-content.tsx`、`workspace-layout.tsx` | 贯通身份、成员、团队规模及创建后下一步事件 | 1.4 |
| `frontend/src/components/project/resource-input-panel.tsx` | 上传失败显示原因，支持重试或跳过；项目创建后的资源保存失败也显示恢复操作 | 1.4 |
| `frontend/src/components/project/project-content.tsx`、`workspace-content.tsx` | 根据 `is_demo` 显示“官方演示项目/演示数据”，不再依赖名称猜测 | 1.2 |

### 3.3 DirectionCard 完整链路

| 文件 | 修改 | 对应 TODO |
| --- | --- | --- |
| `backend/app/agent/output_schemas.py`、`prompts.py` | Agent 输出新增可选 `validation_hypotheses/success_signals`，创业模板提示生成验证语义 | 1.5、1.6 |
| `backend/app/services/agent_proposal_service.py` | clarify Confirm 从“手写基础字段白名单”改为保存经过 Schema 校验的完整输出，修复扩展字段静默丢失 | 1.5、1.6 |
| `backend/app/services/project_service.py` | 读取新增验证字段；历史单字符串 `mvp_boundary` 子项归一化为单元素数组 | 1.5、1.6 |
| `agent-bridge/src/tools/projectflow-tools.ts` | 方向卡工具 manifest 声明所有既有扩展字段和两项验证字段 | 1.5、1.6 |
| `frontend/src/lib/types.ts`、`api.ts` | DirectionCard 类型和标准化覆盖完整字段，新旧数据均安全读取 | 1.5、1.6 |
| `frontend/src/components/agent/direction-decision-view.tsx`、`agent-proposal-panel.tsx` | Proposal 和确认后页面都展示扩展字段；验证内容以“要验证什么/什么现象代表有效”呈现 | 1.5、1.6 |

### 3.4 EvidenceRef

| 文件 | 修改 | 对应 TODO |
| --- | --- | --- |
| `backend/app/schemas/evidence.py` | 在既有稳定结构上增加可选 `note` | 1.7 |
| `agent-bridge/src/tools/projectflow-tools.ts` | 分工和风险工具的 EvidenceRef manifest 同步 `note` | 1.7、1.8 |
| `frontend/src/lib/types.ts`、`components/ui/evidence-ref-list.tsx` | 类型与共用展示同步可选说明 | 1.7 |
| 既有 `agent_tools_service.py`、`agent_flow_service.py`、`agent_proposal_service.py`、`replan_service.py` | 审计确认 Sidecar、新工具链、旧 flow、replan Confirm 已透传 `evidence_refs`，本次不制造重复实现 | 1.8 |

### 3.5 测试

- 新增 `backend/app/tests/test_stage1_domain_persistence.py`：完整 DirectionCard Proposal → Confirm → Project/ProjectState/AgentState 往返、旧卡兼容、标量 MVP 边界兼容。
- 扩充项目模板测试：五枚举创建/读取/修改、普通项目 `is_demo=False`、修改后 Agent state 一致。
- 扩充迁移与种子测试：列、索引、旧行默认值及官方种子演示标记。
- 扩充前端测试：项目更新归一化、实际成员展示、无裸创建者/团队规模、方向卡 CTA、资源失败重试、EvidenceRef note。
- 扩充 Bridge 工具测试：方向卡完整 manifest 与 EvidenceRef note。

## 4. 验证与推送

### 4.1 已通过

- 后端定向：`39 passed`。
- 前端定向：`31 passed`。
- 前端全量：`344 passed, 6 skipped`。
- 前端生产构建：通过；Next.js TypeScript、静态页面生成通过。
- 前端 ESLint：通过。
- Agent Bridge 相关工具测试：`253 passed`。
- Agent Bridge `tsc --noEmit`：通过。
- `git diff --check`：通过。
- 本地界面核查：演示标签、官方演示提示、统一五模板、实际成员展示均可见；表单中无 `teamSize/createdBy`。

### 4.2 已知基线失败（未扩大）

- 后端全量：`859 passed, 4 skipped, 67 failed, 2 errors`。阶段 0 为 `855 passed, 4 skipped, 67 failed, 2 errors`；失败数与错误数不变，新测试令通过数增加 4。已知失败来自过期固定日期和 Windows symlink 权限。
- Agent Bridge 全量：与本次改动直接相关的测试通过；评测实验套件仍因 Windows 下硬编码 `backend/.venv/bin/python`、无扩展名 `node_modules/.bin/tsx`、Node 锁定 24.15.0 而本机为 24.14.1、symlink/临时目录权限而失败。未在阶段 1 混入跨平台评测基建重构。
- 后端全库 Ruff 有 496 项历史存量，不作为本分支质量门；本次新增测试自身已处理导入顺序和 UTC 日期。前端 lint 为绿色。

### 4.3 Git 状态

- 工作分支：`codex/stage1-repair-domain-persistence-20261002`。
- 功能提交：`9dda8a9 feat: repair stage 1 domain persistence chains`。
- 未修改 `main`，未向 upstream 写入。
- 本文档提交：本条追溯补记所在提交。
- 远端 fork 分支：待推送；若网络不可用，执行本文末尾命令即可。

```powershell
cd 'C:\Users\53506\Documents\ChatGPT\AI+\ProjectFlow-opc-project-type'
git push -u origin codex/stage1-repair-domain-persistence-20261002
```
