"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronRight, ChevronLeft, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface TourStep {
  target: string;
  title: string;
  description: string;
  position: "below" | "above";
}

const TOUR_STEPS: TourStep[] = [
  {
    target: "[data-tour='header']",
    title: "项目旅程",
    description: "项目总览展示六步旅程；左侧导航按项目推进与复盘总结组织全部页面。",
    position: "below",
  },
  {
    target: "[data-tour='header']",
    title: "收敛导航",
    description: "两个导航分组可以独立展开，切换页面后仍会保留你已经展开的分组。",
    position: "below",
  },
  {
    target: "[data-tour='context']",
    title: "旅程上下文",
    description: "Agent 会读取项目当前步骤、待确认事项和真实项目数据，再推荐下一步。",
    position: "below",
  },
  {
    target: "[data-tour='prompts']",
    title: "先提案，再确认",
    description: "Agent 的变更建议会先形成 Proposal，只有你确认后才会写入项目。",
    position: "below",
  },
  {
    target: "[data-tour='composer']",
    title: "输入消息",
    description: "可以选择建议操作或直接输入需求；Enter 发送，Shift+Enter 换行。",
    position: "above",
  },
];

interface AgentGuidedTourProps {
  active: boolean;
  onComplete: () => void;
}

export function AgentGuidedTour({ active, onComplete }: AgentGuidedTourProps) {
  const [step, setStep] = useState(0);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const handleNext = useCallback(() => {
    if (step < TOUR_STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      onComplete();
    }
  }, [step, onComplete]);

  const handlePrev = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  // Position tooltip via useLayoutEffect to avoid render-time DOM reads
  useLayoutEffect(() => {
    if (!active) return;
    const el = tooltipRef.current;
    if (!el) return;
    const current = TOUR_STEPS[step];
    const targetEl = document.querySelector(current.target);
    el.style.position = "absolute";
    el.style.left = "8px";
    el.style.right = "8px";
    el.style.zIndex = "50";
    if (!targetEl) {
      el.style.top = "64px";
      el.style.bottom = "";
      return;
    }

    const rect = targetEl.getBoundingClientRect();
    const sidebarRect = targetEl.closest("[data-tour-sidebar]")?.getBoundingClientRect();

    if (sidebarRect) {
      if (current.position === "below") {
        el.style.top = `${rect.bottom - sidebarRect.top + 8}px`;
        el.style.bottom = "";
      } else if (current.position === "above") {
        el.style.bottom = `${sidebarRect.bottom - rect.top + 8}px`;
        el.style.top = "";
      }
    } else {
      el.style.top = "64px";
      el.style.bottom = "";
    }
  }, [active, step]);

  // Keyboard navigation
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleSkip(); }
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); handleNext(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); handlePrev(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, handleSkip, handleNext, handlePrev]);

  if (!active) return null;

  const current = TOUR_STEPS[step];

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={step}
        ref={tooltipRef}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.15 }}
        role="dialog"
        aria-label="ProjectFlow 使用引导"
        className="max-w-sm rounded-md border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-moss" />
            <p className="text-xs font-semibold text-neutral-800">{current.title}</p>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            className="text-neutral-500 hover:text-neutral-700"
            aria-label="跳过引导"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-neutral-500">{current.description}</p>
        <div className="mt-2.5 flex items-center justify-between">
          <div className="flex gap-1">
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1 w-1 rounded-full",
                  i === step ? "bg-moss" : "bg-neutral-200",
                )}
                aria-hidden
              />
            ))}
          </div>
          <div className="flex gap-1.5">
            {step > 0 && (
              <button
                type="button"
                onClick={handlePrev}
                className="flex h-6 items-center gap-0.5 rounded px-2 text-[10px] text-neutral-500 hover:bg-neutral-50"
              >
                <ChevronLeft className="h-3 w-3" />
                上一步
              </button>
            )}
            <button
              type="button"
              onClick={handleNext}
              className="flex h-6 items-center gap-0.5 rounded bg-moss px-2 text-[10px] text-white hover:bg-moss/90"
            >
              {step < TOUR_STEPS.length - 1 ? "下一步" : "开始使用"}
              {step < TOUR_STEPS.length - 1 && <ChevronRight className="h-3 w-3" />}
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export function useGuidedTour() {
  const [tourState, setTourState] = useState({ active: false, session: 0 });

  const start = useCallback(() => {
    setTourState((current) => ({ active: true, session: current.session + 1 }));
  }, []);
  const complete = useCallback(() => {
    setTourState((current) => ({ ...current, active: false }));
  }, []);

  return { ...tourState, start, complete };
}
