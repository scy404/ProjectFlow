"use client";

import { AlertTriangle, ArrowRight, Check, Circle, LockKeyhole, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deriveProjectJourney } from "@/lib/project-journey";
import type { ProjectJourneyStatus } from "@/lib/project-journey";
import type { ProjectState } from "@/lib/types";
import type { AgentAction } from "./project-actions";
import type { ProjectView } from "./project-sidebar";

const STATUS_META: Record<ProjectJourneyStatus, { label: string; className: string }> = {
  locked: { label: "未开放", className: "border-neutral-200 bg-neutral-50 text-neutral-400" },
  available: { label: "可开始", className: "border-blue-200 bg-blue-50 text-blue-700" },
  active: { label: "进行中", className: "border-moss/25 bg-moss/10 text-moss" },
  completed: { label: "已完成", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  needs_attention: { label: "需处理", className: "border-coral/25 bg-coral/10 text-coral" },
};

function StatusIcon({ status }: { status: ProjectJourneyStatus }) {
  if (status === "completed") return <Check className="h-4 w-4" aria-hidden="true" />;
  if (status === "locked") return <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "needs_attention") return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
  return <Circle className={cn("h-3.5 w-3.5", status === "active" && "fill-current")} aria-hidden="true" />;
}

interface ProjectJourneyBarProps {
  state: ProjectState;
  pendingAction?: AgentAction | null;
  onNavigateView?: (view: ProjectView) => void;
  onRunAgent?: (action: AgentAction) => void;
}

export function ProjectJourneyBar({
  state,
  pendingAction,
  onNavigateView,
  onRunAgent,
}: ProjectJourneyBarProps) {
  const journey = deriveProjectJourney(state);
  const current = journey.currentStep;
  const currentMeta = STATUS_META[current.status];
  const isRunning = current.cta.kind === "agent" && pendingAction === current.cta.action;

  const runCurrentCta = () => {
    if (current.cta.disabled) return;
    if (current.cta.kind === "navigate") onNavigateView?.(current.cta.view as ProjectView);
    else onRunAgent?.(current.cta.action as AgentAction);
  };

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.01)]" aria-labelledby="project-journey-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="project-journey-title" className="text-base font-semibold text-neutral-900">项目旅程</h2>
          <p className="mt-1 text-sm text-neutral-500">由当前项目数据自动判断，不以页面访问记录作为完成依据。</p>
        </div>
        <span className="hidden shrink-0 text-xs font-medium text-neutral-400 sm:block">
          {journey.completedCount}/6 已完成
        </span>
      </div>

      <ol className="mt-6 hidden grid-cols-6 gap-2 md:grid" aria-label="项目旅程六个步骤">
        {journey.steps.map((step, index) => {
          const meta = STATUS_META[step.status];
          const isCurrent = step.id === current.id;
          return (
            <li key={step.id} className="relative min-w-0" aria-current={isCurrent ? "step" : undefined}>
              {index < journey.steps.length - 1 && (
                <span
                  className={cn(
                    "absolute left-[calc(50%+18px)] right-[calc(-50%+18px)] top-4 h-px",
                    step.status === "completed" ? "bg-emerald-200" : "bg-neutral-200",
                  )}
                  aria-hidden="true"
                />
              )}
              <div className="relative flex flex-col items-center text-center">
                <span className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border",
                  meta.className,
                  isCurrent && "ring-4 ring-blue-50",
                )}>
                  <StatusIcon status={step.status} />
                  <span className="sr-only">{meta.label}</span>
                </span>
                <span className={cn("mt-2 text-xs font-medium", isCurrent ? "text-neutral-900" : "text-neutral-500")}>
                  {step.title}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-5 flex flex-col gap-4 rounded-lg border border-neutral-100 bg-neutral-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-neutral-400 md:hidden">第 {current.order}/6 步</span>
            <span className="font-semibold text-neutral-900">{current.title}</span>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", currentMeta.className)}>
              {currentMeta.label}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6 text-neutral-600">{current.detail}</p>
        </div>
        <Button
          type="button"
          className="w-full shrink-0 sm:w-auto"
          disabled={current.cta.disabled || isRunning || (!onNavigateView && current.cta.kind === "navigate") || (!onRunAgent && current.cta.kind === "agent")}
          onClick={runCurrentCta}
        >
          {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {current.cta.label}
          {!isRunning ? <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /> : null}
        </Button>
      </div>
    </section>
  );
}
