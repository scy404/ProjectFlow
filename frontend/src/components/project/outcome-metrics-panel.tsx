"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Database, Loader2 } from "lucide-react";

import { CompactStat } from "@/components/ui/compact-stat";
import { getProjectMetrics } from "@/lib/api";
import type { ProjectMetrics } from "@/lib/types";

function durationLabel(seconds: number | null) {
  if (seconds === null) return "尚无已确认计划";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

export function OutcomeMetricsPanel({
  projectId,
  isDemo,
}: {
  projectId: string;
  isDemo: boolean;
}) {
  const [loadState, setLoadState] = useState<{
    projectId: string;
    metrics: ProjectMetrics | null;
    error: string | null;
  }>({ projectId: "", metrics: null, error: null });
  const metrics = loadState.projectId === projectId ? loadState.metrics : null;
  const error = loadState.projectId === projectId ? loadState.error : null;

  useEffect(() => {
    let active = true;
    getProjectMetrics(projectId)
      .then((result) => {
        if (active) setLoadState({ projectId, metrics: result, error: null });
      })
      .catch((reason) => {
        if (active) {
          setLoadState({
            projectId,
            metrics: null,
            error: reason instanceof Error ? reason.message : "指标加载失败",
          });
        }
      });
    return () => { active = false; };
  }, [projectId]);

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold text-ink">成果事实</h2>
          </div>
          <p className="mt-1 text-sm text-ink/60">以下数据直接由当前数据库记录计算，不包含推测性效率或时间节省。</p>
        </div>
      </div>

      {isDemo && (
        <div className="mt-4 rounded-lg border border-citron/60 bg-citron/15 px-4 py-3 text-sm text-ink/75">
          当前为演示项目，以下指标来自演示种子数据，不代表真实用户成果。
        </div>
      )}

      {!metrics && !error && (
        <div className="mt-5 flex items-center gap-2 text-sm text-ink/50">
          <Loader2 className="h-4 w-4 animate-spin" />正在计算数据库事实…
        </div>
      )}
      {error && (
        <div className="mt-5 flex items-center gap-2 text-sm text-coral">
          <AlertCircle className="h-4 w-4" />{error}
        </div>
      )}
      {metrics && (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <CompactStat
              label="任务完成"
              value={`${metrics.tasks_completed}/${metrics.tasks_total}`}
              trend="数据库记录"
              helpText={metrics.calculation_notes.task_completion_ratio}
              tone="primary"
            />
            <CompactStat
              label="验证有结论"
              value={`${metrics.validation_tasks_with_result}/${metrics.validation_tasks_total}`}
              trend="数据库记录"
              helpText={metrics.calculation_notes.validation_conclusion_ratio}
              tone="moss"
            />
            <CompactStat
              label="Proposal 已决策"
              value={`${metrics.proposal_decision_ratio.numerator}/${metrics.proposal_decision_ratio.denominator}`}
              trend="数据库记录"
              helpText={metrics.calculation_notes.proposal_decision_ratio}
              tone="primary"
            />
            <CompactStat
              label="首个确认计划耗时"
              value={durationLabel(metrics.created_to_first_plan_seconds)}
              trend="数据库记录"
              helpText={metrics.calculation_notes.created_to_first_plan_seconds}
              tone="primary"
            />
          </div>
          <dl className="mt-4 grid gap-2 rounded-lg bg-paper p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-ink/50">完成分工</dt><dd className="font-semibold text-ink">{metrics.assignments_completed}/{metrics.assignments_total}</dd></div>
            <div><dt className="text-ink/50">风险记录</dt><dd className="font-semibold text-ink">{metrics.risks_total}</dd></div>
            <div><dt className="text-ink/50">行动卡</dt><dd className="font-semibold text-ink">{metrics.action_cards_total}</dd></div>
            <div><dt className="text-ink/50">待确认 Proposal</dt><dd className="font-semibold text-ink">{metrics.proposals_pending}</dd></div>
          </dl>
        </>
      )}
    </section>
  );
}
