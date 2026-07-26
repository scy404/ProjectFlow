/**
 * T46 C1 (Issue #100) — Frozen pricing table for paid-model pre-call
 * worst-case estimation.
 *
 * DeepSeek prices frozen 2026-07-26 from:
 *   https://api-docs.deepseek.com/quick_start/pricing
 *
 * Version 1: deepseek-v4-flash, deepseek-v4-pro.
 *
 * §1 Invariants
 *  - fingerprint is sha256 over canonical table payload (version, frozenAt,
 *    sourceUrl, entries, currency, tokenUnit, rateSemantics).
 *  - entries are deep-frozen (sorted, stable JSON) — mutable refs forbidden.
 *  - Freshness: table older than 90 days is stale → fail-closed.
 *  - All worst-case estimates use cache-miss rates.
 *  - Unknown/stale/missing/tampered model → fail-closed.
 *
 * §2 Cost telemetry
 *  - All paid runs MUST use provider-reported cost (metrics.total_cost
 *    from SSE done event). Missing/malformed → fail-closed.
 *  - Lower-bound verification: if totalInputTokens > 0 or totalOutputTokens > 0,
 *    the reported cost MUST be ≥ the conservative floor of
 *    inputTokens * minRate + outputTokens * outputRate.
 *  - The pre-call worst-case is a GO/NOGO gate; runtime budget
 *    enforcement is a separate per-scenario guard.
 */

import { createHash } from "node:crypto";
import { EvaluationValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// §3 Types
// ---------------------------------------------------------------------------

export interface FrozenPriceEntry {
  /** Provider:name reference, e.g. "deepseek:deepseek-v4-flash". */
  readonly modelRef: string;
  /** Input price per million tokens (cache miss). */
  readonly inputCacheMissPerM: number;
  /** Output price per million tokens. */
  readonly outputPerM: number;
  /** Input price per million tokens (cache hit); absent if no discount. */
  readonly inputCacheHitPerM?: number;
  /** Context window in tokens. */
  readonly contextWindow: number;
  /** Max output tokens. */
  readonly maxOutput: number;
}

export interface FrozenPriceTable {
  readonly version: number;
  readonly frozenAt: string;
  readonly sourceUrl: string;
  readonly entries: readonly FrozenPriceEntry[];
  /** ISO 4217 currency code — always "USD" for V1. */
  readonly currency: "USD";
  /** Token unit: pricing denominator — always 1_000_000. */
  readonly tokenUnit: number;
  /** Rate semantics — always "per_million_tokens" for V1. */
  readonly rateSemantics: "per_million_tokens";
  /**
   * sha256 over the canonical table payload (all fields EXCEPT fingerprint
   * itself). Immutable; any change to version, frozenAt, sourceUrl, entries,
   * currency, tokenUnit, or rateSemantics changes the fingerprint.
   * NEVER recomputed at runtime from the same mutable source — the expected
   * fingerprint MUST be a hard-coded constant.
   */
  readonly fingerprint: string;
}

export interface WorstCaseEstimate {
  entry: FrozenPriceEntry;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  withinCap: boolean;
  cap: number;
  /** Human-readable per-model calculation for auditing. */
  calculation: string;
}

// ---------------------------------------------------------------------------
// §4 V1 — DeepSeek prices (2026-07-26)
// ---------------------------------------------------------------------------

const DEEPSEEK_V1_ENTRIES: readonly FrozenPriceEntry[] = [
  {
    modelRef: "deepseek:deepseek-v4-flash",
    inputCacheMissPerM: 0.14,
    inputCacheHitPerM: 0.0028,
    outputPerM: 0.28,
    contextWindow: 1_000_000,
    maxOutput: 384_000,
  },
  {
    modelRef: "deepseek:deepseek-v4-pro",
    inputCacheMissPerM: 0.435,
    inputCacheHitPerM: 0.003625,
    outputPerM: 0.87,
    contextWindow: 1_000_000,
    maxOutput: 384_000,
  },
];

/**
 * Expected fingerprint of {version,frozenAt,sourceUrl,entries,currency,tokenUnit,rateSemantics}.
 * This is a HARD-CODED constant computed once from the known V1 content.
 * Tests MUST assert recomputed fingerprint equals this constant.
 * NEVER compute from the same in-memory DEEPSEEK_PRICE_TABLE_V1 — always
 * recompute from DEEPSEEK_V1_ENTRIES + the fixed metadata separately.
 */
export const DEEPSEEK_PRICE_TABLE_V1_FINGERPRINT =
  "cf680a42337e312111f524ca03fb649247c88601222bc566efade6d5a848eb80";

// The V1 table — entries are read-only; fingerprint is hard-coded.
export const DEEPSEEK_PRICE_TABLE_V1: FrozenPriceTable = {
  version: 1,
  frozenAt: "2026-07-26T00:00:00.000Z",
  sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
  entries: DEEPSEEK_V1_ENTRIES,
  currency: "USD",
  tokenUnit: 1_000_000,
  rateSemantics: "per_million_tokens",
  fingerprint: DEEPSEEK_PRICE_TABLE_V1_FINGERPRINT,
};

Object.freeze(DEEPSEEK_PRICE_TABLE_V1);
Object.freeze(DEEPSEEK_PRICE_TABLE_V1.entries);
for (const e of DEEPSEEK_PRICE_TABLE_V1.entries) Object.freeze(e);

// ---------------------------------------------------------------------------
// §5 Fingerprint (immutable content check over FULL table payload)
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 fingerprint of a full FrozenPriceTable payload
 * (version, frozenAt, sourceUrl, entries, currency, tokenUnit, rateSemantics).
 * The fingerprint field itself is EXCLUDED from the payload.
 * The result is compared against a HARD-CODED constant — NEVER used
 * as the "expected" value when the same table is the source of truth.
 */
export function computePriceTableFingerprint(table: Omit<FrozenPriceTable, "fingerprint">): string {
  const canonicalEntries = table.entries
    .map((e) => ({
      modelRef: e.modelRef,
      inputCacheMissPerM: e.inputCacheMissPerM,
      ...(e.inputCacheHitPerM !== undefined ? { inputCacheHitPerM: e.inputCacheHitPerM } : {}),
      outputPerM: e.outputPerM,
      contextWindow: e.contextWindow,
      maxOutput: e.maxOutput,
    }))
    .sort((a, b) => a.modelRef.localeCompare(b.modelRef));
  const payload = {
    version: table.version,
    frozenAt: table.frozenAt,
    sourceUrl: table.sourceUrl,
    entries: canonicalEntries,
    currency: table.currency,
    tokenUnit: table.tokenUnit,
    rateSemantics: table.rateSemantics,
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/**
 * Export raw entries for tests that verify the fingerprint against the
 * exact canonical content — any change to rates, modelRef, or structure
 * must be detected.
 */
export function getDeepSeekV1CanonicalEntries(): ReadonlyArray<FrozenPriceEntry> {
  return DEEPSEEK_V1_ENTRIES;
}

// ---------------------------------------------------------------------------
// §6 Freshness policy (Issue #100 C1 §4)
// ---------------------------------------------------------------------------

/** Maximum age of a frozen price table before it is considered stale. */
export const PRICE_TABLE_MAX_AGE_DAYS = 90;

export function isPriceTableStale(
  table: FrozenPriceTable,
  now: Date = new Date(),
): boolean {
  const frozenDate = new Date(table.frozenAt);
  if (isNaN(frozenDate.getTime())) return true; // unparseable date → stale
  const ageDays =
    (now.getTime() - frozenDate.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > PRICE_TABLE_MAX_AGE_DAYS;
}

// ---------------------------------------------------------------------------
// §7 Table lookup
// ---------------------------------------------------------------------------

export function findPriceEntry(
  table: FrozenPriceTable,
  modelRef: string,
): FrozenPriceEntry | undefined {
  // Verify fingerprint first — tampered content is indistinguishable
  // from missing model. Recompute from the table's metadata + entries,
  // compare against the table's declared fingerprint.
  const recomputed = computePriceTableFingerprint(table);
  if (recomputed !== table.fingerprint) {
    throw new EvaluationValidationError(
      "价格表 fingerprint 不匹配; 拒绝将篡改表误分类为缺少模型",
    );
  }
  return table.entries.find((e) => e.modelRef === modelRef);
}

// ---------------------------------------------------------------------------
// §8 Worst-case cost estimation (cache miss, per §3)
// ---------------------------------------------------------------------------

export function computeWorstCaseCost(
  entry: FrozenPriceEntry,
  inputTokens: number,
  outputTokens: number,
  cap: number,
): WorstCaseEstimate {
  const inputCost = (inputTokens / 1_000_000) * entry.inputCacheMissPerM;
  const outputCost = (outputTokens / 1_000_000) * entry.outputPerM;
  const totalCost = inputCost + outputCost;
  const calculation =
    `(${inputTokens.toLocaleString()}/1M × $${entry.inputCacheMissPerM})` +
    ` + (${outputTokens.toLocaleString()}/1M × $${entry.outputPerM})` +
    ` = $${inputCost.toFixed(5)} + $${outputCost.toFixed(5)}` +
    ` = $${totalCost.toFixed(5)} (cap $${cap.toFixed(2)})`;
  return {
    entry,
    inputCost,
    outputCost,
    totalCost,
    inputTokens,
    outputTokens,
    withinCap: totalCost <= cap,
    cap,
    calculation,
  };
}

// ---------------------------------------------------------------------------
// §9 Known provider → price table mapping
// ---------------------------------------------------------------------------

export const KNOWN_PRICE_TABLES: Readonly<Record<string, FrozenPriceTable>> = Object.freeze({
  deepseek: DEEPSEEK_PRICE_TABLE_V1,
});

/** All price tables in this version. Tests iterate over this to verify
 *  fingerprint immutability for ALL known tables. */
export const ALL_PRICE_TABLES: readonly FrozenPriceTable[] = Object.freeze([
  DEEPSEEK_PRICE_TABLE_V1,
]);

// ---------------------------------------------------------------------------
// §10 Cost telemetry verification (post-run)
// ---------------------------------------------------------------------------

import type { CostLedgerEntry } from "./contract.js";

/**
 * Verify that the SUT cost for a paid model run came from real provider
 * telemetry AND is >= a conservative lower bound computed from the
 * entry's minimum rates and the actual token usage.
 *
 * Lower bound: inputTokens * minInputRate + outputTokens * outputRate.
 * minInputRate = entry.inputCacheHitPerM ?? entry.inputCacheMissPerM
 * (use cache-hit if available, otherwise cache-miss).
 *
 * Fail-closed on: non-provider_reported, null, NaN, negative, < lower bound.
 */
export function verifyPaidCostTelemetry(
  sutCost: CostLedgerEntry,
  entry: FrozenPriceEntry,
  totalInputTokens: number,
  totalOutputTokens: number,
): { verified: boolean; failureReason: string } {
  if (sutCost.source !== "provider_reported") {
    return {
      verified: false,
      failureReason:
        `paid model ${entry.modelRef}: cost telemetry source=${sutCost.source}, ` +
        `expected provider_reported`,
    };
  }
  if (sutCost.amountUsd === null || !Number.isFinite(sutCost.amountUsd) || sutCost.amountUsd < 0) {
    return {
      verified: false,
      failureReason:
        `paid model ${entry.modelRef}: amountUsd=${sutCost.amountUsd}, ` +
        `expected finite non-negative provider_reported cost`,
    };
  }
  // Lower-bound check: if ANY tokens were consumed, cost must exceed
  // the marginal lower bound (generous: cache-hit if available).
  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    const minInputRate = entry.inputCacheHitPerM ?? entry.inputCacheMissPerM;
    const lowerBound =
      (totalInputTokens / 1_000_000) * minInputRate +
      (totalOutputTokens / 1_000_000) * entry.outputPerM;
    // 0.5% floating-point tolerance: lowerBound ≤ 1e-8 → skip comparison.
    const tolerance = Math.max(1e-8, lowerBound * 0.005);
    if (sutCost.amountUsd + tolerance < lowerBound) {
      return {
        verified: false,
        failureReason:
          `paid model ${entry.modelRef}: provider_reported cost $${sutCost.amountUsd.toFixed(8)} ` +
          `< conservative lower bound $${lowerBound.toFixed(8)} ` +
          `(input=${totalInputTokens}, output=${totalOutputTokens}, minInputRate=$${minInputRate}/M)`,
      };
    }
  }
  return { verified: true, failureReason: "" };
}
