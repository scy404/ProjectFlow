# 测试基础设施维护交接记录（2026-10-08）

## 1. 变更边界

- 基线：`origin/main` `440fb4c48d81fcec87b9d9a9a53ed12faf3804ef`
- 分支：`codex/test-infrastructure-maintenance-20261008`
- 本轮只处理测试日期腐化、Windows symlink 能力差异、Agent Bridge 子进程跨平台路径和 Vitest 跨文件污染。
- 未放宽生产环境的截止日期校验、路径安全校验或 Proposal → Confirm 约束。
- 未改变 Next.js、FastAPI、SQLite、Agent Bridge 架构，也未增加 Agent Runtime 或 Experiment 系统。

## 2. 决策记录

### 2.1 日期方案与安全测试不冲突

相对日期只替换成功场景中会随时间失效的 Project、Stage、Task、Check-in fixture。明确验证过去日期被拒绝的负向测试、迁移快照和历史序列化样本继续允许固定历史日期。因此，生产 Schema 的“截止日期不能早于今天”规则保持不变。

统一时间关系为：

```text
today
  < stage_start
  < cycle_start
  < task_due
  <= stage_end
  < project_deadline
  < replanned_deadline
```

`backend/app/tests/test_time_stable_fixtures.py` 会阻止本次修复的成功 fixture 再引入固定业务日期。

### 2.2 symlink 分层覆盖

- 真实 symlink 集成测试先探测宿主能力；只有 `EPERM/EACCES/ENOTSUP` 等能力缺失才明确跳过。
- `is_safe_path` 的解析后越界拒绝增加不依赖真实 symlink 的必跑单元测试。
- 生产路径安全逻辑未降低；支持 symlink 的 Windows 和 Linux CI 仍会执行真实集成断言。

### 2.3 Agent Bridge 跨平台进程

- Windows 后端解释器：`backend/.venv/Scripts/python.exe`。
- macOS/Linux 后端解释器：`backend/.venv/bin/python`。
- Windows Sidecar：经 `cmd.exe` 调用 `node_modules/.bin/tsx.cmd`。
- macOS/Linux Sidecar：直接调用 `node_modules/.bin/tsx`。
- Windows 清理按进程树终止，并对临时目录删除增加有限重试，避免残留 Node 子进程或 SQLite 句柄。
- Windows 上需要 POSIX shell 的既有评测 CLI 使用 Git Bash，避免误调用 WSL Bash 后发生 Windows 路径丢失。

### 2.4 Vitest 隔离

`agent-bridge/vitest.config.ts` 设置 `fileParallelism: false`。评测测试会修改模型配置、环境变量并启动本地服务；文件级串行用于消除跨文件共享状态和端口/进程干扰，文件内部测试语义不变。

## 3. 主要修改

### 后端

- 新增 `test_support.py`，集中提供相对日期计划和 symlink 能力探测。
- 修复 check-in、evaluation evidence、memory retrieval、output channel、replan、retrieval eval 等公共成功 fixture。
- 为资源文件安全与 evaluation seed symlink 测试增加能力检测。
- 增加不依赖 symlink 的 realpath 越界拒绝测试。
- 增加固定业务日期回归守卫。

### Agent Bridge

- 新增 `runtime-paths.ts` 及 Windows/POSIX 路径单元测试。
- `isolation.ts` 与 toolchain validation 统一使用平台路径解析。
- shell agent acceptance 与 showcase CLI 使用可解析的 Git Bash。
- Golden Core CLI 测试不再依赖 Windows 无法直接执行的 `npx` Unix shim。
- symlink 集成测试按能力明确 skip；其他路径越界测试始终执行。
- Windows POSIX mode 位断言仅在支持该语义的平台执行。
- 临时目录清理增加 Windows 文件句柄释放重试。

## 4. 验证结果

验证日期：2026-10-08，Windows 11。

### 后端全量

```text
935 passed, 6 skipped, 0 failed, 0 errors
```

命令等价于：

```powershell
python -m pytest -q
```

实际使用隔离 Python 3.12 环境和仓库内 pytest 临时目录；原 `.venv` 未被覆盖。6 个跳过均有条件原因，其中本轮两个真实 symlink 集成测试因当前 Windows 账户无创建权限而跳过。

### Agent Bridge 全量

```text
Test Files  99 passed (99)
Tests       2652 passed | 4 skipped (2656)
```

4 个跳过均为真实 symlink 能力测试，输出包含 `EPERM` 原因。测试使用仓库声明的 Node `24.15.0` 和 npm `11.12.1`；Windows 上直接以锁定 Node 启动 Vitest，避免 `npm run` 回落到系统 Node。

### Agent Bridge 静态检查

```text
typecheck: passed
build: passed
```

## 5. 环境说明与后续 CI 建议

- 本地原 `backend/.venv` 依赖系统 Python 3.13；本轮验证使用临时隔离环境，验证结束后已删除，不纳入提交。
- 锁定 Node/npm 的临时工具目录也已在验证后删除，不纳入提交。
- Linux CI 应执行真实 symlink 集成测试且不得跳过。
- Windows CI 应保留能力探测，并在 Developer Mode/权限允许的 runner 上执行真实 symlink 集成。
- 建议 CI 显式安装 `.node-version` 和 `packageManager` 声明的版本，不依赖 runner 全局 Node/npm。
