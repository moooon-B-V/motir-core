import { dailyHealthCheck } from './definitions/dailyHealthCheck';
import { emailSend } from './definitions/emailSend';
import {
  mentionNotifyOnCommentCreated,
  mentionNotifyOnWorkItemMentioned,
} from './definitions/mentionNotify';
import {
  watcherNotifyOnCommentCreated,
  watcherNotifyOnTransitioned,
} from './definitions/watcherNotify';
import {
  notificationFanInOnCommentCreated,
  notificationFanInOnWorkItemMentioned,
  notificationFanInOnTransitioned,
} from './definitions/notificationFanIn';
import { attachmentGc } from './definitions/attachmentGc';
import { rateLimitSweep } from './definitions/rateLimitSweep';
import { codeGraphOffboardSweep } from './definitions/codeGraphOffboardSweep';
import { filterSubscriptionTick } from './definitions/filterSubscriptionTick';
import { filterSubscriptionDeliver } from './definitions/filterSubscriptionDeliver';
import { publicFollowDigestTick } from './definitions/publicFollowDigestTick';
import { publicFollowDigestDeliver } from './definitions/publicFollowDigestDeliver';
import {
  automationEngineOnCreated,
  automationEngineOnFieldChanged,
  automationEngineOnTransitioned,
  automationEngineOnCommented,
  automationRetentionSweep,
} from './definitions/automationEngine';
import { billingSeatSync } from './definitions/billingSeatSync';
import { codeGraphIndex } from './definitions/codeGraphIndex';
import { codeGraphRefresh } from './definitions/codeGraphRefresh';
import { outwardBugTelemetryOnCreated } from './definitions/outwardBugTelemetry';
import { autoPlanCadenceTick } from './definitions/autoPlanCadenceTick';
import { ciMinutesReconcile } from './definitions/ciMinutesReconcile';
import { ciActionsGateSweep } from './definitions/ciActionsGateSweep';
import { ciRunnerProvisionSweep, ciRunnerBoot, ciRunnerReap } from './definitions/ciRunnerFleet';
import {
  statusDerivationOnChildSetChanged,
  statusDerivationOnCreated,
  statusDerivationOnRequested,
  statusDerivationOnTransitioned,
} from './definitions/statusDerivation';
import { planDriftOnTransitioned } from './definitions/planDrift';
import { migrateOnboardingSweep } from './definitions/migrateOnboardingSweep';
import { workItemEmbeddingRequested } from './definitions/workItemEmbedding';
import { planTargetLockSweep } from './definitions/planTargetLockSweep';
import { supervisionSweep } from './definitions/supervisionSweep';
import { abandonedPlanSweep } from './definitions/abandonedPlanSweep';
import { jobRunReap } from './definitions/jobRunReap';
import { dataExportBuild } from './definitions/dataExportBuild';
import { dataExportExpirySweep } from './definitions/dataExportExpirySweep';
import { accountErasureSweep } from './definitions/accountErasureSweep';

// EVERY JOB THIS IMAGE KNOWS (Story 1.6 · Subtask 1.6.2; re-based onto the
// Postgres engine by Story MOTIR-3418).
//
// Adding a new job = define it under `definitions/` and add it here. There is no
// serve route to mount them on any more — what this list does is FORCE THE
// MODULE EVALUATION that populates the engine's own tables. `defineJob` registers
// a definition as its module is evaluated (`lib/jobs/engine/registry.ts`,
// `lib/jobs/engine/manifest.ts`, `lib/jobs/schedules.ts`), so those tables hold
// only the jobs something has imported — and importing THIS module is what makes
// them complete. `scripts/worker.ts` does exactly that, for the side effect
// rather than the value.
//
// ⚠️ THE ARRAY IS NOT A SECOND SOURCE OF TRUTH. Its members are the very objects
// `registerEngineJob` recorded, returned by `defineJob`; `engineJobs()` is the
// same set read back out of the registry. The array survives the retirement
// because it is the RITUAL — a new job that nobody adds here is a job the worker
// never evaluates — and because a test asserting "this job ships" has something
// to name.
export const jobDefinitions = [
  dailyHealthCheck,
  emailSend,
  mentionNotifyOnCommentCreated,
  mentionNotifyOnWorkItemMentioned,
  watcherNotifyOnCommentCreated,
  watcherNotifyOnTransitioned,
  notificationFanInOnCommentCreated,
  notificationFanInOnWorkItemMentioned,
  notificationFanInOnTransitioned,
  attachmentGc,
  rateLimitSweep,
  codeGraphOffboardSweep,
  filterSubscriptionTick,
  filterSubscriptionDeliver,
  publicFollowDigestTick,
  publicFollowDigestDeliver,
  automationEngineOnCreated,
  automationEngineOnFieldChanged,
  automationEngineOnTransitioned,
  automationEngineOnCommented,
  automationRetentionSweep,
  billingSeatSync,
  codeGraphIndex,
  codeGraphRefresh,
  outwardBugTelemetryOnCreated,
  autoPlanCadenceTick,
  ciMinutesReconcile,
  ciActionsGateSweep,
  ciRunnerProvisionSweep,
  ciRunnerBoot,
  ciRunnerReap,
  planDriftOnTransitioned,
  statusDerivationOnTransitioned,
  statusDerivationOnCreated,
  statusDerivationOnChildSetChanged,
  statusDerivationOnRequested,
  migrateOnboardingSweep,
  workItemEmbeddingRequested,
  planTargetLockSweep,
  supervisionSweep,
  abandonedPlanSweep,
  jobRunReap,
  dataExportBuild,
  dataExportExpirySweep,
  accountErasureSweep,
];
