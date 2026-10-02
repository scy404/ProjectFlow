"use client"

import * as React from "react"
import { motion } from "framer-motion"
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  Lightbulb,
  AlertCircle,
  CalendarIcon,
  RotateCcw,
  Sparkles,
  Users,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { createProject, addResource } from "@/lib/api"
import type { Project, ProjectTemplate, AddResourceRequest } from "@/lib/types"
import { ResourceInputPanel } from "./resource-input-panel"
import { FormSection } from "@/components/ui/form-section"
import { FormField } from "@/components/ui/form-field"
import { TagInput } from "@/components/ui/tag-input"
import { cn } from "@/lib/utils"
import { PROJECT_TEMPLATE_OPTIONS } from "./project-template-options"

interface DraftData {
  name: string
  idea: string
  deadline: string
  projectTemplate?: ProjectTemplate
  projectType?: ProjectTemplate
  deliverables: string[]
}

const DRAFT_KEY = "project-intake-draft"

interface ProjectIntakeFormProps {
  workspaceId: string
  creatorUserId: string
  defaultProjectTemplate?: ProjectTemplate
  teamMembers?: Array<{ user_id: string; display_name: string }>
  workspaceTeamSize?: number | null
  onCreated?: (project: Project, nextStep: "open" | "clarify") => void
}

export function ProjectIntakeForm({
  workspaceId,
  creatorUserId,
  defaultProjectTemplate = "general",
  teamMembers = [],
  workspaceTeamSize,
  onCreated,
}: ProjectIntakeFormProps) {
  const [resources, setResources] = React.useState<AddResourceRequest[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [touched, setTouched] = React.useState<Record<string, boolean>>({})

  // Load draft from localStorage on mount
  const [name, setName] = React.useState(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.name || ""
      }
    } catch { /* ignore */ }
    return ""
  })
  const [idea, setIdea] = React.useState(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.idea || ""
      }
    } catch { /* ignore */ }
    return ""
  })
  const [deadline, setDeadline] = React.useState(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.deadline || ""
      }
    } catch { /* ignore */ }
    return ""
  })
  const [projectTemplate, setProjectTemplate] = React.useState<ProjectTemplate>(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.projectTemplate || data.projectType || defaultProjectTemplate
      }
    } catch { /* ignore */ }
    return defaultProjectTemplate
  })
  const [deliverableTags, setDeliverableTags] = React.useState<string[]>(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) {
        const data: DraftData = JSON.parse(draft)
        return data.deliverables || []
      }
    } catch { /* ignore */ }
    return []
  })
  const [createdProject, setCreatedProject] = React.useState<Project | null>(null)
  const [failedResources, setFailedResources] = React.useState<AddResourceRequest[]>([])
  const [retryingResources, setRetryingResources] = React.useState(false)

  // Auto-save draft
  React.useEffect(() => {
    const draft: DraftData = {
      name,
      idea,
      deadline,
      projectTemplate,
      deliverables: deliverableTags,
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [name, idea, deadline, projectTemplate, deliverableTags])

  const validate = React.useCallback((): boolean => {
    const newErrors: Record<string, string> = {}
    if (!name.trim()) {
      newErrors.name = "请输入项目名称"
    } else if (name.trim().length < 2) {
      newErrors.name = "项目名称至少 2 个字符"
    } else if (name.trim().length > 50) {
      newErrors.name = "项目名称最多 50 个字符"
    }

    if (!idea.trim()) {
      newErrors.idea = "请输入项目想法"
    } else if (idea.trim().length < 10) {
      newErrors.idea = "项目想法至少 10 个字符"
    } else if (idea.trim().length > 500) {
      newErrors.idea = "项目想法最多 500 个字符"
    }

    if (!deadline) {
      newErrors.deadline = "请选择截止日期"
    } else {
      const deadlineDate = new Date(deadline)
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      if (deadlineDate < now) {
        newErrors.deadline = "截止日期必须在今天之后"
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [name, idea, deadline])

  const validateField = React.useCallback((field: string, value: string) => {
    const newErrors: Record<string, string> = {}
    if (field === "name") {
      if (!value.trim()) {
        newErrors.name = "请输入项目名称"
      } else if (value.trim().length < 2) {
        newErrors.name = "项目名称至少 2 个字符"
      } else if (value.trim().length > 50) {
        newErrors.name = "项目名称最多 50 个字符"
      }
    }
    if (field === "idea") {
      if (!value.trim()) {
        newErrors.idea = "请输入项目想法"
      } else if (value.trim().length < 10) {
        newErrors.idea = "项目想法至少 10 个字符"
      } else if (value.trim().length > 500) {
        newErrors.idea = "项目想法最多 500 个字符"
      }
    }
    if (field === "deadline") {
      if (!value) {
        newErrors.deadline = "请选择截止日期"
      } else {
        const deadlineDate = new Date(value)
        const now = new Date()
        now.setHours(0, 0, 0, 0)
        if (deadlineDate < now) {
          newErrors.deadline = "截止日期必须在今天之后"
        }
      }
    }
    setErrors((prev) => ({ ...prev, ...newErrors }))
  }, [])

  const clearDraft = () => {
    localStorage.removeItem(DRAFT_KEY);
  };

  const [showClearConfirm, setShowClearConfirm] = React.useState(false);



  const handleClear = () => {
    setShowClearConfirm(true);
  };

  const confirmClear = () => {
    clearDraft();
    setName("");
    setIdea("");
    setDeadline("");
    setProjectTemplate(defaultProjectTemplate);
    setDeliverableTags([]);
    setErrors({});
    setError(null);
    setResources([]); // 确保资源也被清空
    setShowClearConfirm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) {
      setTimeout(() => {
        const firstErrorElement = document.querySelector('.border-destructive');
        if (firstErrorElement) {
          firstErrorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          (firstErrorElement as HTMLElement).focus?.();
        }
      }, 0);
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const deliverablesStr =
        deliverableTags.length > 0
          ? deliverableTags.join(", ")
          : "待补充"
      const project = await createProject(workspaceId, {
        name: name.trim(),
        idea: idea.trim(),
        deadline,
        deliverables: deliverablesStr,
        project_template: projectTemplate,
        created_by: creatorUserId,
      })
      // Add resources if any
      const failed: AddResourceRequest[] = []
      for (const res of resources) {
        try {
          await addResource(project.id, res)
        } catch (err) {
          console.error(`资源"${res.title || 'untitled'}"保存失败:`, err)
          failed.push(res)
        }
      }
      clearDraft()
      setCreatedProject(project)
      setFailedResources(failed)
    } catch {
      setError("创建项目失败，请重试")
    } finally {
      setSubmitting(false)
    }
  }

  const retryFailedResources = async () => {
    if (!createdProject || failedResources.length === 0) return
    setRetryingResources(true)
    const stillFailed: AddResourceRequest[] = []
    for (const resource of failedResources) {
      try {
        await addResource(createdProject.id, resource)
      } catch {
        stillFailed.push(resource)
      }
    }
    setFailedResources(stillFailed)
    setRetryingResources(false)
  }

  if (createdProject) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 p-4" aria-live="polite">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-moss" aria-hidden="true" />
          <div>
            <h2 className="text-2xl font-bold text-ink">项目已创建</h2>
            <p className="mt-1 text-sm text-ink/60">
              {createdProject.name} 已保存。下一步生成方向卡，确认项目要解决的问题、边界和验证目标。
            </p>
          </div>
        </div>

        {failedResources.length > 0 && (
          <div className="rounded-lg bg-destructive/5 px-4 py-3 text-sm text-ink" role="alert">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-semibold text-destructive">
                  项目已创建，但有 {failedResources.length} 个资源尚未保存
                </p>
                <p className="mt-1 break-words text-ink/65">
                  {failedResources.map((resource) => resource.title || "未命名资源").join("、")}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={retryFailedResources} disabled={retryingResources}>
                    {retryingResources ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    重试保存资源
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setFailedResources([])}>
                    暂时跳过
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onCreated?.(createdProject, "open")}>
            先进入项目
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button type="button" onClick={() => onCreated?.(createdProject, "clarify")}>
            <Sparkles className="h-4 w-4" />
            生成方向卡
          </Button>
        </div>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
      className="mx-auto max-w-2xl space-y-6 p-4"
    >
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-bold">
          <Lightbulb className="h-6 w-6 text-amber-500" />
          新建项目
        </h2>
        <p className="text-sm text-muted-foreground">
          填写项目信息，AI 将为你生成阶段规划和任务分解
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <FormSection title="项目基本信息">
          <div className="grid gap-4">
            <FormField label="项目名称" required error={errors.name}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (touched.name) validateField("name", e.target.value)
                }}
                onBlur={() => {
                  setTouched((prev) => ({ ...prev, name: true }))
                  validateField("name", name)
                }}
                placeholder="例如：校园二手交易平台"
                className={cn("h-10", errors.name && "border-destructive")}
              />
            </FormField>
            <FormField label="截止日期" required error={errors.deadline}>
              <div className="relative">
                <Input
                  type="date"
                  value={deadline}
                  onChange={(e) => {
                    setDeadline(e.target.value)
                    if (touched.deadline) validateField("deadline", e.target.value)
                  }}
                  onBlur={() => {
                    setTouched((prev) => ({ ...prev, deadline: true }))
                    validateField("deadline", deadline)
                  }}
                  className={cn("h-10 pr-10", errors.deadline && "border-destructive")}
                />
                <CalendarIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </FormField>
          </div>
          <FormField
            label="项目想法"
            required
            error={errors.idea}
            hint="描述项目背景、目标和预期成果"
          >
            <Textarea
              value={idea}
              onChange={(e) => {
                setIdea(e.target.value)
                if (touched.idea) validateField("idea", e.target.value)
              }}
              onBlur={() => {
                setTouched((prev) => ({ ...prev, idea: true }))
                validateField("idea", idea)
              }}
              placeholder="我们想做一款帮助大学生..."
              rows={4}
              className={cn("resize-none", errors.idea && "border-destructive")}
            />
          </FormField>
        </FormSection>

        <FormSection title="项目详情">
          <FormField label="项目类型">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {PROJECT_TEMPLATE_OPTIONS.map((type) => {
                const Icon = type.icon
                const isSelected = projectTemplate === type.id
                return (
                  <button
                    key={type.id}
                    type="button"
                    onClick={() => setProjectTemplate(type.id)}
                    className={cn(
                      "flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors",
                      isSelected
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-muted bg-background hover:border-muted-foreground/30"
                    )}
                  >
                    <Icon className="h-6 w-6" />
                    <span className="text-sm font-medium">{type.label}</span>
                  </button>
                )
              })}
            </div>
          </FormField>

          <div className="flex items-start gap-3 rounded-lg bg-neutral-50 px-4 py-3 text-sm text-ink/70">
            <Users className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium text-ink">当前团队</p>
              <p className="mt-0.5 break-words">
                {teamMembers.length > 0
                  ? `${teamMembers.length} 名成员：${teamMembers.map((member) => member.display_name).join("、")}`
                  : workspaceTeamSize
                    ? `工作区计划团队规模：${workspaceTeamSize} 人`
                    : "成员信息将在工作区中统一管理，无需在项目中重复填写。"}
              </p>
            </div>
          </div>

          <FormField label="预期交付物" hint="项目最终要产出什么">
            <TagInput
              tags={deliverableTags}
              onTagsChange={setDeliverableTags}
              placeholder="输入后按回车添加"
              maxTags={8}
            />
          </FormField>
        </FormSection>

        <FormSection title="资源与约束" collapsible defaultOpen={false}>
          <ResourceInputPanel onChange={setResources} />
        </FormSection>

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleClear}
          >
            清空
          </Button>
          <Button
            type="submit"
            disabled={
              submitting ||
              !name.trim() ||
              !idea.trim() ||
              !deadline ||
              !creatorUserId
            }
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                创建中...
              </>
            ) : (
              <>开始规划 &rarr;</>
            )}
          </Button>
        </div>
      </form>

      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认清空表单？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作将清空所有已填写的信息，且不可撤销。您确定要继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmClear}>清空</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  )
}
