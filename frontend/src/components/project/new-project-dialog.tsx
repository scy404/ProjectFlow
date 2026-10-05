"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ProjectIntakeForm } from "./project-intake-form";
import type { Project, ProjectTemplate } from "@/lib/types";

interface NewProjectDialogProps {
  workspaceId: string;
  creatorUserId: string;
  teamMembers?: Array<{ user_id: string; display_name: string }>;
  workspaceTeamSize?: number | null;
  defaultProjectTemplate?: ProjectTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (project: Project, nextStep: "open" | "clarify") => void;
}

export function NewProjectDialog({
  workspaceId,
  creatorUserId,
  teamMembers,
  workspaceTeamSize,
  defaultProjectTemplate,
  open,
  onOpenChange,
  onCreated,
}: NewProjectDialogProps) {
  const handleCreated = (project: Project, nextStep: "open" | "clarify") => {
    onCreated?.(project, nextStep);
    onOpenChange(false);
  };

  const handleOpenChange = (open: boolean) => {
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto custom-scrollbar p-6">
        <DialogHeader className="sr-only">
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>
            填写项目信息，创建后可让 Agent 生成阶段规划和任务分解建议
          </DialogDescription>
        </DialogHeader>
        <ProjectIntakeForm
          workspaceId={workspaceId}
          creatorUserId={creatorUserId}
          defaultProjectTemplate={defaultProjectTemplate}
          teamMembers={teamMembers}
          workspaceTeamSize={workspaceTeamSize}
          onCreated={handleCreated}
        />
      </DialogContent>
    </Dialog>
  );
}
