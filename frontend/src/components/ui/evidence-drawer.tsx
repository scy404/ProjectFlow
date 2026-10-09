"use client";

import { createContext, useContext } from "react";
import { AlertTriangle, Database, SearchCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { deriveTrustState, resolveEvidenceRefs } from "@/lib/evidence-resolver";
import type { AgentEvent, AgentProposal, EvidenceRef, ProjectState } from "@/lib/types";

const EvidenceStateContext = createContext<ProjectState | undefined>(undefined);

export function EvidenceResolverProvider({
  state,
  children,
}: {
  state: ProjectState;
  children: React.ReactNode;
}) {
  return (
    <EvidenceStateContext.Provider value={state}>
      {children}
    </EvidenceStateContext.Provider>
  );
}

const GENERATION_LABELS = {
  success: "正常生成",
  repaired: "修复后生成",
  fallback: "降级生成",
  failed: "生成失败",
  unknown: "暂无生成记录",
} as const;

const PROPOSAL_LABELS = {
  pending: "待用户确认",
  confirmed: "用户已确认",
  rejected: "用户已拒绝",
  not_applicable: "无需 Proposal",
} as const;

export function EvidenceDrawer({
  refs,
  reason,
  unknowns = [],
  event,
  proposalStatus,
  impacts = [],
}: {
  refs?: EvidenceRef[];
  reason?: string | null;
  unknowns?: string[];
  event?: AgentEvent | null;
  proposalStatus?: AgentProposal["status"] | null;
  impacts?: string[];
}) {
  const state = useContext(EvidenceStateContext);
  const resolved = resolveEvidenceRefs(refs, state);
  const trust = deriveTrustState({ event, proposalStatus, unknowns });

  return (
    <Sheet>
      <SheetTrigger
        render={<Button type="button" variant="outline" size="sm" className="h-7 text-xs" />}
      >
        <SearchCheck className="h-3.5 w-3.5" />
        查看可信依据
      </SheetTrigger>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b border-ink/10 pr-12">
          <SheetTitle>建议依据与可信状态</SheetTitle>
          <SheetDescription>
            仅说明系统掌握的事实、仍未知的信息和用户确认状态，不提供伪精确置信度。
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          <section>
            <h3 className="text-sm font-semibold text-ink">可信状态</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge className="bg-ink/8 text-ink/65">
                {trust.outputMode === "structured" ? "结构化输出" : trust.outputMode === "narrative" ? "叙述性输出" : "无有效输出"}
              </Badge>
              <Badge className={trust.generationStatus === "failed" || trust.generationStatus === "fallback" ? "bg-coral/15 text-coral" : "bg-moss/15 text-moss"}>
                {GENERATION_LABELS[trust.generationStatus]}
              </Badge>
              <Badge className="bg-harbor/15 text-harbor">
                {PROPOSAL_LABELS[trust.proposalStatus]}
              </Badge>
              <Badge className={trust.unknownCount ? "bg-citron/40 text-ink" : "bg-ink/8 text-ink/60"}>
                未知项 {trust.unknownCount}
              </Badge>
            </div>
          </section>

          {reason && (
            <section>
              <h3 className="text-sm font-semibold text-ink">生成理由</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink/70">{reason}</p>
            </section>
          )}

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Database className="h-4 w-4" />结构化证据
            </h3>
            {resolved.length ? (
              <ul className="mt-2 space-y-2">
                {resolved.map((item, index) => (
                  <li key={`${item.entityLabel}-${index}`} className="rounded-md border border-ink/10 bg-paper p-3 text-sm">
                    <p className={item.status === "unavailable" ? "font-medium text-coral" : "font-medium text-ink"}>
                      {item.entityLabel}
                    </p>
                    <p className="mt-1 text-ink/65">{item.field}：{item.value}</p>
                    {item.note && <p className="mt-1 text-xs text-ink/50">{item.note}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-ink/50">当前建议没有结构化证据引用。</p>
            )}
          </section>

          {unknowns.length > 0 && (
            <section>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <AlertTriangle className="h-4 w-4 text-citron" />仍未知
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink/65">
                {unknowns.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>
          )}

          {impacts.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-ink">确认后影响</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink/65">
                {impacts.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
