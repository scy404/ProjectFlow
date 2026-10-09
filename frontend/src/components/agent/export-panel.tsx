"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Download, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { generateProjectExport } from "@/lib/api";
import type { ProjectExportResult, ProjectExportType } from "@/lib/types";

type ExportPanelProps = {
  projectId: string;
};

export function ExportPanel({ projectId }: ExportPanelProps) {
  const [result, setResult] = useState<ProjectExportResult | null>(null);
  const [exportType, setExportType] = useState<ProjectExportType>("review_summary");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      setResult(await generateProjectExport(projectId, exportType));
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!result?.markdown) return;
    try {
      await navigator.clipboard.writeText(result.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制到剪贴板失败");
    }
  };

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${result.export_type}-${projectId}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">生成项目成果</h2>
          <p className="mt-1 text-sm text-ink/60">
            选择成果类型，预览后下载 Markdown。导出同时返回本次使用的数据库事实快照。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-ink/55" htmlFor="project-export-type">类型</label>
          <Select
            value={exportType}
            onValueChange={(value) => value && setExportType(value as ProjectExportType)}
          >
            <SelectTrigger id="project-export-type" className="h-9 bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="review_summary">评审摘要</SelectItem>
              <SelectItem value="opc_outcome">OPC 成果报告</SelectItem>
            </SelectContent>
          </Select>
          <Button disabled={loading} onClick={handleExport} className="bg-ink text-white hover:bg-ink/85">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {loading ? "生成中..." : "生成成果"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-coral/20 bg-coral/10 p-3 text-sm text-coral">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <div className="flex-1">
            <p>{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              className="mt-1 h-7 text-xs"
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              重试
            </Button>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold tracking-wider text-ink/45">
              预览
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleDownload} className="h-7 text-xs">
                <Download className="mr-1 h-3 w-3" />下载 .md
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopy} className="h-7 text-xs">
                {copied ? (
                  <>
                    <CheckCircle2 className="mr-1 h-3 w-3 text-moss" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-3 w-3" />
                    复制
                  </>
                )}
              </Button>
            </div>
          </div>
          <div className="custom-scrollbar mt-2 max-h-[36rem] overflow-auto rounded-xl border border-neutral-200 bg-neutral-50/60 p-5 sm:p-6">
            <MarkdownPreview markdown={result.markdown} />
          </div>
          <p className="mt-2 text-xs text-ink/45">
            事实快照：{result.facts.metrics.tasks_completed}/{result.facts.metrics.tasks_total} 个任务完成，
            {result.facts.validation_results.length} 个验证结果，{result.facts.evidence_refs.length} 条结构化证据引用。
          </p>
        </div>
      )}
    </section>
  );
}
