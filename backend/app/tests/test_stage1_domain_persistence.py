"""Stage 1 regression tests for project metadata and direction-card persistence."""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient


def _create_project(client: TestClient, *, project_template: str = "startup") -> dict[str, str]:
    owner = client.post("/api/users", json={"display_name": "阶段一负责人"}).json()
    workspace = client.post(
        "/api/workspaces",
        params={"owner_user_id": owner["id"]},
        json={"name": "阶段一工作区", "team_size": 4, "project_template": project_template},
    ).json()
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "方向卡持久化项目",
            "idea": "验证方向卡扩展字段和验证语义不会在确认后丢失",
            "deadline": (datetime.now(UTC).date() + timedelta(days=60)).isoformat(),
            "deliverables": "可运行原型",
            "created_by": owner["id"],
            "project_template": project_template,
        },
    ).json()
    return {"owner_id": owner["id"], "workspace_id": workspace["id"], "project_id": project["id"]}


def test_direction_card_extended_fields_survive_proposal_confirm_and_all_reads(client: TestClient) -> None:
    ids = _create_project(client)
    output = {
        "problem": "学生团队缺少持续验证",
        "users": "大学生创新创业团队",
        "value": "把假设转化为可执行验证任务",
        "deliverables": ["可运行原型"],
        "boundaries": ["验证任务仍属于 Task"],
        "risks": ["仅收集口头反馈"],
        "suggested_questions": ["首个高风险假设是什么？"],
        "source_summary": "基于项目想法、团队规模和创业项目模板",
        "assumptions": ["目标用户愿意描述协作阻塞"],
        "unknowns": ["用户是否会持续记录状态"],
        "mvp_boundary": {
            "must_have": ["方向卡"],
            "defer": ["高级分析"],
            "out_of_scope": ["独立实验系统"],
        },
        "decision_points": ["先验证使用频率还是付费意愿"],
        "validation_hypotheses": ["团队愿意每周提交一次项目状态"],
        "success_signals": ["连续两周存在真实状态更新"],
        "reason": "创业项目需要先明确可证伪假设",
        "requires_confirmation": True,
    }
    response = client.post(
        "/internal/agent-tools/direction-card-proposal",
        json={
            "run_id": "stage1-run",
            "conversation_id": "stage1-conversation",
            "workspace_id": ids["workspace_id"],
            "project_id": ids["project_id"],
            "tool_call_id": f"stage1-{uuid.uuid4()}",
            "tool_name": "generate_direction_card_proposal",
            "idempotency_key": f"stage1-{uuid.uuid4()}",
            "arguments": {"output": output},
        },
    )
    assert response.status_code == 200, response.text
    proposal_id = response.json()["links"]["proposal_id"]

    assert client.get(f"/api/projects/{ids['project_id']}").json()["direction_card"] is None
    proposal = client.get(f"/api/agent-proposals/{proposal_id}").json()
    assert proposal["payload"]["validation_hypotheses"] == output["validation_hypotheses"]
    assert proposal["payload"]["source_summary"] == output["source_summary"]

    confirmed = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": ids["owner_id"]},
    )
    assert confirmed.status_code == 200, confirmed.text

    expected = {key: value for key, value in output.items() if key != "requires_confirmation"}
    assert client.get(f"/api/projects/{ids['project_id']}").json()["direction_card"] == expected
    assert client.get(f"/api/projects/{ids['project_id']}/state").json()["project"]["direction_card"] == expected
    agent_state = client.get(
        f"/api/workspaces/{ids['workspace_id']}/state",
        params={"project_id": ids["project_id"]},
    ).json()
    assert agent_state["project"]["direction_card"] == expected


def test_historical_direction_card_without_optional_fields_remains_readable(client: TestClient) -> None:
    ids = _create_project(client, project_template="general")
    response = client.patch(
        f"/api/projects/{ids['project_id']}",
        json={
            "direction_card": {
                "problem": "旧方向卡",
                "users": "学生团队",
                "value": "保持兼容",
                "deliverables": ["原型"],
            }
        },
    )
    assert response.status_code == 200
    card = response.json()["direction_card"]
    assert card["problem"] == "旧方向卡"
    assert card["boundaries"] == []
    assert "validation_hypotheses" not in card
    assert "success_signals" not in card


def test_historical_direction_card_preserves_scalar_mvp_boundary_values(client: TestClient) -> None:
    ids = _create_project(client, project_template="general")
    response = client.patch(
        f"/api/projects/{ids['project_id']}",
        json={
            "direction_card": {
                "problem": "旧数据兼容",
                "users": "学生团队",
                "value": "避免已保存边界消失",
                "mvp_boundary": {
                    "must_have": "核心演示闭环",
                    "defer": "外部平台集成",
                    "out_of_scope": "多 Agent Runtime",
                },
            }
        },
    )

    assert response.status_code == 200
    assert response.json()["direction_card"]["mvp_boundary"] == {
        "must_have": ["核心演示闭环"],
        "defer": ["外部平台集成"],
        "out_of_scope": ["多 Agent Runtime"],
    }
