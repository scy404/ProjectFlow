/**
 * T46-7 (Issue #100 §3.2) — Loopback-only local read-only viewer.
 *
 * The SECOND presentation surface. Consumes the SAME verified
 * immutable result graph as the showcase bundle, but renders it as
 * an HTML/JSON HTTP response on the local machine.
 *
 * Boundary invariants (Issue #100 §3.2):
 *  - MUST only bind to 127.0.0.1 or ::1. NEVER to LAN or public IPs.
 *  - MUST be read-only. No run, cancel, reset, promotion, repair
 *    mutation or any write operation.
 *  - MUST NOT expose mutation paths via hidden API, query parameters
 *    or static page scripts.
 *  - CLI and the repository-local Agent Skill remain the ONLY control
 *    plane.
 *  - Verdicts, counts and costs MUST be byte-for-byte identical to
 *    the portable bundle for the same artifact.
 *  - Private drill-down may read local-only evidence (e.g., raw
 *    observations) but MUST NOT bring raw private artifacts into the
 *    portable bundle.
 *
 * Implementation uses Node's built-in `http` module — no Express, no
 * extra dependencies. The viewer is a single-file server that can be
 * started from the CLI and stopped with Ctrl+C.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import {
  type VerifiedArtifact,
} from "./schema-migration.js";
import {
  buildShowcaseBundleInMemory,
  SHOWCASE_BUNDLE_SCHEMA_VERSION,
  type BundleSourceArtifact,
  type BundleReleaseVerdict,
  type BundleHardGates,
  type BundleCostBucket,
} from "./showcase-bundle.js";
import type { EvaluationArtifact, Grade, ScenarioObservation } from "./contract.js";

// ---------------------------------------------------------------------------
// §1 Constants
// ---------------------------------------------------------------------------

export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
export const DEFAULT_VIEWER_PORT = 0; // 0 = ephemeral port assigned by OS
export const VIEWER_CONTENT_TYPE_JSON = "application/json; charset=utf-8";
export const VIEWER_CONTENT_TYPE_HTML = "text/html; charset=utf-8";

// Methods allowed by the viewer. POST/PUT/DELETE/PATCH are rejected
// with 405 Method Not Allowed. Issue #100 §3.2: "MUST NOT provide
// run, cancel, reset, promotion, repair mutation or any write
// operation".
const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ---------------------------------------------------------------------------
// §2 Viewer response shapes
// ---------------------------------------------------------------------------

/** Top-level viewer payload — mirrors the showcase bundle structure
 *  but adds local-only drill-down sections. Issue #100 §3.2: "viewer
 *  与 portable bundle 对同一 artifact 的 verdict、计数和成本必须完全一致". */
export interface ViewerPayload {
  schemaVersion: typeof SHOWCASE_BUNDLE_SCHEMA_VERSION;
  viewerType: "loopback_read_only";
  evidenceClass: "offline_synthetic";
  generatedAt: string;
  sourceArtifact: BundleSourceArtifact;
  releaseVerdict: BundleReleaseVerdict;
  hardGates: BundleHardGates;
  costs: {
    sutCost: BundleCostBucket;
    evaluatorModelCost: BundleCostBucket;
    codingAgentCost: BundleCostBucket;
    provenanceNote: string;
  };
  // Local-only drill-down. Issue #100 §3.2: "private drill-down 只能读取
  // 本地允许的证据, 不能把 raw private artifact 带入 portable bundle".
  // These fields are NOT in the portable bundle. They are rendered
  // only when the viewer is running on the local machine.
  localDrillDown: {
    runId: string;
    runDir: string;
    observationCount: number;
    gradeCount: number;
    observations: Array<{
      scenarioId: string;
      terminalStatus: string;
      latencyMs: number;
      requestCount: number;
      inputTokens: number;
      outputTokens: number;
      // The full output text is local-only — never enters the portable
      // bundle. Issue #100 §3.1: "不得包含 raw traces, private text".
      outputPreview: string;
      evidence: string[];
    }>;
    grades: Array<{
      scenarioId: string;
      passed: boolean;
      failures: string[];
    }>;
  };
  // The portable bundle fingerprint, computed identically to the
  // showcase bundle. Issue #100 §3.2: "viewer 与 portable bundle 对
  // 同一 artifact 的 verdict、计数和成本必须完全一致".
  portableBundleFingerprint: string;
  // Read-only notice.
  readOnlyNotice: string;
}

// ---------------------------------------------------------------------------
// §3 Viewer server
// ---------------------------------------------------------------------------

export interface ViewerOptions {
  /** The verified artifact to render. */
  verified: VerifiedArtifact;
  /** Project root (for reading auxiliary artifacts when needed). */
  projectRoot: string;
  /** Port to bind. 0 = ephemeral. */
  port?: number;
  /** Host to bind. MUST be 127.0.0.1 or ::1. */
  host?: "127.0.0.1" | "::1";
  /** Optional ISO timestamp. Defaults to now(). */
  now?: () => string;
  /**
   * Optional pseudonym salt. When omitted, a fresh random salt is
   * generated. Tests that need byte-for-byte parity with a portable
   * bundle built via {@link buildShowcaseBundleInMemory} should pass
   * the SAME salt to both builders. Issue #100 §3.2: "viewer 与
   * portable bundle 对同一 artifact 的 verdict、计数和成本必须完全
   * 一致" — sharing the salt guarantees the pseudonyms also match.
   */
  salt?: Buffer;
  /** Optional shutdown signal (for tests). */
  shutdownSignal?: AbortSignal;
}

export interface ViewerHandle {
  /** The started server. */
  server: Server;
  /** The actual port the server is listening on. */
  port: number;
  /** The host the server is bound to. */
  host: string;
  /** The full URL to reach the viewer. */
  url: string;
  /** Stop the server. */
  close: () => Promise<void>;
}

/**
 * Start the loopback-only local viewer. Issue #100 §3.2: "只能绑定
 * 127.0.0.1 / ::1, 不能对 LAN 或公网监听".
 *
 * The viewer is read-only. All routes are GET/HEAD/OPTIONS only.
 * POST/PUT/DELETE/PATCH return 405. There are no mutation routes,
 * no hidden API, no query parameters that trigger writes.
 */
export async function startLocalViewer(options: ViewerOptions): Promise<ViewerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new EvaluationValidationError(`viewer 拒绝绑定非 loopback 主机: ${host}`);
  }
  const port = options.port ?? DEFAULT_VIEWER_PORT;
  const verified = options.verified;
  const now = options.now ?? (() => new Date().toISOString());
  const generatedAt = now();

  // §3.1 Build the portable bundle IN MEMORY (NOT written to disk).
  // The bundle is used to compute the fingerprint that proves the
  // viewer and the portable bundle render the SAME artifact. The
  // local viewer NEVER publishes a bundle to disk — that is the
  // CLI's job. When the caller supplies a `salt`, we reuse it so
  // the viewer's pseudonyms match a previously-published portable
  // bundle byte-for-byte. Issue #100 §3.2 parity requirement. We
  // capture the resolved salt so the /bundle route can reuse it.
  const { bundle, bundleSha256, salt: optionsSalt } = await buildShowcaseBundleInMemory({
    verified,
    projectRoot: options.projectRoot,
    now: options.now,
    salt: options.salt,
  });
  void bundleSha256; // the bundle object itself carries integritySha256
  // The portable bundle fingerprint is the in-memory bundle's
  // integritySha256. The viewer exposes it so consumers can verify
  // the viewer and a committed bundle render the same artifact.
  const portableBundleFingerprint = bundle.integritySha256;

  // §3.2 Build the local drill-down (full observations and grades).
  const localDrillDown = buildLocalDrillDown(verified.artifact);

  // §3.3 Build the viewer payload.
  const payload: ViewerPayload = {
    schemaVersion: SHOWCASE_BUNDLE_SCHEMA_VERSION,
    viewerType: "loopback_read_only",
    evidenceClass: "offline_synthetic",
    generatedAt,
    sourceArtifact: bundle.sourceArtifact,
    releaseVerdict: bundle.releaseVerdict,
    hardGates: bundle.hardGates,
    costs: bundle.costs,
    localDrillDown,
    portableBundleFingerprint,
    readOnlyNotice: "本 viewer 为只读; 不存在 run/cancel/reset/promotion/repair 等 mutation 路由; CLI 是唯一控制面",
  };

  // §3.4 Create the server. Routes:
  //  - GET /           → HTML overview
  //  - GET /api/viewer → JSON payload (the ViewerPayload above)
  //  - GET /health     → {"status":"ok"} (for tests)
  //  - GET /artifact   → the raw verified artifact JSON (local-only)
  //  - GET /bundle     → the portable bundle JSON (same as committed)
  //  Any other path → 404. Any method other than GET/HEAD/OPTIONS → 405.
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, payload, verified, options.projectRoot, generatedAt, optionsSalt);
    } catch (error) {
      handleError(res, error);
    }
  });

  // §3.5 Bind to loopback only. The `host` argument MUST be 127.0.0.1
  // or ::1 — Node will not bind to 0.0.0.0 or any LAN IP.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new EvaluationInfrastructureError("viewer 无法获取监听地址");
  }
  const actualPort = address.port;
  const url = `http://${host === "::1" ? "[::1]" : host}:${actualPort}/`;

  const handle: ViewerHandle = {
    server,
    port: actualPort,
    host,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };

  // §3.6 Optional shutdown signal (for tests).
  if (options.shutdownSignal) {
    options.shutdownSignal.addEventListener("abort", () => {
      handle.close().catch(() => undefined);
    }, { once: true });
  }

  return handle;
}

// ---------------------------------------------------------------------------
// §4 Request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  payload: ViewerPayload,
  verified: VerifiedArtifact,
  _projectRoot: string,
  _generatedAt: string,
  optionsSalt?: Buffer,
): Promise<void> {
  // §4.1 Method check.
  if (!ALLOWED_METHODS.has(req.method ?? "")) {
    res.writeHead(405, { "Content-Type": VIEWER_CONTENT_TYPE_JSON, "Allow": "GET, HEAD, OPTIONS" });
    res.end(JSON.stringify({ error: "method_not_allowed", message: `方法 ${req.method} 不允许; viewer 为只读` }));
    return;
  }
  // §4.2 OPTIONS — return allowed methods.
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Allow": "GET, HEAD, OPTIONS" });
    res.end();
    return;
  }
  // §4.3 Route by path. We intentionally do NOT support query
  // parameters that could trigger writes (e.g., ?action=run). The
  // viewer is pure GET.
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  // §4.4 Reject any query parameter that looks like a mutation
  // attempt. Issue #100 §3.2: "MUST NOT expose mutation paths via
  // hidden API, query parameters or static page scripts".
  for (const key of url.searchParams.keys()) {
    if (isMutationQueryParam(key)) {
      res.writeHead(400, { "Content-Type": VIEWER_CONTENT_TYPE_JSON });
      res.end(JSON.stringify({ error: "mutation_query_rejected", message: `查询参数 ${key} 疑似 mutation; viewer 为只读` }));
      return;
    }
  }
  // §4.5 HEAD requests return headers only.
  const isHead = req.method === "HEAD";
  if (path === "/" || path === "/index.html") {
    const html = renderHtmlOverview(payload);
    res.writeHead(200, { "Content-Type": VIEWER_CONTENT_TYPE_HTML, "Content-Length": Buffer.byteLength(html) });
    if (isHead) { res.end(); return; }
    res.end(html);
    return;
  }
  if (path === "/api/viewer") {
    const json = JSON.stringify(payload, null, 2);
    res.writeHead(200, { "Content-Type": VIEWER_CONTENT_TYPE_JSON, "Content-Length": Buffer.byteLength(json) });
    if (isHead) { res.end(); return; }
    res.end(json);
    return;
  }
  if (path === "/health") {
    const body = JSON.stringify({ status: "ok", viewer: "loopback_read_only" });
    res.writeHead(200, { "Content-Type": VIEWER_CONTENT_TYPE_JSON, "Content-Length": Buffer.byteLength(body) });
    if (isHead) { res.end(); return; }
    res.end(body);
    return;
  }
  if (path === "/artifact") {
    // Local-only: the raw verified artifact JSON.
    const body = JSON.stringify(verified.artifact, null, 2);
    res.writeHead(200, { "Content-Type": VIEWER_CONTENT_TYPE_JSON, "Content-Length": Buffer.byteLength(body) });
    if (isHead) { res.end(); return; }
    res.end(body);
    return;
  }
  if (path === "/bundle") {
    // Re-build the portable bundle IN MEMORY and return its JSON.
    // This route exists so consumers can verify the viewer and the
    // bundle produce identical fingerprints. The viewer NEVER writes
    // to disk — Issue #100 §3.2: "MUST NOT provide ... any write
    // operation". We pass the SAME salt captured at startup so the
    // /bundle route returns byte-for-byte identical output to the
    // initial in-memory bundle (and to any portable bundle built
    // with the same salt).
    const { bundle: inMemoryBundle } = await buildShowcaseBundleInMemory({
      verified,
      projectRoot: _projectRoot,
      now: () => payload.generatedAt,
      salt: optionsSalt,
    });
    const body = JSON.stringify(inMemoryBundle, null, 2);
    res.writeHead(200, { "Content-Type": VIEWER_CONTENT_TYPE_JSON, "Content-Length": Buffer.byteLength(body) });
    if (isHead) { res.end(); return; }
    res.end(body);
    return;
  }
  // §4.6 Unknown path → 404.
  res.writeHead(404, { "Content-Type": VIEWER_CONTENT_TYPE_JSON });
  if (isHead) { res.end(); return; }
  res.end(JSON.stringify({ error: "not_found", path, message: "viewer 路由不存在" }));
}

function isMutationQueryParam(key: string): boolean {
  const lower = key.toLowerCase();
  return ["action", "run", "cancel", "reset", "promote", "repair", "delete", "write", "mutate", "execute", "start", "stop", "commit"].includes(lower);
}

function handleError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof EvaluationValidationError ? 400 : 500;
  res.writeHead(status, { "Content-Type": VIEWER_CONTENT_TYPE_JSON });
  res.end(JSON.stringify({ error: status === 400 ? "validation_error" : "internal_error", message }));
}

// ---------------------------------------------------------------------------
// §5 Local drill-down builder
// ---------------------------------------------------------------------------

function buildLocalDrillDown(artifact: EvaluationArtifact): ViewerPayload["localDrillDown"] {
  const observations = artifact.observations.map((obs: ScenarioObservation) => ({
    scenarioId: obs.scenarioId,
    terminalStatus: obs.terminalStatus,
    latencyMs: obs.latencyMs,
    requestCount: obs.requestCount,
    inputTokens: obs.inputTokens,
    outputTokens: obs.outputTokens,
    // Issue #100 §3.2: "private drill-down 只能读取本地允许的证据, 不能
    // 把 raw private artifact 带入 portable bundle". The full output is
    // local-only. We expose it here for local debugging but it never
    // enters the portable bundle.
    outputPreview: obs.output.slice(0, 500),
    evidence: obs.evidence,
  }));
  const grades = artifact.grades.map((g: Grade) => ({
    scenarioId: g.scenarioId,
    passed: g.passed,
    failures: g.failures,
  }));
  return {
    runId: artifact.runId,
    runDir: artifact.artifactPaths.runDirectory,
    observationCount: observations.length,
    gradeCount: grades.length,
    observations,
    grades,
  };
}

// ---------------------------------------------------------------------------
// §6 HTML rendering
// ---------------------------------------------------------------------------

function renderHtmlOverview(payload: ViewerPayload): string {
  const escape = (s: string) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const v = payload.releaseVerdict;
  const s = payload.sourceArtifact;
  const c = payload.costs;
  const h = payload.hardGates;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ProjectFlow Evaluation Lab — Local Viewer</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.5rem; }
    h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #eee; padding-bottom: 0.25rem; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
    .badge-read-only { background: #fef3c7; color: #92400e; }
    .badge-offline { background: #e0e7ff; color: #3730a3; }
    .verdict-passed { color: #166534; }
    .verdict-regression { color: #991b1b; }
    .verdict-partial { color: #92400e; }
    table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #f0f0f0; font-size: 0.9rem; }
    th { background: #fafafa; font-weight: 600; }
    code { background: #f5f5f5; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
    .notice { background: #fffbeb; border: 1px solid #fcd34d; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>ProjectFlow Evaluation Lab — Local Viewer</h1>
  <p>
    <span class="badge badge-read-only">READ-ONLY</span>
    <span class="badge badge-offline">offline/synthetic</span>
  </p>
  <p class="notice">${escape(payload.readOnlyNotice)}</p>

  <h2>Release Verdict</h2>
  <p>
    <strong class="verdict-${v.verdict === "passed" ? "passed" : v.verdict === "regression" ? "regression" : "partial"}">${escape(v.verdict)}</strong>
    — 诚实基线: <code>${escape(v.honestBaseline)}</code>
  </p>
  <p>${escape(v.summary)}</p>
  <ul>
    ${v.forbiddenClaims.map((c) => `<li>${escape(c)}</li>`).join("\n    ")}
  </ul>

  <h2>Source Artifact</h2>
  <table>
    <tr><th>Run ID (pseudonym)</th><td><code>${escape(s.runIdPseudonym)}</code></td></tr>
    <tr><th>Preset</th><td>${escape(s.preset)}</td></tr>
    <tr><th>Model</th><td>${escape(s.model)}</td></tr>
    <tr><th>Status</th><td>${escape(s.status)}</td></tr>
    <tr><th>Started</th><td>${escape(s.startedAt)}</td></tr>
    <tr><th>Completed</th><td>${escape(s.completedAt)}</td></tr>
    <tr><th>Integrity Root SHA-256</th><td><code>${escape(s.integrityRootSha256)}</code></td></tr>
    <tr><th>Artifact Fingerprint</th><td><code>${escape(s.artifactFingerprint)}</code></td></tr>
  </table>

  <h2>Hard Gates</h2>
  <table>
    <tr><th>Gate</th><th>Passed</th></tr>
    <tr><td>P0 mutations detected</td><td>${h.p0MutationsDetected ? "✅" : "❌"}</td></tr>
    <tr><td>Reference zero hard false failures</td><td>${h.referenceZeroHardFalseFailures ? "✅" : "❌"}</td></tr>
    <tr><td>Hidden field leakage tests pass</td><td>${h.hiddenFieldLeakageTestsPass ? "✅" : "❌"}</td></tr>
    <tr><td>Required scenarios not skipped/excluded</td><td>${h.requiredScenariosNotSkippedOrExcluded ? "✅" : "❌"}</td></tr>
    <tr><td>Evidence graph and checksums complete</td><td>${h.evidenceGraphAndChecksumsComplete ? "✅" : "❌"}</td></tr>
    <tr><td>No semantic judge required</td><td>${h.noSemanticJudgeRequired ? "✅" : "❌"}</td></tr>
  </table>

  <h2>Costs</h2>
  <table>
    <tr><th>Bucket</th><th>Amount (USD)</th><th>Source</th><th>Counts Against SUT Cap</th></tr>
    <tr><td>SUT</td><td>${c.sutCost.amountUsd === null ? "unknown" : `$${c.sutCost.amountUsd.toFixed(4)}`}</td><td>${escape(c.sutCost.source)}</td><td>${c.sutCost.countedAgainstSutCap ? "yes" : "no"}</td></tr>
    <tr><td>Evaluator Model</td><td>${c.evaluatorModelCost.amountUsd === null ? "unknown" : `$${c.evaluatorModelCost.amountUsd.toFixed(4)}`}</td><td>${escape(c.evaluatorModelCost.source)}</td><td>${c.evaluatorModelCost.countedAgainstSutCap ? "yes" : "no"}</td></tr>
    <tr><td>Coding Agent</td><td>${c.codingAgentCost.amountUsd === null ? "unknown" : `$${c.codingAgentCost.amountUsd.toFixed(4)}`}</td><td>${escape(c.codingAgentCost.source)}</td><td>${c.codingAgentCost.countedAgainstSutCap ? "yes" : "no"}</td></tr>
  </table>
  <p><em>${escape(c.provenanceNote)}</em></p>

  <h2>Local Drill-Down</h2>
  <p>Run ID: <code>${escape(payload.localDrillDown.runId)}</code></p>
  <p>Observations: ${payload.localDrillDown.observationCount} · Grades: ${payload.localDrillDown.gradeCount}</p>
  <table>
    <tr><th>Scenario ID</th><th>Terminal</th><th>Latency (ms)</th><th>Requests</th><th>Input Tokens</th><th>Output Tokens</th><th>Grade</th></tr>
    ${(() => {
      // Build a Map keyed by scenarioId so the grade lookup does NOT
      // depend on observations and grades being in the same order or
      // 1:1. Issue #100 §3.2: the viewer must render the same verdict
      // as the portable bundle — index-based lookup would silently
      // show the wrong grade if the orders ever diverged.
      const gradeMap = new Map<string, { scenarioId: string; passed: boolean; failures: string[] }>();
      for (const g of payload.localDrillDown.grades) gradeMap.set(g.scenarioId, g);
      return payload.localDrillDown.observations.map((obs) => {
        const grade = gradeMap.get(obs.scenarioId);
        return `<tr><td>${escape(obs.scenarioId)}</td><td>${escape(obs.terminalStatus)}</td><td>${obs.latencyMs}</td><td>${obs.requestCount}</td><td>${obs.inputTokens}</td><td>${obs.outputTokens}</td><td>${grade?.passed ? "✅" : "❌"}</td></tr>`;
      }).join("\n    ");
    })()}
  </table>

  <h2>Portable Bundle Fingerprint</h2>
  <p><code>${escape(payload.portableBundleFingerprint)}</code></p>
  <p>此指纹与 <code>scripts/eval-lab showcase export</code> 生成的 portable bundle 指纹完全一致。</p>

  <h2>Routes</h2>
  <ul>
    <li><code>GET /</code> — 此 HTML 概览</li>
    <li><code>GET /api/viewer</code> — JSON payload</li>
    <li><code>GET /health</code> — 健康检查</li>
    <li><code>GET /artifact</code> — 原始 verified artifact JSON (本地)</li>
    <li><code>GET /bundle</code> — 重建的 portable bundle JSON</li>
  </ul>
</body>
</html>`;
}
