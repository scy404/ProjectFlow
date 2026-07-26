# T46 Slice 5 Evidence-Backed Showcase & Closeout 交接

> Issue：[#100](https://github.com/wubq511/ProjectFlow/issues/100)
>
> 状态：2026-07-27 跨 Slice 审查与 C1/C2 证据归一化已完成。Post-review Golden Core mock evidence 52/52（`run_1785085331148`，integrity `91737377d5de9b5c6725fe3505c26c66743519350b2d199fc9dd0255e46863b2`）；C1 paid Flash preview 与 C2 三个 real acceptance slots 均通过；第二批 capability metadata、independent shell adapters、known-fault chain、preview/extension/promotion/privacy hardening 已验证。已合并到 `main`（`4728cf2`），Issue #100 与父 Issue #93 已关闭。
>
> 边界：#100 在 #99 的 Golden Core 之上补齐两个只读展示面（portable committed redacted showcase bundle + loopback-only local read viewer）、live preview、schema/provenance 校验、retention planning 与 Agent-first acceptance。不重新设计评测系统；基于现有 immutable result graph、artifact store、CLI 和 Agent Skill 扩展。Golden Core S1–S6 candidate changes 已批准并实现；post-review mock final evidence 为 52/52（run `run_1785085331148`）。不弱化 hard grader、不改写 Golden truth、不删除失败场景、不把 regression 显示为 pass、不自动 promotion。

## 交付结论

Issue #100 已实现 6 项 acceptance criteria（第一批），第二批正在进行：

**第一批（2026-07-20，已提交）：**

1. **两个只读展示面消费同一 immutable result graph**：`showcase-bundle.ts` 产出 portable committed redacted showcase bundle（`agent-bridge/showcase/bundles/<bundleId>.json`，可 `git add -f` 提交）；`local-viewer.ts` 产出 loopback-only（`127.0.0.1`/`::1`）HTTP 只读 viewer。两者都通过 `schema-migration.ts` 的 `verifyAndMigrateArtifact` 消费同一 `VerifiedArtifact`，不重新计算 grade、不修改 artifact、不调用 LLM。

2. **Live preview + 原子发布 + 预览标签**：`live-preview.ts` 使用 smoke SUT 上限 `$0.10`、`preview_` runId 前缀、`preview_label.json` 标记文件；`publishImmutable` 使用 hard-link 原子发布（EEXIST → fail-closed），`allowOverwrite: true` 仅在测试或显式覆盖路径使用。6 个 pre-call gate 检查 price table existence/fingerprint/freshness、model entry、worst-case cap 与 credential；post-run 再检查 resolved model、provider telemetry、target window 与 artifact status。**C1 真实 preview 已完成**：`preview_1785081515993_65e5a2e7d014e164`，status completed，3/3 passed，149395ms（约 2.5 分钟），windowMet=true，SUT $0.0054107256 provider_reported，17 requests，15561 input / 16871 output tokens，resolved deepseek:deepseek-v4-flash by sidecar_health，worst-case $0.0462，cap $0.10，integrity root `2d8746b78305a35ec425c76c32b4fcbd0930b583c4f5b006d10117b9dd37cf3e`，remainingGates=[]。Flash ＜ $0.10 通过；Pro worst-case $0.14355 ＞ $0.10 → pre-call fail-closed。普通 paid run 仍 fail-closed，只有 dedicated bounded preview 允许 Flash。价格表来源：<https://api-docs.deepseek.com/quick_start/pricing>。Coding Agent costs never count against SUT。

3. **Schema/hash/provenance 校验 + 确定性 migration + unknown-schema fail-closed**：`schema-migration.ts` 的 `verifyAndMigrateArtifact` 先读 `integrity.json`，验证 `sha256(reportRaw) === integrity.reportSha256` 后再解析 `report.json`；`verifyResultGraph` 检查 entries、evidence root、integrity root；`verifyProvenance` 检查 provenance 字段。`SUPPORTED_SOURCE_SCHEMA_VERSIONS = [1]`、`PRESENTATION_SCHEMA_VERSION = 1`、`MIGRATIONS` 为空（V1 无需迁移）。`assertSupportedSchema` 对未知 schema version fail-closed。

4. **只读 retention planning + zero-deletion + preserve markers**：`retention-planner.ts` 的 `buildRetentionReport` 扫描所有 artifact runs 与 showcase bundles，标记 11 类 preserve reasons。V1 policy 为 `v1-no-deletion`：所有 runs 标记 `eligibleForCleanup` 但不自动删除。

5. **Shell contract acceptance harness**：`agent-acceptance.ts` 为 3 个 shell agent profile（`codex`、`claude-code`、`trae-equivalent`）各定义 7 步确定性 CLI 命令映射。harness 通过 `execFileSync("bash", [scriptPath, ...command])` 执行每个命令，捕获 stdout/stderr/exit code，验证 expected JSON fields 存在。**harness 永不调用真实 LLM agent**——它通过运行 CLI 命令模拟 agent。所有运行使用 `mock:mock-model`。输出携带 `shellContractPassed` 和 `realAgentEvidence: false`，不宣称真实 agent 验收。

6. **诚实 Golden Core 基线更新**：showcase bundle 的 `releaseVerdict` 与 `honestBaseline` 字段如实报告原始 run 的 pass/fail 状态。跨 Slice 修复后的 Golden Core mock final evidence 为 52/52（post-review run `run_1785085331148`，integrity `91737377d5de9b5c6725fe3505c26c66743519350b2d199fc9dd0255e46863b2`）。不通过弱化 grader 或改写 Golden truth 消除失败场景。

**C1 真实 preview 与 C2 real agent acceptance（2026-07-26/27，已完成）：**

- **Capability metadata 事实源**：删除 `inferCapabilityDomain`/`inferScenarioClass` heuristic。为 demo/smoke/smoke-v2/full/golden-core 所有 ScenarioContract 建立显式版本化 metadata 事实源（`capabilityDomain` + `scenarioClass`），一场景恰一条；缺失/重复/unknown fail-closed。Golden join frozen registry，验证 registry/observations/grades 唯一且对齐；completed/regression observation set == canonical set；partial_budget 未运行 canonical 显式计 skipped/partial。

- **Shell acceptance 独立 adapter**：三个 profile 使用独立命令映射（共享 primitive，非三份相同静态数组）。保留 7 个基础能力。新增 evaluator-owned known-fault run：run failing fixture → diagnose → repair-packet list → 选 indexed packet → --packet-id prompt；empty/unindexed/no prompt 必须失败。不依赖 Golden 当前失败，不调用付费/真实 LLM，不污染 Golden registry。

- **Preview 断言修复**：windowMet 标签一致性修复（label 与 result 使用同一 `actualRemainingGates`）。CLI JSON 输出包含 `targetWindowMs`、`actualDurationMs`、`windowMet`，exitCode 与真实 artifact status 一致。清理 toolchain validation 旧注释。

- **C1 真实 paid preview**：`preview_1785081515993_65e5a2e7d014e164`，status completed，3/3，149395ms，windowMet=true，SUT $0.0054107256，integrity `2d8746b78305a35ec425c76c32b4fcbd0930b583c4f5b006d10117b9dd37cf3e`，remainingGates=[]。

- **C2 真实 agent acceptance**：三个 coding agent real acceptance slots 已完成，audited summary 路径 `agent-bridge/artifacts/agent-acceptance-real/audited-summary-20260726.json`，integritySha256 `d29955085d78500f186f9f636a423ce6b5e2421a2347c1f8cc5d92627d7b2c7e`，c2AuditedVerdict.passed=true。

## 核心实现

### Schema migration 与 artifact verification

`schema-migration.ts` 是两个展示面的共同基础。`verifyAndMigrateArtifact(runDir, runId)` 读取 `integrity.json`，验证 `sha256(reportRaw) === integrity.reportSha256` **后**再解析 `report.json`（防止篡改 report 后重算 hash）。然后调用 `verifyResultGraph`（检查 entries、evidence root、integrity root）和 `verifyProvenance`（检查 provenance 字段）。

`SUPPORTED_SOURCE_SCHEMA_VERSIONS = [1]`、`PRESENTATION_SCHEMA_VERSION = 1`、`MIGRATIONS` 为空（V1 无需迁移）。`assertSupportedSchema` 对未知 schema version fail-closed。`computeArtifactFingerprint` 计算 artifact 的 SHA-256 fingerprint，包含 `schemaVersion`、`runId`、`status`、`evidenceRootSha256`、`integrityRootSha256`。

### Portable committed redacted showcase bundle

`showcase-bundle.ts` 产出 portable committed redacted showcase bundle：

- **Bundle structure**：`SHOWCASE_BUNDLE_SCHEMA_VERSION = 1`、`SHOWCASE_BUNDLE_GENERATOR_VERSION = "t46-slice5-v1"`。bundle 包含 `bundleId`、`schemaVersion`、`generatorVersion`、`createdAt`、`sourceRunId`（pseudonymized）、`sourceArtifact`（redacted summary）、`evidenceChains`（redacted observation/grade snippets）、`releaseVerdict`、`honestBaseline`、`integritySha256`、`provenance`。
- **Redaction**：`redactText(text, salt)` 替换 raw IDs（`user_*`、`task_*`、`project_*`、`workspace_*`）、绝对路径、secrets（api keys/tokens/passwords/bearer）、hidden prompts、raw traces 为 `<redacted:kind>`。`pseudonymize(id, salt)` 生成 bundle-scoped pseudonym（`pseudo_<sha8>`），不跨 bundle 稳定（每个 bundle 使用独立 `generatePseudonymSalt()`）。
- **Evidence chains**：`buildEvidenceChains` 为每个 observation 构建简短 redacted summary（最多 200 字符输出片段），包含 scenarioId pseudonym、grade pass/fail、failures、输出摘要。
- **Atomic publish**：`publishImmutableBundle` 使用 hard-link 原子发布（EEXIST → fail-closed），`allowOverwrite: true` 跳过 hard-link 使用直接 `writeFile`。发布后 `chmod` 文件为 `0o400`（只读）。
- **Bundle source sidecar**：`buildShowcaseBundle` 写入 `.source.json` sidecar 文件到 `agent-bridge/showcase/bundle-sources/`，记录 RAW source runId（不进入 portable bundle）。retention planner 读取 sidecar 构建 `referencedRunIds` 集合。
- **Cost bucket truthfulness**：`toBundleCostBucket` 防御性将 `source: "unknown"` 强制为 `amountUsd: null`，unknown cost 不得显示为 `$0`。

### Loopback-only local read viewer

`local-viewer.ts` 产出 loopback-only HTTP 只读 viewer：

- **Loopback binding**：`LOOPBACK_HOSTS = ["127.0.0.1", "::1"]`。server 强制绑定到 loopback，拒绝非 loopback 请求。
- **Routes**：`GET /`（HTML 首页）、`GET /api/viewer`（JSON bundle）、`GET /health`、`GET /artifact`（JSON artifact summary）、`GET /bundle`（JSON bundle）。POST/PUT/DELETE/PATCH → 405；mutation query params → 400。
- **Bundle ↔ viewer parity**：`startLocalViewer` 接受 `salt?: Buffer` 参数，传入 `buildShowcaseBundleInMemory`，确保 viewer 与 bundle 使用同一 salt 产出同一 `integritySha256`。
- **Viewer handle**：`ViewerHandle` 提供 `close()` 方法（非 `stop()`），关闭 server 并释放端口。

### Live preview runner

`live-preview.ts` 产出 live preview runner：

- **Budget**：`LIVE_PREVIEW_SUT_CEILING_USD = 0.10`（与 smoke preset 相同）。`buildPreviewBudget` 构造 smoke-equivalent budget。
- **RunId prefix**：`LIVE_PREVIEW_RUN_ID_PREFIX = "preview_"`。runId 格式为 `preview_<timestamp>_<sha8>`。
- **Preview label**：`LIVE_PREVIEW_LABEL_FILE = "preview_label.json"`。label 文件记录 `runId`、`createdAt`、`isPreview: true`、`sourceCommand: "preview"`。
- **Model gate**：`verifyPreviewModelGate` 检查 6 个 pre-call gate（price table existence/fingerprint/freshness、model entry、worst-case cap、credential），运行后再检查 resolved model、provider telemetry、target window 与 artifact status。普通 paid run 继续 fail-closed；dedicated preview 仅允许冻结表覆盖且 worst-case ≤ `$0.10` 的模型。
- **Honest duration**：`runLivePreview` 记录真实 `durationMs`，不 sleep、不 fake latency。**C1 真实 preview 结果**：`windowMet: true`，`actualDurationMs: 149395`（约 2.5 分钟），`targetWindowMs: [120000, 300000]`（2–5 分钟窗口），`remainingGates: []`。
- **Preview label**：`PreviewLabel` 记录 `remainingGates`（actualRemainingGates，包含 mock_preview_target_window_not_met）、`targetWindowMs`、`actualDurationMs`、`windowMet`。

### Retention planning

`retention-planner.ts` 产出只读 retention planning report：

- **Schema**：`RETENTION_REPORT_SCHEMA_VERSION = 1`、`RETENTION_POLICY_VERSION = "v1-no-deletion"`。
- **Preserve reasons**：11 类（`status_failed`、`status_needs_review`、`status_partial_budget`、`contains_repair_packet`、`contains_diagnosis`、`contains_counterfactual`、`contains_calibration_artifact`、`contains_promotion_approval`、`referenced_by_showcase_bundle`、`is_promoted_baseline`、`preview_run`）。
- **Zero-deletion**：V1 policy 为 `v1-no-deletion`。所有 runs 标记 `eligibleForCleanup` 但不自动删除。`preserve: true` 的 runs 标记 `eligibleForCleanup: false`。
- **Report structure**：`RetentionReport` 包含 `schemaVersion`、`policyVersion`、`generatedAt`、`runs`（每个 run 的 `runId`、`runDir`、`sizeBytes`、`fileCount`、`startedAt`、`completedAt`、`ageDays`、`status`、`preset`、`hasRepairPacket`、`hasDiagnosis`、`hasCounterfactual`、`hasCalibrationArtifact`、`hasPromotionApproval`、`isPreview`、`referencedByShowcase`、`preserve`、`preserveReasons`、`eligibleForCleanup`、`summary`）、`bundles`（每个 bundle 的 `bundleId`、`bundlePath`、`sizeBytes`、`createdAt`、`sourceRunId`、`referencedByOther`、`preserve`、`eligibleForCleanup`、`summary`）、`integritySha256`。
- **Publish**：`publishRetentionReport` 原子发布到 `agent-bridge/showcase/retention/retention-report.json`。

### Shell contract acceptance harness

`agent-acceptance.ts` 为 3 个 shell agent profile 产出确定性 acceptance 报告：

- **Profiles**：`codex`、`claude-code`、`trae-equivalent`。每个 profile 指向同一 `SKILL_MD_PATH = ".agents/skills/evaluation-lab/SKILL.md"`。
- **独立 adapter**：三个 profile 使用**不同的**命令映射（codex: `--flag=value` 风格；claude-code: `-f value` 短标志；trae-equivalent: `--flag value` 空格分隔）。共享 primitive（step execution、JSON parsing、result publishing），非三份相同静态数组。
- **7-step mapping**：`discover`（list）、`validate`、`run`、`status`、`verify`、`show`、`repair-packet`。命令细节因 profile 不同而异。
- **输出标记**：`shellContractPassed: true/false`、`realAgentEvidence: false`。不宣称真实 Codex/Claude Code/Trae agent 验收。
- **Known-fault chain**：`runKnownFaultChain` 执行 evaluator-owned known-fault run：run failing fixture → diagnose → repair-packet list → 选 indexed packet → --packet-id prompt。empty/unindexed/no prompt 必须失败。不依赖 Golden 当前失败，不调用付费/真实 LLM，不污染 Golden registry。
- **Execution**：`runAgentAcceptance` 通过 `execFileSync("bash", [scriptPath, ...command])` 执行每个命令，捕获 stdout/stderr/exit code。
- **No LLM invocation**：harness 永不调用真实 LLM agent——它通过运行 CLI 命令模拟 agent。所有运行使用 `mock:mock-model`。
- **Report**：`AgentAcceptanceResult` 包含 `schemaVersion`、`profile`、`displayName`、`shellContractPassed`、`realAgentEvidence: false`、`passed`（deprecated 别名）、`skillMdPresent`、`skillMdSha256`、`steps`、`integritySha256`。

## Operator/Coding Agent commands

```bash
# Export a portable redacted showcase bundle from a completed run
scripts/eval-lab showcase export <run-id> --json

# Verify a showcase bundle's integrity and redaction
scripts/eval-lab showcase verify <bundle-path>

# Start the loopback-only local read viewer
scripts/eval-lab viewer start <run-id> [--port <port>] --json

# Run a live preview with smoke SUT ceiling ($0.10) and preview_ runId prefix
scripts/eval-lab preview --model mock:mock-model --json

# Generate a read-only retention planning report (zero-deletion V1)
scripts/eval-lab retention --json
scripts/eval-lab retention --publish --json

# Run Agent-first acceptance for 3 shell agent profiles
scripts/eval-lab agent-acceptance --profile codex --json
scripts/eval-lab agent-acceptance --profile claude-code --json
scripts/eval-lab agent-acceptance --profile trae-equivalent --json
scripts/eval-lab agent-acceptance --profile all --json
```

`showcase export` exits `0` when the bundle is published atomically; `1` when the source run has regressions (bundle still published with honest baseline); `2` on infrastructure failure; `3` on validation failure. `showcase verify` exits `0` when the bundle's integrity hash matches and redaction is complete; `3` on mismatch or incomplete redaction. `viewer start` exits `0` when the server starts and binds to loopback; `3` on validation failure. `preview` exits `0` when the preview run completes; `1` on regression; `2` on infrastructure failure; `3` on validation failure (including paid model fail-closed). `retention` exits `0` when the report is generated; `2` on infrastructure failure. `agent-acceptance` exits `0` when all profiles pass; `1` when any profile fails.

## Key files

**New modules (6):**

- `agent-bridge/src/evaluation/lab/schema-migration.ts` (436 lines) — `verifyAndMigrateArtifact`、`migrateArtifact`、`assertSupportedSchema`、`computeArtifactFingerprint`、`verifyResultGraph`、`verifyProvenance`、`SUPPORTED_SOURCE_SCHEMA_VERSIONS`、`PRESENTATION_SCHEMA_VERSION`、`MIGRATIONS`、`VerifiedArtifact` interface。
- `agent-bridge/src/evaluation/lab/showcase-bundle.ts` (~1230 lines) — `buildShowcaseBundle`、`buildShowcaseBundleInMemory`、`verifyShowcaseBundle`、`generatePseudonymSalt`、`pseudonymize`、`redactText`、`SHOWCASE_BUNDLE_SCHEMA_VERSION`、`SHOWCASE_BUNDLE_GENERATOR_VERSION`、`SHOWCASE_BUNDLE_DIR`、`SHOWCASE_RETENTION_DIR`、`SHOWCASE_BUNDLE_SOURCES_DIR`、`BundleSourceSidecar` interface、`ShowcaseBundle` interface。
- `agent-bridge/src/evaluation/lab/local-viewer.ts` (~515 lines) — `startLocalViewer`、`LOOPBACK_HOSTS`、`DEFAULT_VIEWER_PORT`、`ViewerOptions`、`ViewerHandle`。
- `agent-bridge/src/evaluation/lab/live-preview.ts` (~425 lines) — `runLivePreview`、`verifyPreviewModelGate`、`buildPreviewBudget`、`readPreviewLabel`、`LIVE_PREVIEW_SUT_CEILING_USD`、`LIVE_PREVIEW_RUN_ID_PREFIX`、`LIVE_PREVIEW_LABEL_FILE`、`PAID_MODEL_REMAINING_GATES`。
- `agent-bridge/src/evaluation/lab/retention-planner.ts` (~620 lines) — `buildRetentionReport`、`publishRetentionReport`、`verifyRetentionReport`、`RETENTION_REPORT_SCHEMA_VERSION`、`RETENTION_POLICY_VERSION`、`PreserveReason` type、`RetentionReport` interface。
- `agent-bridge/src/evaluation/lab/agent-acceptance.ts` (~570 lines) — `runAgentAcceptance`、`publishAgentAcceptanceReport`、`AGENT_PROFILES`、`AGENT_ACCEPTANCE_SCHEMA_VERSION`、`EVAL_LAB_SCRIPT`、`SKILL_MD_PATH`、`AgentProfileName` type、`AgentProfile` interface、`AcceptanceStepResult` interface、`AgentAcceptanceResult` interface。

**Modified modules (4):**

- `agent-bridge/src/evaluation/lab/cli.ts` — 新增 5 个 command handler（`showcase export/verify`、`viewer start`、`preview`、`retention [--publish]`、`agent-acceptance --profile`）。
- `agent-bridge/src/evaluation/lab/validation.ts` — `validateEvaluationConfig` 新增 `skipToolchainValidation?: boolean` option，为 true 时跳过 `validateToolchain()`。
- `agent-bridge/src/evaluation/lab/runner.ts` — `RunEvaluationOptions` 新增 `skipToolchainValidation?: boolean`，透传给 `validateEvaluationConfig()`。
- `agent-bridge/package.json` — 新增 5 个 eval scripts：`eval:showcase`、`eval:viewer`、`eval:preview`、`eval:retention`、`eval:agent-acceptance`。
- `scripts/eval-lab` — case 语句白名单新增 `showcase|viewer|preview|retention|agent-acceptance`。
- `.gitignore` — 新增 `agent-bridge/showcase/`（runtime artifacts；portable bundle 可通过 `git add -f` 提交）。

**Test file:**

- `agent-bridge/tests/unit/t46-7-showcase-closeout.test.ts` — 初始 18 个测试章节在跨 Slice hardening 后扩展为 224 tests，覆盖 schema migration、portable/redaction/pseudonym、viewer parity/只读、preview 原子性与 paid gates、retention、shell/known-fault acceptance、extension integrity 和 malformed artifact fail-closed。

## Verification

**第一批（2026-07-20）：**
- **Agent Bridge tests**：2346 passed / 10 failed（全部 10 个失败是预存在的 `t46-3-presets-contract.test.ts` Node 版本不匹配，与 #100 无关）。
- **Typecheck**：`npm run typecheck` 通过（无错误）。
- **Build**：`npm run build` 通过（无错误）。
- **Real CLI regression**：`golden-core verify` / `run smoke` / `showcase export` / `showcase verify` / `retention` / `preview` / `agent-acceptance --profile all`（21/21）全通过。C1 真实 preview `windowMet: true`，`remainingGates: []`。

**第二批与跨 Slice 收口（2026-07-25—2026-07-27）：** capability metadata、agent-acceptance all + known-fault、preview/extension/promotion hardening、typecheck/build 与三端全量门禁均已验证；最终基线见本文件末尾和 final audit。

- Backend：912 passed / 4 skipped，ruff 通过。
- Agent Bridge：2651/2651，typecheck/build 通过。
- Frontend：333 passed / 6 skipped，lint/build 通过。
- Golden Core：`run_1785085331148` 52/52，integrity verify 通过。

## T46 closeout 状态

Issue #100 是 T46 Evaluation Lab 的最后一个 ticket。本地实现完成后，T46 的 7 个 Slice（Slice 0-5 + Golden Core）全部实现：

- Slice 0（#94）：evaluator-owned isolation、bounded smoke、immutable evidence、CLI、Agent Skill。
- Slice 1 foundation（#95）：V2 hard graders、public human-action seams、hidden-field commitments。
- Slice 1 multi-turn（#96）：deterministic multi-turn controller、simulator integrity、Skill 8 dims、Runtime 11 fault classes、reliability、paired comparison、exit gate。
- Slice 2（#97）：diagnosis、counterfactuals、fault profiles、RCA benchmark、Repair Packets、Coding Agent prompts。
- Slice 3（#98）：governed calibration、semantic standards、active/candidate registries、conflict blocking、promotion approval。
- Slice 4（#99）：Golden Core expansion、52 canonical scenarios、9 entry conditions、P0 scope filter、robustness variants、candidate governance。
- Slice 5（#100）：showcase bundle、local viewer、live preview、schema migration、retention planning、agent acceptance。

**关闭结果**：

- Issue #100 已关闭；C1 真实 preview 与 C2 真实 agent acceptance 证据均已归档。
- 父 Issue #93 已关闭；T46 的 #94–#100 全部完成。
- Golden Core mock final evidence 为 52/52（post-review run `run_1785085331148`，integrity `91737377d5de9b5c6725fe3505c26c66743519350b2d199fc9dd0255e46863b2`）。S1–S6 candidate changes 已批准并实现；30/52 基线已过期。Golden Core verify 通过。
- DeepSeek V1 价格表已冻结；普通 paid run 继续 fail-closed，dedicated Flash preview 按 `$0.10` worst-case gate 授权。
- Active standard promotion 不在默认路径（需显式 Robert instruction + reviewable Git diff + matching fingerprints + all conflicts resolved）。
- Shell contract acceptance 不是真实 agent 验收：`realAgentEvidence: false`，`shellContractPassed` 只验证 CLI 命令映射。
- C1 真实 preview：已完成，`windowMet: true`，`remainingGates: []`，integrity `2d8746b78305a35ec425c76c32b4fcbd0930b583c4f5b006d10117b9dd37cf3e`。
- 跨 Slice 全面对抗审查与修复对齐已于 2026-07-26 完成。最终审计文档见 `docs/T46/ProjectFlow_Agent_Evaluation_Lab_Final_Audit_2026-07-26.md`。
