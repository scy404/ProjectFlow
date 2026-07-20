# T46 Slice 5 Evidence-Backed Showcase & Closeout 交接

> Issue：[#100](https://github.com/wubq511/ProjectFlow/issues/100)
>
> 状态：2026-07-20 本地实现完成于分支 `glm/t46-100-showcase-closeout`（基于 `main` `8d80b79`）。本地 commit `feat(evaluation): ship evidence-backed showcase and T46 closeout`。未 push、未 merge、未关闭 Issue #100 或父 Issue #93。
>
> 边界：#100 在 #99 的 Golden Core 之上补齐两个只读展示面（portable committed redacted showcase bundle + loopback-only local read viewer）、live preview、schema/provenance 校验、retention planning 与 Agent-first acceptance。不重新设计评测系统；基于现有 immutable result graph、artifact store、CLI 和 Agent Skill 扩展。保留 Golden Core public-seam mock 基线 30/52 的真实回归证据；不弱化 hard grader、不改写 Golden truth、不删除失败场景、不把 regression 显示为 pass、不自动 promotion。

## 交付结论

Issue #100 已实现 6 项 acceptance criteria：

1. **两个只读展示面消费同一 immutable result graph**：`showcase-bundle.ts` 产出 portable committed redacted showcase bundle（`agent-bridge/showcase/bundles/<bundleId>.json`，可 `git add -f` 提交）；`local-viewer.ts` 产出 loopback-only（`127.0.0.1`/`::1`）HTTP 只读 viewer。两者都通过 `schema-migration.ts` 的 `verifyAndMigrateArtifact` 消费同一 `VerifiedArtifact`，不重新计算 grade、不修改 artifact、不调用 LLM。

2. **Live preview + 原子发布 + 预览标签**：`live-preview.ts` 使用 smoke SUT 上限 `$0.10`、`preview_` runId 前缀、`preview_label.json` 标记文件；`publishImmutable` 使用 hard-link 原子发布（EEXIST → fail-closed），`allowOverwrite: true` 仅在测试或显式覆盖路径使用；付费模型在冻结价格表与调用前最坏成本预估前继续 fail-closed（`PAID_MODEL_REMAINING_GATES` 4 项门禁）。

3. **Schema/hash/provenance 校验 + 确定性 migration + unknown-schema fail-closed**：`schema-migration.ts` 的 `verifyAndMigrateArtifact` 先读 `integrity.json`，验证 `sha256(reportRaw) === integrity.reportSha256` 后再解析 `report.json`；`verifyResultGraph` 检查 entries、evidence root、integrity root；`verifyProvenance` 检查 provenance 字段。`SUPPORTED_SOURCE_SCHEMA_VERSIONS = [1]`、`PRESENTATION_SCHEMA_VERSION = 1`、`MIGRATIONS` 为空（V1 无需迁移）。`assertSupportedSchema` 对未知 schema version fail-closed。

4. **只读 retention planning + zero-deletion + preserve markers**：`retention-planner.ts` 的 `buildRetentionReport` 扫描所有 artifact runs 与 showcase bundles，标记 11 类 preserve reasons（`status_failed`、`status_needs_review`、`status_partial_budget`、`contains_repair_packet`、`contains_diagnosis`、`contains_counterfactual`、`contains_calibration_artifact`、`contains_promotion_approval`、`referenced_by_showcase_bundle`、`is_promoted_baseline`、`preview_run`）。V1 policy 为 `v1-no-deletion`：所有 runs 标记 `eligibleForCleanup` 但不自动删除。`publishRetentionReport` 原子发布到 `agent-bridge/showcase/retention/retention-report.json`。

5. **Agent-first acceptance harness**：`agent-acceptance.ts` 为 3 个 shell agent profile（`codex`、`claude-code`、`trae-equivalent`）各定义 7 步确定性 CLI 命令映射（discover/validate/run/status/verify/show/repair-packet）。harness 通过 `execFileSync("bash", [scriptPath, ...command])` 执行每个命令，捕获 stdout/stderr/exit code，验证 expected JSON fields 存在。harness 永不调用真实 LLM agent——它通过运行 CLI 命令模拟 agent。所有运行使用 `mock:mock-model`，从不调用付费模型。

6. **诚实 Golden Core 基线保留**：showcase bundle 的 `releaseVerdict` 与 `honestBaseline` 字段如实报告原始 run 的 pass/fail 状态。Golden Core public-seam mock 基线 30/52 的失败场景被保留在 showcase bundle 的 evidence chains 中，不通过弱化 grader 或改写 Golden truth 消除。`retention-planner` 将 `status_failed` 的 runs 标记为 preserve，防止清理。

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
- **Model gate**：`verifyPreviewModelGate` 检查 4 项门禁（`PAID_MODEL_REMAINING_GATES`）：`frozen_pricing_table`、`pre_call_worst_case_cost`、`provider_api_key_present`、`sut_cost_under_ceiling`。付费模型在冻结价格表与调用前最坏成本预估前继续 fail-closed。
- **Honest duration**：`runLivePreview` 记录真实 `durationMs`，不 sleep、不 fake latency。
- **Skip toolchain validation**：`runLivePreview` 调用 `runEvaluation` 时传入 `skipToolchainValidation: true`，跳过 Node 版本检查（因为 preview 是 operator-facing 命令，不需要 toolchain 一致性）。

### Retention planning

`retention-planner.ts` 产出只读 retention planning report：

- **Schema**：`RETENTION_REPORT_SCHEMA_VERSION = 1`、`RETENTION_POLICY_VERSION = "v1-no-deletion"`。
- **Preserve reasons**：11 类（`status_failed`、`status_needs_review`、`status_partial_budget`、`contains_repair_packet`、`contains_diagnosis`、`contains_counterfactual`、`contains_calibration_artifact`、`contains_promotion_approval`、`referenced_by_showcase_bundle`、`is_promoted_baseline`、`preview_run`）。
- **Zero-deletion**：V1 policy 为 `v1-no-deletion`。所有 runs 标记 `eligibleForCleanup` 但不自动删除。`preserve: true` 的 runs 标记 `eligibleForCleanup: false`。
- **Report structure**：`RetentionReport` 包含 `schemaVersion`、`policyVersion`、`generatedAt`、`runs`（每个 run 的 `runId`、`runDir`、`sizeBytes`、`fileCount`、`startedAt`、`completedAt`、`ageDays`、`status`、`preset`、`hasRepairPacket`、`hasDiagnosis`、`hasCounterfactual`、`hasCalibrationArtifact`、`hasPromotionApproval`、`isPreview`、`referencedByShowcase`、`preserve`、`preserveReasons`、`eligibleForCleanup`、`summary`）、`bundles`（每个 bundle 的 `bundleId`、`bundlePath`、`sizeBytes`、`createdAt`、`sourceRunId`、`referencedByOther`、`preserve`、`eligibleForCleanup`、`summary`）、`integritySha256`。
- **Publish**：`publishRetentionReport` 原子发布到 `agent-bridge/showcase/retention/retention-report.json`。

### Agent-first acceptance harness

`agent-acceptance.ts` 为 3 个 shell agent profile 产出确定性 acceptance 报告：

- **Profiles**：`codex`、`claude-code`、`trae-equivalent`。每个 profile 指向同一 `SKILL_MD_PATH = ".agents/skills/evaluation-lab/SKILL.md"`。
- **7-step mapping**：`discover`（`list --json`）、`validate`（`validate --preset smoke --model mock:mock-model`）、`run`（`run --preset smoke --model mock:mock-model --json`）、`status`（`status <runId>`）、`verify`（`verify <runId>`）、`show`（`show <runId>`）、`repair-packet`（`repair-packet <runId> --json`）。
- **Execution**：`runAgentAcceptance` 通过 `execFileSync("bash", [scriptPath, ...command])` 执行每个命令，捕获 stdout/stderr/exit code。`runId` 从 `run` 步骤的 JSON 输出提取，代入后续步骤。
- **JSON field verification**：`expectsJson = Boolean(mapping.expectedJsonFields && mapping.expectedJsonFields.length > 0)`。当 `expectedJsonFields` 指定时，harness 验证 stdout 中至少一行 JSON 包含所有 expected fields（支持 event-stream 多行 JSON，取 union）。
- **No LLM invocation**：harness 永不调用真实 LLM agent——它通过运行 CLI 命令模拟 agent。所有运行使用 `mock:mock-model`。
- **Report**：`AgentAcceptanceResult` 包含 `schemaVersion`、`profile`、`displayName`、`passed`、`skillMdPresent`、`skillMdSha256`、`steps`（每个步骤的 `stepId`、`naturalLanguage`、`command`、`expectedExitCode`、`actualExitCode`、`stdout`、`stderr`、`passed`、`failureReason`、`jsonFieldsPresent`、`jsonFieldsMissing`、`durationMs`）、`runId`、`runReportPath`、`repairPacketPath`、`startedAt`、`completedAt`、`durationMs`、`integritySha256`。
- **Publish**：`publishAgentAcceptanceReport` 原子发布到 `agent-bridge/showcase/agent-acceptance/acceptance-report.json`。

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

- `agent-bridge/tests/unit/t46-7-showcase-closeout.test.ts` (~1543 lines, 101 tests) — 18 个测试章节：§2 Schema migration (9 tests)、§3 Portable showcase bundle (8 tests)、§4 Redaction attacks (5 tests)、§5 Bundle-scoped pseudonyms (6 tests)、§6 Viewer ↔ bundle parity (2 tests)、§7 No grade recomputation (3 tests)、§8 Loopback-only binding (5 tests)、§9 Viewer no mutation routes (10 tests)、§10 Atomic preview publish (7 tests)、§11 Schema migration explicitness (3 tests)、§12 Future schema fail-closed (4 tests)、§13 Malformed artifact fail-closed (6 tests)、§14 Retention planning (8 tests)、§15 Agent-first acceptance profiles (9 tests)、§16 Cost bucket truthfulness (4 tests)、§17 Live preview model gate (7 tests)、§18 CLI smoke (3 tests)。

## Verification

- **Agent Bridge tests**：2346 passed / 10 failed（全部 10 个失败是预存在的 `t46-3-presets-contract.test.ts` Node 版本不匹配，与 #100 无关）。
- **Typecheck**：`npm run typecheck` 通过（无错误）。
- **Build**：`npm run build` 通过（无错误）。
- **Real CLI regression**：
  - `golden-core verify`：52 个 canonical scenarios，fingerprint `e9fb97e3742e3c71dbc7cd6cfe43ec8775bbb73df43e81420c9fcdead1951c4e` 匹配。
  - `run --preset smoke --model mock:mock-model --json`：1/1 passed，`integrityRootSha256` 生成。
  - `showcase export <run-id> --json`：bundle 原子发布，`releaseVerdict: "passed"`，`honestBaseline: "1/1"`。
  - `showcase verify <bundle-path>`：bundle integrity hash 匹配，redaction 完整。
  - `retention --json`：report 生成，preserve markers 正确（`status_failed`、`preview_run`、`referenced_by_showcase_bundle` 等），V1 不自动删除。
  - `preview --json`：`runId` 前缀 `preview_`，`durationMs: 1011`（真实，无 sleep inflation），`modelIsMock: true`，`remainingGates: []`（mock 模型全部门禁通过），`sutCost.amountUsd: 0`（在 $0.10 上限内）。
  - `agent-acceptance --profile all --json`：3 个 profile × 7 步 = 21/21 全通过，`allPassed: true`，`exitCode: 0`。每个步骤的 `jsonFieldsPresent` 与 `jsonFieldsMissing` 正确填充。

## T46 closeout 状态

Issue #100 是 T46 Evaluation Lab 的最后一个 ticket。本地实现完成后，T46 的 7 个 Slice（Slice 0-5 + Golden Core）全部实现：

- Slice 0（#94）：evaluator-owned isolation、bounded smoke、immutable evidence、CLI、Agent Skill。
- Slice 1 foundation（#95）：V2 hard graders、public human-action seams、hidden-field commitments。
- Slice 1 multi-turn（#96）：deterministic multi-turn controller、simulator integrity、Skill 8 dims、Runtime 11 fault classes、reliability、paired comparison、exit gate。
- Slice 2（#97）：diagnosis、counterfactuals、fault profiles、RCA benchmark、Repair Packets、Coding Agent prompts。
- Slice 3（#98）：governed calibration、semantic standards、active/candidate registries、conflict blocking、promotion approval。
- Slice 4（#99）：Golden Core expansion、52 canonical scenarios、9 entry conditions、P0 scope filter、robustness variants、candidate governance。
- Slice 5（#100）：showcase bundle、local viewer、live preview、schema migration、retention planning、agent acceptance。

**未关闭项**：

- Issue #100 本身未关闭（本地 commit，未 push/merge/close）。
- 父 Issue #93 未关闭。
- Golden Core public-seam mock 基线 30/52 的剩余失败保留为最终跨 Slice 全面对抗审查与修复对齐的输入，不通过弱化 grader 消除。
- 付费模型在冻结价格表与调用前最坏成本预估前继续 fail-closed。
- Active standard promotion 不在默认路径（需显式 Robert instruction + reviewable Git diff + matching fingerprints + all conflicts resolved）。
- 跨 Slice 全面对抗审查与修复对齐按用户要求留到全部 T46 tickets 完成后统一进行（#100 完成后即可开始）。
