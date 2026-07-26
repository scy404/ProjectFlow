# ProjectFlow Agent Evaluation Lab — 最终审计/修复交接文档

> **日期**：2026-07-26 UTC（北京时间 2026-07-27 完成收口）
> **分支**：`glm/t46-100-showcase-closeout`（基于 `main` `8d80b79`）
> **目标读者**：Robert（决策）、Coding Agent（接手修复）
> **状态**：Issue #100 和父 Issue #93 **尚未关闭**。本文件是关闭候选的完整证据链。

## 1. 结论与关闭建议

T46 Evaluation Lab 的 7 个 Slice（Slice 0-5 + Golden Core）全部实现并经过跨 Slice 对抗审查与修复。**#100 与父 Issue #93 的技术关闭门禁已经满足**；剩余工作仅是提交、推送、合并和关闭 Issue。

| 条件 | 状态 | 说明 |
|---|---|---|
| S1–S6 candidate changes 批准并实现 | ✅ 完成 | Robert 已批准，全量验证通过 |
| Golden Core mock final 52/52 | ✅ 完成 | post-review run `run_1785085331148` |
| C1 真实 paid preview (Flash) | ✅ 完成 | `preview_1785081515993_65e5a2e7d014e164` |
| C2 真实 Agent acceptance (3 slots) | ✅ 完成 | audited summary `d2995508...` |
| Shell harness 回归 | ✅ 21/21 | `realAgentEvidence: false` |
| Known-fault chain | ✅ 7/7 | evaluator-owned |
| RCA benchmark | ✅ 12 samples, passed | all 5 gates |
| Showcase bundle + verify | ✅ | `94c527bc...` |
| Viewer loopback 验证 | ✅ | GET 200, POST 405, mutation 400 |
| Retention report | ✅ | v1-no-deletion, 892 runs, 0 auto-delete |
| 三端基线 | ✅ | backend 912/4, agent-bridge 2651/2651, frontend 333/6 |
| Governed promotion 安全边界 | ✅ 按设计未执行 | active registry 仍空；证据不足的 mock rubric 正确显示 `anyEligibleForPromotion=false` |
| 付费模型预算边界 | ✅ | V1 价格表已冻结；Flash bounded preview 通过，Pro 因 worst-case 超过 `$0.10` 在调用前拒绝 |

**建议**：合并本分支后关闭 Issue #100，再关闭父 Issue #93。Active semantic promotion 需要另一条 Robert 显式指令，不是 T46 closeout 的前置条件；普通 paid run 保持 fail-closed 也是设计结果，不是遗留缺陷。

---

## 2. 架构与信任边界

### 2.1 评测系统不变约束

- Proposal-Confirm 是唯一人类确认边界；FastAPI/DB 仍是事实源。
- ToolExecutionApproval 不进入当前 runtime state machine。
- Hard deterministic gates 永远优先；Semantic Judge 默认是 soft evidence。
- Coding Agent 成本**永远不计入** ProjectFlow SUT 上限。
- `unknown` cost 不得显示为 `$0.00`。
- 付费模型在冻结价格表 + pre-call worst-case 前 continue fail-closed。
- **唯一例外**：dedicated bounded `preview` 命令允许 Flash（deepseek-v4-flash），上限 `$0.10`；Pro worst-case `$0.14355 > $0.10`，pre-call fail-closed。
- 价格表来源：<https://api-docs.deepseek.com/quick_start/pricing>。

### 2.2 Agent identity 信任模型

Coordinator/plugin metadata 只证明“发起了哪个请求、由哪个 agent surface 执行”，**不证明 Provider 最终 native model identity**；raw self-report 同样不可信：

| Slot | Coordinator job | Plugin recordedExecutionModel | Route status | Raw self-report | Coding Agent cost |
|---|---|---|---|---|---|
| Claude primary | `cc-ms1x3k7o-f2a1e5` | `deepseek-v4-pro` | accepted but unverified | `claude-opus-4-8` **(conflict)** | $0.5983 |
| Trae-equivalent | `cc-ms1x74v6-a343cb` | `deepseek-v4-pro` | accepted but unverified | N/A | $0.6573 |
| Codex | current root task | null | N/A | codex-desktop | unknown/null |

- Raw `claude-opus-4-8` 是 self-report conflict，显式保留，不当 confirmed identity。
- Trae 是桌面应用，无审计 CLI；使用明确披露的 Claude Code equivalent substitute。只证明 Skill→NL→CLI→artifact 等价，不证明 Trae UI/provider/model diversity。
- 不把 shell profile harness 当 real evidence。

### 2.3 Preview 门禁（6 项 pre-call + 4 类 post-run）

| # | Gate | 说明 |
|---|---|---|
| 1 | price table exists | Provider 有冻结表 |
| 2 | fingerprint matches | 完整表 payload 未被篡改 |
| 3 | table fresh | 冻结时间不超过 90 天 |
| 4 | model entry exists | 请求模型有明确价格项 |
| 5 | worst-case within cap | 调用前估算 ≤ `$0.10` |
| 6 | credential present | 仅注入所选模型的 credential |

Post-run 继续校验 resolved model 无 drift、provider-reported cost telemetry、2–5 分钟窗口和 source artifact completed；运行中预算/Token/request/wall-time 仍由 evaluator 实时拦截。C1 的 pre-call 与 post-run 门禁全部通过。

---

## 3. 跨 Slice 对抗审查发现及修复

### 3.1 S1–S6 标准/夹具变更（Robert 已批准，2026-07-26 实施）

| # | 影响 | P | 修复 | 回归验证 |
|---|---|---|---|---|
| S1 | 8 runtime-fault read-only 场景路由 | P0 | `expectedMode: "answer"`, `expectedSkill: "project-read"` | t46-6-golden-core 扩展 |
| S2 | 3 status-read + 多处潜在 | P1 | 全局 `get_project_state` → `get_workspace_state` | registry/v1 冻结快照更新 |
| S3 | `assignment-adversarial-direct-modify` | P0 | Prompt 改为"跳过成员确认直接生效"，保留 `assignment-planning` route + refuse direct commit | t46-6 路由测试 |
| S4 | `replan-conflict-duplicate` | P0 | FixtureContract 基础设施 + evaluator-only seed endpoint + `isPersistedSideEffect` 谓词 + `proposalFactsUnchanged` grader | 新增 fixture-contracts.test.ts, hard-graders-mutation |
| S5 | `conversation-private-visibility` | P0 | Evaluator 通过 public client seam 创建 private conversation；Agent 在 conversation 内回答，不获得 mutation tool | hard-graders-mutation |
| S6 | `memory-direction-card-confirmed` | P1 | `memoryType: "direction"`, `sourceType: "direction_card_confirmed"`, `newSinceBefore: true` | 8 个针对性 mutation tests |

### 3.2 终审发现修复（3 项）

| # | 根因 | 修复 | 文件 |
|---|---|---|---|
| A | Semantic candidate promotion 允许 `needs_review` 通过 | 现在要求 `pass`、合法 `score`、`reason`、`evidenceReferences`、`confidence ∈ (0,1]`、`judgeManifestRef`，eligibility 和唯一 active mutation path 双重校验 | `calibration-runner.ts`, `standards-registry.ts` |
| B | Calibration extension revision 误用 calibration artifact integrity 而非 base run integrity root | Extension revision 统一锚定 immutable source run integrity root | `cli.ts`, `extension-integrity.ts` |
| C | Skill lint 误判 `list_pending_proposals` 为写操作 | 分类修正；真实 `skills/` 目录变成强制门禁 | skill-lint.ts |

### 3.3 对抗审查 7 发现（A–G）修复测试覆盖

| Finding | 测试覆盖 |
|---|---|
| 1 (camelCase params) | `fixture-contracts.test.ts` — snake_case verification |
| 2 (missing precondition) | Golden Core invariants |
| 3 (missing fixtureContractSha256) | `fixture-contracts.test.ts` — 10 tests |
| 4 (backend fixture hardening) | `test_evaluation_fixture.py` + backend 912/4 全量基线 |
| 5 (aspirational S6) | `hard-graders-mutation.test.ts` — 3 tests |
| 6 (vacuous S5) | `hard-graders-mutation.test.ts` — 3 tests |
| 7 (router gap) | `skill-router.test.ts` — 7 tests |

---

## 4. 最终证据矩阵

### 4.1 Golden Core — mock final 52/52

| 属性 | 值 |
|---|---|
| Run ID | `run_1785085331148` |
| Preset | `golden-core` |
| Model | `mock:mock-model` |
| Status | `completed` |
| Observations | 52 |
| Passed | 52 |
| Failed | 0 |
| SUT cost | `$0.00` (`versioned_price_estimate`) |
| Integrity root | `91737377d5de9b5c6725fe3505c26c66743519350b2d199fc9dd0255e46863b2` |
| Artifact paths | `agent-bridge/artifacts/run_1785085331148/{report,integrity,manifest,calibration-artifact}.json` |
| Verify | ✅ `scripts/eval-lab verify run_1785085331148` 通过；registry snapshot 另由 `golden-core verify` 校验 |

### 4.2 Calibration（mock，post-review final base）

| 属性 | 值 |
|---|---|
| Calibration ID | `run_1785085331148` |
| `passed` | `true` |
| `anyEligibleForPromotion` | **`false`** |
| Failure reasons | `verdict=needs_review`, `score 缺失`, `reason 缺失`, `evidenceReferences 缺失`, `confidence=0` |
| Active registry fingerprint | `6cce537d6555d57703c54304063ce92540598167533ff5e273b49fabd36d9229`（仍为空） |
| Active standards count | 0 |
| Candidate count | 1 (`p0-planning-specificity-rubric`) |
| Integrity | `7672a7b28f7d8d79b4d6af1cfbb6dd553d19eff116975d4d0de3e70b570f286a` |

**禁止声称已 promotion**。Active registry 仍为空。Mock rubric 无 promotion-ready evidence。唯一 active mutation path (`applyPromotionApproval`) 要求显式 Robert instruction + reviewable Git diff + matching fingerprints + all conflicts resolved。

### 4.3 Showcase bundle

| 属性 | 值 |
|---|---|
| Path | `agent-bridge/showcase/bundles/showcase_run_a475023bc46bc581_20260726170228.json` |
| Bundled from | `run_a475023bc46bc581`（pseudonymized） |
| Integrity SHA-256 | `0904064f7618693e8285a8358d15f5b6ac5c1551c36731841d081d16c325a5bc` |
| `releaseVerdict` | `passed` |
| `honestBaseline` | `52/52` |
| `showcase verify` | ✅ 通过 |
| Forbidden claims | 不得宣称真实用户满意度/生产质量/留存/业务结果 |
| 提交方式 | 作为唯一 committed-ready portable bundle 使用 `git add -f` 纳入 closeout commit |

### 4.4 C1 — Paid Flash preview

| 属性 | 值 |
|---|---|
| Run ID | `preview_1785081515993_65e5a2e7d014e164` |
| Preset | `demo` |
| Model | `deepseek:deepseek-v4-flash`（resolved by `sidecar_health`） |
| Status | `completed` |
| Observations | 3/3 passed |
| Duration | 149395 ms（~2.5 min） |
| Window met | `true`（target: 120000–300000 ms） |
| SUT cost | `$0.0054107256` (`provider_reported`) |
| Input tokens | 15561 |
| Output tokens | 16871 |
| Requests | 17 |
| Worst-case | `$0.0462`（≤ `$0.10` cap） |
| Remaining gates | `[]`（全部通过） |
| Integrity root | `2d8746b78305a35ec425c76c32b4fcbd0930b583c4f5b006d10117b9dd37cf3e` |
| `preview_label.json` | `preview: true`, `modelIsMock: false`, `realPaidAcceptance: true` |
| **Pro worst-case** | `$0.14355 > $0.10` → **pre-call fail-closed** |
| Coding Agent cost | `unknown/null`，不计入 SUT cap |

### 4.5 C2 — Real Agent acceptance（3 slots）

| 属性 | 值 |
|---|---|
| Audit path | `agent-bridge/artifacts/agent-acceptance-real/audited-summary-20260726.json` |
| Audit integrity | `d29955085d78500f186f9f636a423ce6b5e2421a2347c1f8cc5d92627d7b2c7e` |
| C2 verdict | **`passed: true`** |
| 3 slot raw SHA-256 | Codex `ddd4d0c0...`, Claude `f3e2bbe4...`, Trae `6628ec45...` |
| 每 slot 7/7 exit zero | ✅ |
| Fresh run artifact integrity | ✅ 全部 status completed |
| Cost split | SUT $0.00 / evaluator $0.00 / Coding Agent $1.2556（不计入 SUT） |
| `agent-identity-not-self-reported` gate | ❌ intentionally failed（Claude self-report conflict 保留） |

### 4.6 Shell harness + Known-fault + RCA benchmark

| 制品 | 结果 |
|---|---|
| `agent-acceptance --profile all` | 21/21 通过，`realAgentEvidence: false` |
| Known-fault chain | 7/7 通过（evaluator-owned, mock:mock-model） |
| RCA benchmark | 12 samples, `passed: true` |
| ├ top1 accuracy | 0.8333 |
| ├ top3 recall | 0.8333 |
| ├ false attribution | 0.0833 |
| ├ evidence completeness | 1.0 |
| └ confidence calibration | 1.0 |

### 4.7 Retention report

| 属性 | 值 |
|---|---|
| Path | `agent-bridge/showcase/retention/retention_20260726162337.json` |
| Policy | `v1-no-deletion` |
| Runs | 892 |
| Bundles | 5 |
| `autoDeletionPerformed` | `false` |
| 本地 artifact | 不提交 git |

### 4.8 三端最终基线

| 端 | 测试 | Lint | Typecheck/Build |
|---|---|---|---|
| Backend | 912 passed / 4 skipped | ruff ✅ | N/A |
| Agent Bridge | 2651/2651 | N/A | `tsc --noEmit` ✅, build ✅ |
| Frontend | 333 passed / 6 skipped | ✅ | ✅ |
| git diff --check | clean | | |

Node 版本：必须通过 `scripts/npm` 使用 24.15.0。

---

## 5. C1/C2 诚实披露

### 5.1 C1 限制

- 只有 Flash 模型在此 `$0.10` bounded preview 中允许；Pro 因 worst-case `$0.14355 > $0.10` 被 pre-call fail-closed。
- 普通（非 preview）paid run **仍 fail-closed**——只有 dedicated bounded preview 命令允许 Flash。
- Coding Agent 成本 `unknown/null`（Claude job 成本独立，不计入 SUT）。
- 3/3 observations 是 demo preset public-seam subset，不是完整 52 Golden Core。

### 5.2 C2 限制

- Claude raw identity conflict 显式记录，不信任 self-report。
- Trae-equivalent 是 substitute，不证明 Trae UI/provider/model diversity。
- Codex backend model/cost 未独立暴露。
- Shell harness 21/21 通过但 `realAgentEvidence: false`——不是真实 agent 验收。
- 所有 SUT 运行使用 `mock:mock-model`（`$0.00`）。

---

## 6. 成本分账

| 分类 | 金额 | 来源 | 计入 SUT cap |
|---|---|---|---|
| SUT（Golden Core mock） | `$0.00` | `provider_reported` | ✅ |
| Evaluator（mock） | `$0.00` | `versioned_price_estimate` | ❌ |
| Coding Agent — C2 Claude primary | `$0.5983` | `coordinator_telemetry` | ❌ |
| Coding Agent — C2 Trae substitute | `$0.6573` | `coordinator_telemetry` | ❌ |
| Coding Agent — C2 Codex | `null` | `unknown` | ❌ |
| C1 SUT（Flash preview） | `$0.0054107256` | `provider_reported` | ✅ |
| C1 Coding Agent（两个 Claude Code 实现/修复 job） | `$33.1206` | companion telemetry | ❌ |

**本次终审中可审计的 C1+C2 Coding Agent 成本：`$34.3762`。** Codex slot 的模型成本仍为 `unknown/null`；文档整理 Agent 与 SUT/evaluator 同样独立分账，不计入任何 ProjectFlow SUT cap。

---

## 7. 已知限制与非目标

- 普通 paid run 保持 fail-closed；V1 冻结价格表只授权 dedicated bounded Flash preview。
- Active standard promotion 不在默认路径；需显式 Robert instruction。
- Golden Core 52/52 是 **mock** 基线，不是 production pass。
- Showcase bundle `releaseVerdict.passed` 如实报告 mock 结果；forbidden claims 已嵌入。
- Shell acceptance harness 不是真实 Agent 验收。
- Trae-equivalent 是 substitute；不证明 Trae 桌面应用行为。
- Node 必须 24.15.0（通过 `scripts/npm`）。

---

## 8. Coding Agent 未来接手流程（当评测失败时）

当某次 Golden Core 或 full preset run 产生 regression 时，Coding Agent 应按以下流程接手：

```bash
# Step 1: 诊断失败 run
scripts/eval-lab diagnose <failed-run-id> --json

# Step 2: 运行 RCA benchmark 确认诊断质量
scripts/eval-lab rca-benchmark <failed-run-id> --json
# 期望 5 gate 全部通过：top1Accuracy ≥ 0.5, falseAttributionRate ≤ 0.3,
#   confidenceCalibration ≥ 0.7, evidenceCompleteness ≥ 0.7, top3Recall - top1Accuracy ≤ 0.4

# Step 3: 列出 repair packets
scripts/eval-lab repair-packet <failed-run-id> --json

# Step 4: 选取具体 packet 获取 copy-ready prompt
scripts/eval-lab repair-packet <failed-run-id> --packet-id <id> --json
# 输出包含完整的修复 prompt（代码指纹验证/观察问题/期望契约/复现命令/
#   证据路径/因果状态/建议范围/保护边界/非目标/验收标准/验证命令/
#   禁止行为/stale 检查）

# Step 5: 执行修复后重新验证
scripts/eval-lab validate --preset golden-core --model mock:mock-model
scripts/eval-lab run --preset golden-core --model mock:mock-model --json
scripts/eval-lab verify <new-run-id>
```

**关键约束**：
- Repair packet `staleState !== "fresh"` 时必须先验证代码指纹，代码可能已偏离 packet 创建时的状态。
- Investigation packet（`packetType: "investigation"`, `staleState: "unknown"`）不可直接执行——必须先用诊断和验证确认根因。
- 不弱化 hard grader、不改写 Golden truth、不删除失败场景。
- 所有 modified scenario/fixture 必须通过 `golden-core verify` + zero-token `validate`。
- 不要在没有 Robert 显式 instruction 的情况下执行 `promote-standard`。

---

## 9. Issue #100 / #93 关闭 Checklist

| # | Gate | 状态 |
|---|---|---|
| 1 | 7 Slice 全部实现 | ✅ |
| 2 | Golden Core mock 52/52 | ✅ `run_1785085331148` |
| 3 | S1–S6 candidate changes 实现/验证 | ✅ |
| 4 | C1 real paid preview | ✅ `preview_1785081515993_65e5a2e7d014e164` |
| 5 | C2 real Agent acceptance | ✅ audited summary `d2995508...` |
| 6 | Showcase bundle + verify | ✅ `94c527bc...` |
| 7 | Viewer loopback 验证 | ✅ |
| 8 | Retention report | ✅ |
| 9 | RCA benchmark passed | ✅ |
| 10 | Shell + known-fault harness | ✅ 21/21 + 7/7 |
| 11 | 三端基线全通过 | ✅ backend 912/4, agent-bridge 2651/2651, frontend 333/6 |
| 12 | `git diff --check` clean | ✅ |
| 13 | Governed promotion fail-closed | ✅ mock candidate 不可晋升，active registry 未变 |
| 14 | 付费模型价格/预算门禁 | ✅ V1 表冻结；Flash 通过；Pro 调用前拒绝 |
| 15 | push / merge / close | ❌ **未执行** |

**关闭判断**：技术 Gate #1–#14 全部通过。完成 Gate #15 后可关闭 #100/#93。

---

## 10. 文档同步状态

本文档创建于 2026-07-27，同步了以下文件的陈旧状态：

| 文件 | 同步内容 |
|---|---|
| `CLAUDE.md` | T46 #100 段落更新为最终基线 |
| `README.md` | 更新 Current Status、closeout 描述 |
| `CHANGELOG.md` | 追加 T46 final 条目 |
| `docs/T46/ProjectFlow_Agent_Evaluation_Lab_Slice5_Handoff.md` | C1/C2 完成、Golden Core 52/52、第二批已完成 |
| `docs/T46/ProjectFlow_Agent_Evaluation_Lab_Final_Standard_Conflicts.md` | C1/C2 完成、Golden Core 52/52 |
| `.agents/skills/evaluation-lab/SKILL.md` | Golden Core 52/52、C1/C2 完成、preview 更新 |
| `docs/runbook.md` | 所有 stale 陈述修正 |
**未同步**（不需改动或不同受众）：
- T41–T45 历史文档——不在本次审查范围
- Slice 0/1/3/4 handoff——不包含 #100 状态，保持不变
- `PRODUCT.md` / `DESIGN.md` / `CONTEXT.md`——不包含 T46 特定陈述
- T23/T42 历史文档——不相关
- `docs/adr/`——不相关
- `docs/superpowers/`——不相关
