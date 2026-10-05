# ProjectFlow 合并回归修复交接

状态：本地修复与验证完成（2026-10-05）

分支：`codex/post-merge-regression-repair-20261005`

基线：fork `origin/main` 的 `90bc51ffaf2c322eed93f243419c3dedf4243130`

## 背景与审计结论

在 PR #1 至 #8 合并完成后，对 fork 最新 `main` 进行独立回归审计。所有 PR 均已合并，主要 PR head 均为最新 `main` 的祖先，仓库中也没有残留 Git 冲突标记；但合并冲突处置引入了两个后端回归：

1. `workspace_state_service.py` 在构造 `ProjectState` 时同时保留两次 `direction_card` 关键字参数，导致 Python 在导入阶段抛出 `SyntaxError`。
2. 阶段 0 已实现的 `_migrate_evidence_refs()` 及其启动调用在后续分支合并 `main` 时被删除，旧 SQLite 无法为 `assignment_proposals`、`risks`、`action_cards` 补齐 `evidence_refs`。

第二项不是测试误报：迁移测试创建旧表后调用两次 `create_db_and_tables()`，三个表仍没有 `evidence_refs`，直接违反“旧数据库可自动迁移”和“历史数据默认空数组”的数据契约。

## 修改台账

| 文件 | 修改 | 原因 |
| --- | --- | --- |
| `backend/app/services/workspace_state_service.py` | 删除旧的 `_json_object()` 重复参数，只保留 `normalize_direction_card()` | 恢复后端可导入性，并保持 DirectionCard 新旧 JSON 兼容规则 |
| `backend/app/core/database.py` | 恢复幂等 `_migrate_evidence_refs()`，并接入 `create_db_and_tables()` | 让旧 SQLite 自动补齐三类证据字段，重复启动不会重复加列 |
| 本文件 | 记录问题来源、基线、修改与验证 | 保证合并后修复过程可追溯 |

## 约束确认

- 未改变 Next.js、FastAPI、SQLite、Agent Bridge 架构。
- 未改变 Proposal → Confirm 机制。
- 未新增 Agent Runtime 或独立 Experiment 系统。
- 未删除页面、mock 模型或演示种子数据。
- 未直接修改 fork `main`；所有修复都位于独立分支。

## 验证记录

- `python -m compileall -q app`：通过，后端模块不再因重复关键字参数产生语法错误。
- 定向回归：

  ```text
  pytest app/tests/test_database_migrations.py
         app/tests/test_phase0_data_contracts.py
         app/tests/test_stage1_domain_persistence.py
         app/tests/test_task_validation_migration.py
         app/tests/test_project_state_endpoint.py -q
  ```

  结果：`17 passed`。迁移用例会对同一旧数据库执行两次初始化，确认新增迁移具有幂等性，并验证三个历史表的 `evidence_refs` 均可重新读取为空数组。
- 后端全量 `pytest -q`：`865 passed / 4 skipped / 67 failed / 2 errors`。与本次修复前的收集阶段 `19 errors` 不同，当前测试已经能够完整收集并执行到 100%。
- 67 个失败和 2 个错误仍来自既有测试基线：绝大多数把 `2026-07-01`、`2026-08-01`、`2026-08-15` 等日期硬编码为未来日期，但执行日为 2026-10-05，项目创建先被生产 Schema 以 422 拒绝，后续读取 `id` 时连锁失败；另外两个资源安全用例依赖当前 Windows 环境不具备的符号链接权限。
- `git diff --check`：通过。
- 非 Markdown 源文件未发现 `<<<<<<<`、`=======`、`>>>>>>>` 冲突标记。

## 后续建议

本分支只修复合并回归，不放宽生产截止日期校验，也不将大范围旧测试日期维护混入本次补丁。固定日期应在独立测试维护分支中改为相对日期；Windows symlink 用例应增加能力检测和条件跳过。
