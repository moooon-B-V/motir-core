import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { emailService } from '@/lib/services/emailService';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { watcherNotificationsService } from '@/lib/services/watcherNotificationsService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { automationEngineService } from '@/lib/services/automationEngineService';

// The service-layer injection bag handed to every job handler as its 2nd arg
// (Story 1.6 · Subtask 1.6.2). This is the seam that keeps the 4-layer rule
// intact for background work: a job handler is the "service caller" for a
// background trigger, so instead of importing service singletons ad-hoc it
// receives them here. That makes handlers unit-testable with a stubbed bag and
// gives `defineJob` one explicit dependency surface.
//
// It aggregates the EXISTING domain-service singletons — no new logic, just
// references — so it stays a thin DI seam (anti-overplanning, notes #20). New
// services join the bag as jobs come to need them (1.6.3's email.send is the
// first real consumer).
export const jobServices = {
  workspaces: workspacesService,
  workspaceInvites: workspaceInvitesService,
  projects: projectsService,
  workItems: workItemsService,
  users: usersService,
  email: emailService,
  mentionNotifications: mentionNotificationsService,
  watcherNotifications: watcherNotificationsService,
  attachments: attachmentsService,
  savedFilterSubscriptions: savedFilterSubscriptionsService,
  automationEngine: automationEngineService,
};

export type JobServices = typeof jobServices;
