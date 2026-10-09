from app.tests.test_support import relative_schedule


def _fixture(client):
    schedule = relative_schedule()
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Stage 4 workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Evidence-first project",
            "idea": "Show traceable project outcomes.",
            "deadline": schedule.project_deadline,
            "deliverables": "Review summary and OPC outcome",
            "created_by": owner["id"],
            "project_template": "startup",
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Validation",
            "goal": "Validate the core assumption",
            "start_date": schedule.stage_start,
            "end_date": schedule.stage_end,
            "deliverable": "Validation result",
            "done_criteria": ["Result recorded"],
            "status": "active",
        },
    ).json()
    delivery = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Build prototype",
            "description": "Build the smallest prototype.",
            "priority": "P1",
            "due_date": schedule.task_due,
        },
    ).json()
    validation = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Interview target users",
            "description": "Collect observable evidence.",
            "priority": "P0",
            "due_date": schedule.task_due,
            "task_kind": "validation",
            "validation_spec": {
                "hypothesis": "Users need clearer project guidance",
                "method": "Structured interviews",
                "success_criterion": "At least three users identify the same problem",
                "sample_target": 5,
            },
        },
    ).json()
    resource = client.post(
        "/api/resources",
        json={
            "project_id": project["id"],
            "type": "text_note",
            "title": "Interview notes",
            "content_text": "Three users reported the same navigation problem.",
        },
    ).json()
    return owner, project, stage, delivery, validation, resource


def test_metrics_are_database_derived_and_expose_ratio_parts(client):
    owner, project, _, _, validation, resource = _fixture(client)

    before = client.get(f"/api/projects/{project['id']}/metrics")
    assert before.status_code == 200
    assert before.json()["tasks_total"] == 2
    assert before.json()["validation_conclusion_ratio"] == {
        "numerator": 0,
        "denominator": 1,
    }
    assert before.json()["created_to_first_plan_seconds"] is None

    submitted = client.put(
        f"/api/tasks/{validation['id']}/validation-result",
        params={"viewer_user_id": owner["id"]},
        json={
            "summary": "The repeated navigation problem supports adjustment.",
            "observed_value": "3/5 interviews",
            "decision": "adjust",
            "evidence_resource_ids": [resource["id"]],
            "mark_complete": True,
        },
    )
    assert submitted.status_code == 200

    after = client.get(f"/api/projects/{project['id']}/metrics").json()
    assert after["tasks_completed"] == 1
    assert after["task_completion_ratio"] == {"numerator": 1, "denominator": 2}
    assert after["validation_tasks_with_result"] == 1
    assert after["validation_conclusion_ratio"] == {"numerator": 1, "denominator": 1}


def test_unified_exports_return_markdown_facts_and_log_export(client):
    owner, project, _, _, validation, resource = _fixture(client)
    client.put(
        f"/api/tasks/{validation['id']}/validation-result",
        params={"viewer_user_id": owner["id"]},
        json={
            "summary": "Evidence supports an adjustment.",
            "observed_value": "3/5 interviews",
            "decision": "adjust",
            "evidence_resource_ids": [resource["id"]],
        },
    )

    response = client.post(
        f"/api/projects/{project['id']}/exports",
        json={"export_type": "opc_outcome"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["export_type"] == "opc_outcome"
    assert "# ProjectFlow OPC 成果报告" in payload["markdown"]
    assert "## 验证任务与结论" in payload["markdown"]
    assert payload["facts"]["metrics"]["tasks_total"] == 2
    assert (
        payload["facts"]["validation_results"][0]["task_title"]
        == "Interview target users"
    )

    legacy = client.post(f"/api/projects/{project['id']}/export/review-summary")
    assert legacy.status_code == 200
    assert "# ProjectFlow 评审摘要" in legacy.json()["markdown"]

    timeline = client.get(f"/api/projects/{project['id']}/timeline").json()
    export_events = [event for event in timeline if event["event_type"] == "export"]
    assert len(export_events) == 2
    assert export_events[0]["output_snapshot"]["facts"]["metrics"]["tasks_total"] == 2


def test_risk_and_action_card_updates_refresh_updated_at(client):
    _, project, stage, delivery, _, _ = _fixture(client)
    risk = client.post(
        "/api/risks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": delivery["id"],
            "type": "scope",
            "severity": "medium",
            "title": "Scope is unclear",
            "description": "The prototype boundary needs confirmation.",
            "evidence": ["Boundary remains open"],
            "recommendation": "Confirm the MVP boundary.",
        },
    ).json()
    card = client.post(
        "/api/action-cards",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": delivery["id"],
            "type": "team_next_step",
            "title": "Confirm scope",
            "content": "Review and confirm the MVP boundary.",
            "reason": "The risk is still open.",
        },
    ).json()

    updated_risk = client.patch(
        f"/api/risks/{risk['id']}", json={"status": "accepted"}
    ).json()
    updated_card = client.patch(
        f"/api/action-cards/{card['id']}", json={"status": "done"}
    ).json()
    assert updated_risk["updated_at"] >= risk["updated_at"]
    assert updated_card["updated_at"] >= card["updated_at"]

    workspace_state = client.get(
        f"/api/workspaces/{project['workspace_id']}/state"
    ).json()
    assert (
        workspace_state["project"]["risks"][0]["updated_at"]
        == updated_risk["updated_at"]
    )
    assert (
        workspace_state["project"]["action_cards"][0]["updated_at"]
        == updated_card["updated_at"]
    )
