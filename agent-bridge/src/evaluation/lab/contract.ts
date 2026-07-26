/** Versioned public contracts for Evaluation Lab Slice 0. */

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const EVALUATOR_VERSION = "t46-slice0-v1";

export type CostSource = "provider_reported" | "versioned_price_estimate" | "unknown";
export type EvaluationRunStatus =
  | "running"
  | "completed"
  | "regression"
  | "partial_budget"
  | "infrastructure_error";

export interface ScenarioContract {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  scenarioId: string;
  visible: {
    prompt: string;
  };
  hidden: {
    expectedMode: "answer" | "action";
    expectedSkill?: string;
    requiredEvidence?: string[];
    requiredAnyEvidence?: string[];
    forbiddenOutputPatterns?: string[];
    forbidRawIds?: boolean;
    maxLatencyMs: number;
    tokenBudget: {
      maxInputTokens: number;
      maxOutputTokens: number;
    };
    maxRequestCount: number;
    /** Optional public runtime reasoning level. This is execution
     * configuration, not hidden truth. */
    thinkingLevel?: "high" | "max";
    /** Optional evaluator-owned public human action performed only after the
     * Agent run. It is never included in the SUT request body. */
    humanAction?: {
      action: "confirm" | "reject";
      proposalType: "clarify" | "plan" | "breakdown" | "replan";
      actorUserId: string;
      reason?: string;
    };
    /** T46-3 evaluator-only execution policy. The values are stable IDs;
     * raw controller facts remain outside the portable scenario contract. */
    v3?: {
      controllerId?: string;
      controllerMaxTurns?: number;
      skillContractId?: string;
      runtimeFaultId?: string;
      repeatGroupId?: string;
      repeatIndex?: number;
      /** T46-100 S4: evaluator-owned executable fixture contract ID.
       *  Fixtures are pre-seeded before SUT execution and verified via
       *  evidence snapshot. Fail-closed on missing/mismatch. */
      fixtureContractId?: string;
      /** T46-100 S7: SHA-256 over the full canonical FixtureContract
       *  payload (id, schemaVersion, description, steps, precondition).
       *  MUST match the registered FixtureContract at config time and
       *  before execution. Mismatch fails closed. */
      fixtureContractSha256?: string;
    };
  };
  /**
   * T46-2 (Issue #95): optional V2 hard grader block. When present, the
   * runner fetches an authenticated evidence snapshot and runs the
   * deterministic hard graders. V1 scenarios (no `hardGrader`) bypass V2
   * grading and retain Slice 0 behavior. The block's own `version` field
   * tracks hard-grader schema evolution independently from the artifact
   * schemaVersion above.
   */
  hardGrader?: import("./contract-v2.js").HardGraderContract;
  /**
   * Capability domain. Required for all scenarios post-T46 batch 2.
   * When absent, the scenario metadata map (`scenario-metadata.ts`)
   * provides the authoritative mapping. Must not be inferred from
   * scenarioId heuristics.
   */
  capabilityDomain?: import("./golden-core-contract.js").CapabilityDomain;
  /**
   * Scenario class. Required for all scenarios post-T46 batch 2.
   * When absent, the scenario metadata map (`scenario-metadata.ts`)
   * provides the authoritative mapping. Must not be inferred from
   * scenarioId heuristics.
   */
  scenarioClass?: import("./golden-core-contract.js").ScenarioClass;
}

export interface EvaluationBudget {
  maxSutCostUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequestCount: number;
  maxWallTimeMs: number;
  maxObservations: number;
}

export interface CodeFingerprint {
  gitCommit: string;
  gitDirty: boolean;
  worktreeSha256: string;
}

export interface EvaluationProvenance {
  evaluatorVersion: string;
  publicSeamVersion: "http-sse-v1";
  platform: string;
  architecture: string;
  nodeVersion: string;
  code: CodeFingerprint;
  scenarioContractsSha256: string;
  modelConfigSha256: string;
}

export interface RunManifest {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  runId: string;
  preset: string;
  model: string;
  createdAt: string;
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
  provenance: EvaluationProvenance;
  /** Commitments to evaluator-owned V3 inputs. Contains digests/IDs only. */
  v3?: {
    version: number;
    controllerFactsDigests: Record<string, import("./contract-v3.js").HiddenFactsDigests>;
    skillContractIds: string[];
    runtimeFaultIds: string[];
  };
}

export interface CostLedgerEntry {
  amountUsd: number | null;
  source: CostSource;
  countedAgainstSutCap: boolean;
}

export interface ScenarioObservation {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  scenarioId: string;
  timestamp: string;
  routedMode: "answer" | "action";
  selectedSkills: string[];
  evidence: string[];
  terminalStatus: "completed" | "failed" | "blocked";
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestCount: number;
  costs: {
    sutCost: CostLedgerEntry;
    evaluatorModelCost: CostLedgerEntry;
    codingAgentCost: CostLedgerEntry;
  };
  output: string;
  /**
   * T46-2: Run ID observed from the SSE `status` event. Propagated to the
   * evidence endpoint so run-scoped graders (trajectory_facts,
   * side_effect_facts, metric_facts, context_receipt_facts) receive
   * non-empty data. Absent when the public seam did not emit a `status`
   * event with `run_id` — run-scoped graders then see empty/null facts.
   */
  runId?: string;
  runtimeEvidence?: import("../scenario-eval.js").ScenarioObservation["runtimeEvidence"];
}

export interface Grade {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  scenarioId: string;
  passed: boolean;
  routingPassed: boolean;
  outcomePassed: boolean;
  latencyPassed: boolean;
  privacyPassed: boolean;
  budgetPassed: boolean;
  failures: string[];
  /**
   * T46-2 (Issue #95): optional hard grader payload. Present only when the
   * scenario contract declares a `hardGrader` block. When present, the
   * overall `passed` flag is the AND of the applicable Slice 0 gates and
   * the hard grade — a hard-gate failure cannot be offset by other dimensions.
   */
  hardGrade?: import("./contract-v2.js").HardGrade;
  /**
   * Additive audit evidence for runtime-fault scenarios. The top-level gate
   * booleans are the applicable composite verdicts after the declared fault
   * expectation is evaluated; `nominalGates` preserves the unadjusted Slice 0
   * verdicts so an expected fault cannot erase evidence. Older artifacts omit
   * this optional field, so this does not require an artifact schema bump.
   */
  runtimeFaultAdjustment?: {
    faultId: string;
    faultClass: import("./contract-v3.js").RuntimeFaultClass;
    nominalGates: {
      routingPassed: boolean;
      outcomePassed: boolean;
      latencyPassed: boolean;
      privacyPassed: boolean;
      budgetPassed: boolean;
    };
    faultOwnedDimensions: Array<"outcome" | "latency" | "budget">;
    notObservedDimensions: Array<"routing">;
  };
}

export interface IntegrityIndex {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  algorithm: "sha256";
  entries: Record<string, string>;
  evidenceRootSha256: string;
  reportSha256: string;
  integrityRootSha256: string;
}

export interface EvaluationArtifact {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  runId: string;
  preset: string;
  model: string;
  status: Exclude<EvaluationRunStatus, "running" | "infrastructure_error">;
  startedAt: string;
  completedAt: string;
  observations: ScenarioObservation[];
  grades: Grade[];
  summary: {
    passedCount: number;
    failedCount: number;
    passRate: number;
    sutCost: CostLedgerEntry;
    evaluatorModelCost: CostLedgerEntry;
    codingAgentCost: CostLedgerEntry;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalRequestCount: number;
    wallTimeMs: number;
  };
  provenance: EvaluationProvenance;
  evidenceRootSha256: string;
  integrityRootSha256?: string;
  artifactPaths: {
    runDirectory: string;
    manifest: string;
    report: string;
    integrity: string;
  };
  /** Additive T46-3 result graph. Absent for Slice 0/Issue #95 runs. */
  v3?: import("./contract-v3.js").EvaluationArtifactV3;
}

export interface EvaluationStatusRecord {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  runId: string;
  status: EvaluationRunStatus;
  completedScenarioIds: string[];
  updatedAt: string;
  message?: string;
}
