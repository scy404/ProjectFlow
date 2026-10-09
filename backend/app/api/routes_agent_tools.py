"""T41 Internal Agent Tools API Routes.

Provides the unified internal tool endpoint:
- POST /internal/agent-tools/{tool_name} — execute a ProjectFlow tool

Read-only tools dispatch to existing read services and return
side_effect_status=no_side_effect. Draft-only proposal tools create pending
AgentProposal rows and return side_effect_status=proposal_persisted without
committing Primary Project State.

These endpoints use service-to-service authentication (not browser cookies).
Service-token verification is a repo-wide hardening item tracked separately;
the existing /internal/agent-runs/* routes share the same gap.

Per-tool feature flags are controlled via Settings.feature_* bools so
individual tool endpoints can be cut over (or reverted) independently.
"""

from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.core.config import settings
from app.core.database import get_session
from app.core.security import require_internal_service_access
from app.models.enums import SideEffectStatus, ToolResultStatus
from app.schemas.runtime import ProjectFlowToolResult, ToolError, ToolExecutionRequest
from app.services.agent_tools_service import ToolNotFoundError, execute_agent_tool

router = APIRouter(
    prefix="/internal/agent-tools",
    tags=["agent-tools"],
    dependencies=[Depends(require_internal_service_access)],
)

# All known tool endpoint names (actual availability determined by feature flags).
ALL_AGENT_TOOLS = {
    "workspace-state",
    "conversation",
    "pending-proposals",
    "timeline-slice",
    "stage-plan-proposal",
    "checkins-and-risks-analysis",
    "replan-proposal",
    "assignment-recommendation",
    "create-risk",
    "create-checkin",
    "direction-card-proposal",
    "task-breakdown-proposal",
    "retrospective",
}


def _active_agent_tools() -> frozenset[str]:
    """Return the enabled tool names per current Settings."""
    return frozenset(settings.enabled_agent_tools() & ALL_AGENT_TOOLS)


def _blocked_tool_result(
    *,
    code: str,
    message: str,
    request: ToolExecutionRequest,
) -> ProjectFlowToolResult:
    return ProjectFlowToolResult(
        status=ToolResultStatus.blocked,
        error=ToolError(code=code, reason=message, message=message),
        side_effect_status=SideEffectStatus.no_side_effect,
        idempotency_key=request.idempotency_key,
        observation=message,
    )


def _failed_tool_result(
    *,
    code: str,
    message: str,
    request: ToolExecutionRequest,
) -> ProjectFlowToolResult:
    return ProjectFlowToolResult(
        status=ToolResultStatus.failed,
        error=ToolError(code=code, reason=message, message=message),
        side_effect_status=SideEffectStatus.unknown,
        idempotency_key=request.idempotency_key,
        observation=message,
    )


@router.post("/{tool_name}", response_model=ProjectFlowToolResult)
def execute_tool(
    tool_name: str,
    request: ToolExecutionRequest,
    session: Session = Depends(get_session),
) -> ProjectFlowToolResult:
    """Execute a ProjectFlow tool via the unified internal contract.

    The sidecar submits one envelope (run_id, tool_call_id, arguments, trace, ...);
    FastAPI dispatches to the tool handler and returns a ProjectFlowToolResult.
    """
    if tool_name not in ALL_AGENT_TOOLS:
        return _blocked_tool_result(
            code="TOOL_NOT_FOUND",
            message=f"Tool not found: {tool_name}",
            request=request,
        )
    if tool_name not in _active_agent_tools():
        return _blocked_tool_result(
            code="POLICY_DENIED",
            message=f"Tool disabled by feature flag: {tool_name}",
            request=request,
        )

    try:
        return execute_agent_tool(session, request, dispatch_tool_name=tool_name)
    except ToolNotFoundError as exc:
        return _blocked_tool_result(
            code="TOOL_NOT_FOUND",
            message=str(exc),
            request=request,
        )
    except Exception as exc:
        return _failed_tool_result(
            code="TOOL_EXECUTION_FAILED",
            message=f"工具执行失败：{exc}",
            request=request,
        )
