/**
 * Evaluation fixture provisioner.
 *
 * Provisions an isolated observation fixture by:
 * 1. Seeding the demo state (POST /api/seed/demo)
 * 2. Fetching fresh workspace state (GET /api/workspaces/{id}/state)
 * 3. Creating a new conversation (POST /api/projects/{id}/agent-conversations)
 *
 * T46-100 S4: Also supports evaluator-owned fixture contract execution
 * (e.g., pre-seeding a pending replan proposal) via the internal evaluation
 * fixture API.
 *
 * Each call returns a fresh {@link PublicSeamIdentity} so that effectful
 * scenarios cannot collide across repetitions.
 *
 * Errors are redacted: only the operation name and HTTP status are included
 * in the thrown message. Response bodies, private IDs, and secrets are never logged.
 */

import type { PublicSeamIdentity } from "./http-public-seam-runner.js";
import type { FixtureContract } from "./lab/fixture-contracts.js";

export interface FixtureProvisionerConfig {
  backendBaseUrl: string;
  workspaceId: string;
  projectId: string;
  viewerUserId: string;
  adminToken?: string;
  fetchFn?: typeof fetch;
  evaluationNonce?: string;
  evaluationInstanceId?: string;
}

interface SeedDemoResponse {
  // Seed endpoint returns varying shapes; we only need success/failure.
}

interface WorkspaceStateResponse {
  workspace: Record<string, unknown>;
  // Additional fields may exist; we pass the entire response as workspace state.
}

interface ConversationResponse {
  id: string;
  // Additional fields may exist.
}

async function postJson<T>(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function getJson<T>(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetchFn(url, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * Provision a fresh observation fixture and return a new identity.
 *
 * Sequentially:
 * 1. POST {backendBaseUrl}/api/seed/demo — reset demo state
 * 2. GET {backendBaseUrl}/api/workspaces/{workspaceId}/state — fetch fresh state
 * 3. POST {backendBaseUrl}/api/projects/{projectId}/agent-conversations — create conversation
 *
 * @throws Error with redacted message containing only operation name + HTTP status.
 */
export async function provisionObservationFixture(
  config: FixtureProvisionerConfig,
): Promise<PublicSeamIdentity> {
  const fetchFn = config.fetchFn ?? fetch;
  const base = config.backendBaseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = config.adminToken
    ? { "X-ProjectFlow-Admin-Token": config.adminToken }
    : {};
  if (config.evaluationNonce) {
    headers["X-Evaluation-Nonce"] = config.evaluationNonce;
  }
  if (config.evaluationInstanceId) {
    headers["X-Evaluation-Instance-Id"] = config.evaluationInstanceId;
  }

  // Step 1: Seed demo state.
  try {
    await postJson<SeedDemoResponse>(fetchFn, `${base}/api/seed/demo`, {}, headers);
  } catch (err) {
    const status = err instanceof Error ? err.message : "未知错误";
    throw new Error(`重置并生成评测夹具失败: ${status}`);
  }

  // Step 2: Fetch fresh workspace state.
  let workspaceState: Record<string, unknown>;
  try {
    const stateResponse = await getJson<WorkspaceStateResponse>(
      fetchFn,
      `${base}/api/workspaces/${config.workspaceId}/state`,
      headers,
    );
    workspaceState = stateResponse as unknown as Record<string, unknown>;
  } catch (err) {
    const status = err instanceof Error ? err.message : "未知错误";
    throw new Error(`读取评测工作区状态失败: ${status}`);
  }

  // Step 3: Create a new conversation.
  let conversationId: string;
  try {
    const convResponse = await postJson<ConversationResponse>(
      fetchFn,
      `${base}/api/projects/${config.projectId}/agent-conversations`,
      { viewer_user_id: config.viewerUserId },
      headers,
    );
    conversationId = convResponse.id;
    if (typeof conversationId !== "string" || !conversationId) {
      throw new Error("HTTP 200 但响应缺少会话 ID");
    }
  } catch (err) {
    const status = err instanceof Error ? err.message : "未知错误";
    throw new Error(`创建评测会话失败: ${status}`);
  }

  return {
    conversationId,
    workspaceId: config.workspaceId,
    projectId: config.projectId,
    viewerUserId: config.viewerUserId,
    workspaceState,
  };
}

// ---------------------------------------------------------------------------
// T46-100 S4: Evaluator-owned fixture contract execution
// ---------------------------------------------------------------------------

export interface FixtureExecutionConfig {
  backendBaseUrl: string;
  internalServiceToken: string;
  evaluationNonce: string;
  evaluationInstanceId: string;
  fetchFn?: typeof fetch;
}

/**
 * Execute a fixture contract against the isolated backend.
 *
 * Each step in the fixture contract is executed sequentially through
 * the evaluation-only internal fixture API. Steps that fail or return
 * unexpected results cause the entire execution to fail-closed.
 *
 * @throws Error with redacted message on failure.
 */
export async function executeFixtureContract(
  config: FixtureExecutionConfig,
  contract: FixtureContract,
): Promise<void> {
  const fetchFn = config.fetchFn ?? fetch;
  const base = config.backendBaseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.internalServiceToken}`,
    "X-Evaluation-Nonce": config.evaluationNonce,
    "X-Evaluation-Instance-Id": config.evaluationInstanceId,
    "Content-Type": "application/json",
  };

  for (const step of contract.steps) {
    switch (step.operation) {
      case "pre_seed_pending_replan": {
        const response = await fetchFn(
          `${base}/internal/evaluation/fixture/seed-replan`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(step.params),
          },
        );
        if (!response.ok) {
          throw new Error(`评测夹具预置失败: HTTP ${response.status}`);
        }
        const body = (await response.json()) as { proposal_id?: string; status?: string };
        if (!body.proposal_id || body.status !== "pending") {
          throw new Error("评测夹具预置验证失败: 提案状态不符合预期");
        }
        break;
      }
      default:
        throw new Error(`未知的夹具操作: ${step.operation}`);
    }
  }
}