"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

type MarkdownPreviewProps = {
  markdown: string;
  className?: string;
};

export function MarkdownPreview({ markdown, className }: MarkdownPreviewProps) {
  return (
    <div
      className={cn(
        "markdown-preview max-w-none break-words text-[15px] leading-7 text-ink/80",
        "[&_h1]:mb-4 [&_h1]:mt-0 [&_h1]:font-display [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-[-0.02em] [&_h1]:text-ink",
        "[&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-ink",
        "[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-ink",
        "[&_p]:my-3 [&_p]:max-w-[72ch]",
        "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6",
        "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-6",
        "[&_blockquote]:my-4 [&_blockquote]:max-w-[72ch] [&_blockquote]:rounded-r-lg [&_blockquote]:border-l [&_blockquote]:border-primary/35 [&_blockquote]:bg-primary/[0.04] [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:text-ink/75",
        "[&_blockquote_p]:my-0",
        "[&_hr]:my-7 [&_hr]:border-neutral-200",
        "[&_strong]:font-semibold [&_strong]:text-ink",
        "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
        "[&_th]:border-b [&_th]:border-neutral-200 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink",
        "[&_td]:border-b [&_td]:border-neutral-100 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
        "[&_code]:rounded [&_code]:bg-ink/[0.06] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.9em]",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
