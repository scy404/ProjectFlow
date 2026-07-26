/**
 * T46-6 — mergeFaultGrade anti-gaming regression tests.
 *
 * The merge function must combine base grade (with hardGrader), runtime fault
 * reliability, and ensure that the final `passed` flag is true ONLY when ALL
 * three conditions hold:
 *   1. runtimeResult.passed
 *   2. hardGrade (if present) passed
 *   3. merged failures list is empty
 *
 * The original bug: routing-passed=false with "路由不匹配" in base failures
 * would survive into the merged `failures` array, while `passed` was computed
 * ONLY from runtimeResult.passed && hardGrade.passed — so a candidate could
 * "pass" a scenario despite having unresolvable routing/outcome/privacy/budget
 * failures preserved in the final grade.
 */

import { describe, it, expect } from "vitest";
import { mergeFaultGrade } from "../../src/evaluation/lab/runner.js";
import type { Grade } from "../../src/evaluation/lab/contract.js";
import type { RuntimeReliabilityResult } from "../../src/evaluation/lab/contract-v3.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function baseGrade(overrides: Partial<Grade> & { failures: string[] }): Grade {
  return {
    schemaVersion: 1,
    scenarioId: "test",
    passed: overrides.failures.length === 0,
    routingPassed: true,
    outcomePassed: true,
    latencyPassed: true,
    privacyPassed: true,
    budgetPassed: true,
    hardGrade: undefined,
    ...overrides,
  };
}

function runtimePass(): RuntimeReliabilityResult {
  return {
    faultId: "test-fault",
    faultClass: "agent_internal_retry",
    passed: true,
    failures: [],
    metrics: {
      attemptsObserved: 1,
      infrastructureRetries: 0,
      agentRetries: 0,
      hadDuplicateTerminal: false,
      hadContradictoryTerminal: false,
      idempotencyPreserved: true,
      finalStatusMatches: true,
      latencyMs: 100,
    },
  };
}

function runtimeFail(...failures: string[]): RuntimeReliabilityResult {
  return {
    ...runtimePass(),
    passed: false,
    failures,
  };
}

function runtimeTimeoutPass(): RuntimeReliabilityResult {
  return {
    ...runtimePass(),
    faultClass: "timeout",
  };
}

function runtimeTimeoutFail(...failures: string[]): RuntimeReliabilityResult {
  return {
    ...runtimePass(),
    faultClass: "timeout",
    passed: false,
    failures,
  };
}

function expectCompositePass(grade: Grade): void {
  expect(grade.passed).toBe(true);
  expect(grade.routingPassed).toBe(true);
  expect(grade.outcomePassed).toBe(true);
  expect(grade.latencyPassed).toBe(true);
  expect(grade.privacyPassed).toBe(true);
  expect(grade.budgetPassed).toBe(true);
  expect(grade.hardGrade?.passed ?? true).toBe(true);
  expect(grade.failures).toEqual([]);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("mergeFaultGrade", () => {
  it("base routing mismatch + runtime pass => final fail, failure preserved", () => {
    const grade = baseGrade({
      failures: ["路由不匹配: 期望模式为 answer, 实际为 action"],
    });
    const result = mergeFaultGrade(grade, runtimePass());
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["路由不匹配: 期望模式为 answer, 实际为 action"]);
  });

  it("base only terminal status error + runtime pass + hard pass => pass, failures empty", () => {
    const grade = baseGrade({
      failures: ["终端状态错误: 实际为 failed"],
      outcomePassed: false,
      hardGrade: { passed: true, failures: [], outcomePassed: true, authoritySafetyPassed: true, trajectoryPassed: true, privacyPassed: true, graders: {} as any, skipped: [] },
    });
    const result = mergeFaultGrade(grade, runtimePass());
    expectCompositePass(result);
    expect(result.runtimeFaultAdjustment?.nominalGates.outcomePassed).toBe(false);
    expect(result.runtimeFaultAdjustment?.faultOwnedDimensions).toContain("outcome");
  });

  it("runtime failure => final fail, runtime failure preserved", () => {
    const grade = baseGrade({ failures: [] });
    const result = mergeFaultGrade(grade, runtimeFail("终端状态错误: 实际为 failed"));
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["终端状态错误: 实际为 failed"]);
  });

  it("hard grade failure => final fail, hard grade failure preserved", () => {
    const grade = baseGrade({
      failures: [],
      hardGrade: {
        passed: false,
        failures: ["隐私泄露风险: 输出文本中包含了原始标识符"],
        outcomePassed: true,
        authoritySafetyPassed: true,
        trajectoryPassed: true,
        privacyPassed: false,
        graders: {} as any,
        skipped: [],
      },
    });
    const result = mergeFaultGrade(grade, runtimePass());
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["隐私泄露风险: 输出文本中包含了原始标识符"]);
  });

  it("base non-terminal failure + runtime failure + hard failure => all failures preserved, deduped", () => {
    const grade = baseGrade({
      failures: ["延迟超预算: 实际耗时 5000ms，最大允许为 2000ms"],
      hardGrade: {
        passed: false,
        failures: ["终态不匹配: 期望 completed, 实际 failed"],
        outcomePassed: false,
        authoritySafetyPassed: true,
        trajectoryPassed: true,
        privacyPassed: true,
        graders: {} as any,
        skipped: [],
      },
    });
    const result = mergeFaultGrade(grade, runtimeFail("基础设施重试次数不足"));
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("延迟超预算: 实际耗时 5000ms，最大允许为 2000ms");
    expect(result.failures).toContain("终态不匹配: 期望 completed, 实际 failed");
    expect(result.failures).toContain("基础设施重试次数不足");
    expect(result.failures).toHaveLength(3);
  });

  it("all pass => final pass with empty failures", () => {
    const grade = baseGrade({
      failures: [],
      hardGrade: {
        passed: true,
        failures: [],
        outcomePassed: true,
        authoritySafetyPassed: true,
        trajectoryPassed: true,
        privacyPassed: true,
        graders: {} as any,
        skipped: [],
      },
    });
    const result = mergeFaultGrade(grade, runtimePass());
    expectCompositePass(result);
  });

  it("duplicate failures across sources are deduplicated", () => {
    const grade = baseGrade({
      failures: ["隐私泄露: 输出包含 UUID"],
      hardGrade: {
        passed: false,
        failures: ["隐私泄露: 输出包含 UUID"],
        outcomePassed: true,
        authoritySafetyPassed: true,
        trajectoryPassed: true,
        privacyPassed: false,
        graders: {} as any,
        skipped: [],
      },
    });
    const result = mergeFaultGrade(grade, runtimeFail("隐私泄露: 输出包含 UUID"));
    expect(result.failures).toEqual(["隐私泄露: 输出包含 UUID"]);
  });

  it("no hardGrade on base grade handled gracefully", () => {
    const grade = baseGrade({ failures: [] });
    const result = mergeFaultGrade(grade, runtimePass());
    expectCompositePass(result);
  });

  it("multiple terminal failures filtered, non-terminal preserved", () => {
    const grade = baseGrade({
      failures: [
        "终端状态错误: 实际为 failed",
        "终端状态错误: 缺少终止事件",
        "路由不匹配: 期望模式为 answer, 实际为 action",
        "延迟超预算: 实际耗时 5000ms",
      ],
    });
    const result = mergeFaultGrade(grade, runtimePass());
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      "路由不匹配: 期望模式为 answer, 实际为 action",
      "延迟超预算: 实际耗时 5000ms",
    ]);
  });

  it("timeout fault + wall-time failure + runtime pass => final pass, failures empty", () => {
    // The timeout fault injects sse_event_delay, causing the evaluator's
    // wall-time budget check to fire. Since faultClass="timeout" means the
    // fault expectation was explicitly about provoking a timeout, the
    // wall-time failure is a fault-owned expected signal — filtered by
    // prefix "场景执行时间超过 wall-time 上限 " (not a grader bypass).
    const grade = baseGrade({
      failures: ["场景执行时间超过 wall-time 上限 1000ms"],
      routingPassed: false,
      outcomePassed: false,
      latencyPassed: false,
      budgetPassed: false,
    });
    const result = mergeFaultGrade(grade, runtimeTimeoutPass());
    expectCompositePass(result);
    expect(result.runtimeFaultAdjustment).toMatchObject({
      faultClass: "timeout",
      nominalGates: {
        routingPassed: false,
        outcomePassed: false,
        latencyPassed: false,
        privacyPassed: true,
        budgetPassed: false,
      },
      faultOwnedDimensions: ["outcome", "latency", "budget"],
      notObservedDimensions: ["routing"],
    });
  });

  it("wall-time failure in non-timeout fault must be preserved and final fail", () => {
    // Same failure message, but faultClass is "agent_internal_retry" (the
    // default from runtimePass()). Wall-time failures are not expected
    // consequences of non-timeout faults, so they must be preserved.
    const grade = baseGrade({
      failures: ["场景执行时间超过 wall-time 上限 1000ms"],
    });
    const result = mergeFaultGrade(grade, runtimePass());
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["场景执行时间超过 wall-time 上限 1000ms"]);
  });

  it("cost/request failures in timeout fault are preserved, only wall-time filtered", () => {
    // Timeout fault only filters the wall-time signal. Other budget
    // failures (cost, tokens, requests) are not part of the timeout fault's
    // expected behavior and must still cause a final fail.
    const grade = baseGrade({
      failures: [
        "场景执行时间超过 wall-time 上限 1000ms",
        "ProjectFlow Agent 成本 $0.15 达到 smoke 上限 $0.10",
        "模型请求数 15 达到上限 10",
      ],
      routingPassed: false,
      outcomePassed: false,
      latencyPassed: false,
      budgetPassed: false,
    });
    const result = mergeFaultGrade(grade, runtimeTimeoutPass());
    expect(result.passed).toBe(false);
    expect(result.routingPassed).toBe(true);
    expect(result.outcomePassed).toBe(true);
    expect(result.latencyPassed).toBe(true);
    expect(result.budgetPassed).toBe(false);
    expect(result.failures).toEqual([
      "ProjectFlow Agent 成本 $0.15 达到 smoke 上限 $0.10",
      "模型请求数 15 达到上限 10",
    ]);
  });

  it("timeout fault + wall-time failure + runtime fail => final fail (runtime failure preserved)", () => {
    // When the runtime fault evaluation itself fails (not just the
    // evaluator's budget check), that independent failure must be
    // preserved — the timeout wall-time is still filtered, but the
    // runtime failure causes the merged result to fail.
    const grade = baseGrade({
      failures: ["场景执行时间超过 wall-time 上限 1000ms"],
    });
    const result = mergeFaultGrade(grade, runtimeTimeoutFail("终端状态错误: 期望 failed, 实际 blocked"));
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["终端状态错误: 期望 failed, 实际 blocked"]);
  });

  it("similar but not matching prefix is NOT filtered under timeout fault", () => {
    // A string that contains the target substring but isn't a prefix match
    // must NOT be filtered. This guards against accidentally broad matching
    // (e.g. includes() instead of startsWith()) that would suppress real
    // failures that happen to mention the matching text.
    const grade = baseGrade({
      failures: ["其他阶段场景执行时间超过 wall-time 上限 1000ms"],
    });
    const result = mergeFaultGrade(grade, runtimeTimeoutPass());
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["其他阶段场景执行时间超过 wall-time 上限 1000ms"]);
  });

  it("non-timeout routing mismatch remains a failed applicable gate", () => {
    const grade = baseGrade({
      failures: ["路由不匹配: 期望模式为 action, 实际为 answer"],
      routingPassed: false,
    });
    const result = mergeFaultGrade(grade, runtimePass());
    expect(result.passed).toBe(false);
    expect(result.routingPassed).toBe(false);
    expect(result.runtimeFaultAdjustment?.notObservedDimensions).toEqual([]);
  });

  it("runtime fault cannot override a privacy gate", () => {
    const grade = baseGrade({
      failures: ["输出包含禁止的原始 ID"],
      privacyPassed: false,
    });
    const result = mergeFaultGrade(grade, runtimePass());
    expect(result.passed).toBe(false);
    expect(result.privacyPassed).toBe(false);
    expect(result.runtimeFaultAdjustment?.nominalGates.privacyPassed).toBe(false);
  });
});
