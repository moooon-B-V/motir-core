import type { WorkflowStatus, WorkflowTransition } from '@prisma/client';
import type {
  StatusCategoryDto,
  WorkflowStatusDto,
  WorkflowTransitionDto,
} from '@/lib/dto/workflows';

// Prisma → DTO converters for the workflow domain (Subtask 2.2.3). The service
// calls these at the read boundary so no Prisma row shape leaks to callers.
// `category` is a Prisma enum (`status_category`); its runtime values are
// exactly the DTO union, so the cast is safe.

export function toWorkflowStatusDto(status: WorkflowStatus): WorkflowStatusDto {
  return {
    id: status.id,
    projectId: status.projectId,
    key: status.key,
    label: status.label,
    category: status.category as StatusCategoryDto,
    color: status.color,
    position: status.position,
    isInitial: status.isInitial,
  };
}

export function toWorkflowTransitionDto(transition: WorkflowTransition): WorkflowTransitionDto {
  return {
    id: transition.id,
    projectId: transition.projectId,
    fromStatusId: transition.fromStatusId,
    toStatusId: transition.toStatusId,
  };
}
