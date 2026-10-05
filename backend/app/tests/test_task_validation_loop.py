from datetime import date, timedelta

from fastapi.testclient import TestClient


def _project_graph(client: TestClient, suffix: str = "one") -> dict[str, str]:
    user = client.post(
        "/api/users",
        json={"display_name": f"Validator {suffix}", "email": f"validator-{suffix}@test.local"},
    ).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": f"Validation workspace {suffix}"},
        params={"owner_user_id": user["id"]},
    ).json()
    project_deadline = date.today() + timedelta(days=60)
    project_response = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": f"Validation project {suffix}",
            "idea": "验证核心假设",
            "deadline": project_deadline.isoformat(),
            "deliverables": "可追溯验证记录",
            "created_by": user["id"],
            "project_template": "competition",
        },
    )
    assert project_response.status_code == 201, project_response.text
    project = project_response.json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "验证阶段",
            "goal": "验证需求",
            "start_date": (date.today() + timedelta(days=1)).isoformat(),
            "end_date": (date.today() + timedelta(days=30)).isoformat(),
            "deliverable": "验证结论",
        },
    ).json()
    return {
        "user_id": user["id"],
        "workspace_id": workspace["id"],
        "project_id": project["id"],
        "stage_id": stage["id"],
    }


def _create_task(client: TestClient, graph: dict[str, str], *, task_kind: str = "validation") -> dict:
    payload = {
        "project_id": graph["project_id"],
        "stage_id": graph["stage_id"],
        "title": "访谈目标用户",
        "description": "验证用户是否愿意采用方案",
        "priority": "P0",
        "due_date": (date.today() + timedelta(days=14)).isoformat(),
        "estimated_hours": 3,
        "task_kind": task_kind,
    }
    if task_kind == "validation":
        payload["validation_spec"] = {
            "hypothesis": "目标用户愿意持续使用",
            "method": "半结构化访谈",
            "success_criterion": "至少 6 人明确表达持续使用意愿",
            "sample_target": 8,
        }
    response = client.post("/api/tasks", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_validation_task_round_trips_spec_and_legacy_task_defaults_to_delivery(client: TestClient):
    graph = _project_graph(client)
    validation_task = _create_task(client, graph)
    delivery_task = _create_task(client, graph, task_kind="delivery")

    reloaded = client.get(f"/api/tasks/{validation_task['id']}").json()
    assert reloaded["task_kind"] == "validation"
    assert reloaded["validation_spec"]["sample_target"] == 8
    assert reloaded["validation_result"] is None
    assert delivery_task["task_kind"] == "delivery"
    assert delivery_task["validation_spec"] is None


def test_validation_result_is_server_attributed_persisted_and_logged(client: TestClient):
    graph = _project_graph(client)
    task = _create_task(client, graph)
    resource = client.post(
        "/api/resources",
        json={
            "project_id": graph["project_id"],
            "type": "text_note",
            "title": "访谈纪要",
            "content_text": "8 人中有 7 人愿意继续试用",
        },
    ).json()

    response = client.put(
        f"/api/tasks/{task['id']}/validation-result",
        params={"viewer_user_id": graph["user_id"]},
        json={
            "summary": "核心需求得到初步支持",
            "observed_value": "8 人中 7 人愿意继续试用",
            "decision": "validated",
            "evidence_resource_ids": [resource["id"], resource["id"]],
            "mark_complete": True,
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "done"
    assert result["validation_result"]["recorded_by"] == graph["user_id"]
    assert result["validation_result"]["recorded_at"]
    assert result["validation_result"]["evidence_resource_ids"] == [resource["id"]]

    reloaded = client.get(f"/api/tasks/{task['id']}").json()
    assert reloaded["validation_result"] == result["validation_result"]
    timeline = client.get(f"/api/projects/{graph['project_id']}/timeline").json()
    validation_event = next(event for event in timeline if event["event_type"] == "validation")
    assert validation_event["output_snapshot"]["plan_changed"] is False
    assert validation_event["user_confirmed"] is True


def test_delivery_task_and_cross_project_evidence_are_rejected(client: TestClient):
    graph = _project_graph(client, "primary")
    other = _project_graph(client, "other")
    delivery_task = _create_task(client, graph, task_kind="delivery")
    validation_task = _create_task(client, graph)
    foreign_resource = client.post(
        "/api/resources",
        json={
            "project_id": other["project_id"],
            "type": "text_note",
            "title": "其他项目资源",
            "content_text": "不可跨项目引用",
        },
    ).json()
    body = {
        "summary": "测试结果",
        "observed_value": "观察值",
        "decision": "adjust",
        "evidence_resource_ids": [],
    }

    delivery_response = client.put(
        f"/api/tasks/{delivery_task['id']}/validation-result",
        params={"viewer_user_id": graph["user_id"]},
        json=body,
    )
    assert delivery_response.status_code == 400

    cross_project_response = client.put(
        f"/api/tasks/{validation_task['id']}/validation-result",
        params={"viewer_user_id": graph["user_id"]},
        json={**body, "evidence_resource_ids": [foreign_resource["id"]]},
    )
    assert cross_project_response.status_code == 400
    assert "same project" in cross_project_response.json()["detail"]


def test_validation_result_rejects_forged_attribution_fields(client: TestClient):
    graph = _project_graph(client)
    task = _create_task(client, graph)
    response = client.put(
        f"/api/tasks/{task['id']}/validation-result",
        params={"viewer_user_id": graph["user_id"]},
        json={
            "summary": "测试结果",
            "observed_value": "观察值",
            "decision": "inconclusive",
            "recorded_by": "forged-user",
            "recorded_at": "2020-01-01T00:00:00Z",
        },
    )
    assert response.status_code == 422

