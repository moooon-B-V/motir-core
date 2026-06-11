import { Prisma, type AutomationTriggerType } from '@prisma/client';
import { automationRuleRepository } from '@/lib/repositories/automationRuleRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { decodeFilterParam, encodeFilterEnvelope, type FilterAst } from '@/lib/filters/ast';
import { validateFilterAst } from '@/lib/filters/registry';
import { MalformedFilterError } from '@/lib/filters/errors';
import {
  parseAction,
  parseTriggerConfig,
  type AutomationActionConfig,
  type AutomationTriggerConfig,
} from '@/lib/automation/registry';
import {
  AUTOMATION_ACTIONS_PER_RULE_CAP,
  AUTOMATION_RULES_PER_PROJECT_CAP,
  AUTOMATION_RULE_NAME_MAX_LENGTH,
} from '@/lib/automation/constants';
import {
  AutomationActionLimitError,
  AutomationRuleLimitError,
  AutomationRuleNotFoundError,
  InvalidAutomationRuleError,
} from '@/lib/automation/errors';
import { toAutomationRuleDto } from '@/lib/mappers/automationRuleMappers';
import type { AutomationRuleDto } from '@/lib/dto/automationRules';

// automationRulesService (Story 6.6 · Subtask 6.6.1) — persistence +
// permissions for the rule model. Owns validation (the TOTAL trigger/action
// registries + the 6.1 condition validation, name + caps), the project-admin
// gate (the 6.4 manage-project permission — the whole Automation surface is
// admin-only, the verified Jira scope), transactions, and DTO mapping. Routes
// are HTTP-only (CLAUDE.md). NO engine here (6.6.2): a rule is data; nothing
// fires yet.
//
// Hide-gate (the 6.4 / finding #44 rule): a missing / cross-tenant /
// non-browsable project reads as ProjectNotFoundError (404); a browsable
// non-admin is NotProjectAdminError (403); a rule the actor's project doesn't
// own is AutomationRuleNotFoundError (404). The condition rides the SAME 6.1
// codec saved filters use (one codec, two carriers): writes accept the
// `?filter=v1:` param string, decode + deep-validate, and store the envelope.

/** The validated, write-ready core of a rule (shared by create + update). */
interface NormalizedRule {
  name: string;
  triggerType: AutomationTriggerType;
  triggerConfig: AutomationTriggerConfig;
  conditionEnvelope: Prisma.InputJsonValue;
  actions: AutomationActionConfig[];
}

export interface AutomationRuleWriteInput {
  name: string;
  triggerType: string;
  triggerConfig: unknown;
  /** The `?filter=v1:` condition param string the 6.1.4 builder holds, or null
   * / '' for the empty (always-match) group. */
  conditionFilterParam: string | null;
  actions: unknown;
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidAutomationRuleError('name must be a string');
  const name = raw.trim();
  if (name.length === 0) throw new InvalidAutomationRuleError('name must not be empty');
  if (name.length > AUTOMATION_RULE_NAME_MAX_LENGTH) {
    throw new InvalidAutomationRuleError(
      `name is at most ${AUTOMATION_RULE_NAME_MAX_LENGTH} characters`,
    );
  }
  return name;
}

/** Decode + deep-validate the incoming condition param into the stored
 * envelope. Null / '' → the empty always-match group. Forgery (bad structure,
 * unknown static field, bad value) throws a typed FilterValidationError /
 * MalformedFilterError (→ 422) — the 6.1 injection posture, extended here. */
function normalizeCondition(filterParam: string | null): Prisma.InputJsonValue {
  const ast: FilterAst =
    filterParam == null || filterParam === ''
      ? { combinator: 'and', conditions: [] }
      : decodeIncoming(filterParam);
  validateFilterAst(ast);
  return encodeFilterEnvelope(ast) as unknown as Prisma.InputJsonValue;
}

function decodeIncoming(filterParam: string): FilterAst {
  const decoded = decodeFilterParam(filterParam);
  if (!decoded.ok) throw new MalformedFilterError(`${decoded.reason}: ${decoded.detail}`);
  return decoded.ast;
}

/** Validate the ordered action list: a non-empty array within the 10-action
 * cap, every entry a registry-valid action config. */
function normalizeActions(raw: unknown): AutomationActionConfig[] {
  if (!Array.isArray(raw)) throw new InvalidAutomationRuleError('actions must be an array');
  if (raw.length === 0) throw new InvalidAutomationRuleError('a rule needs at least one action');
  if (raw.length > AUTOMATION_ACTIONS_PER_RULE_CAP) {
    throw new AutomationActionLimitError(AUTOMATION_ACTIONS_PER_RULE_CAP);
  }
  return raw.map((action) => parseAction(action));
}

/** Run every validation, producing the write-ready core — typed throws (→ 422)
 * on any forged / over-cap input. Order is deliberate (name → trigger →
 * actions → condition) so the first problem surfaces; all are 422s. */
function normalizeRule(input: AutomationRuleWriteInput): NormalizedRule {
  const name = normalizeName(input.name);
  const triggerConfig = parseTriggerConfig(input.triggerType, input.triggerConfig);
  const actions = normalizeActions(input.actions);
  const conditionEnvelope = normalizeCondition(input.conditionFilterParam);
  return { name, triggerType: triggerConfig.type, triggerConfig, conditionEnvelope, actions };
}

/** Resolve the project by key within the actor's workspace AND assert the actor
 * may administer it (the 6.4 manage-project gate). A missing / cross-tenant /
 * non-browsable project → ProjectNotFoundError (404); a browsable non-admin →
 * NotProjectAdminError (403). Returns the project id. */
async function resolveManageableProject(
  projectKey: string,
  ctx: WorkspaceContext,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const key = projectKey.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(ctx.workspaceId, key, tx);
  if (!project) throw new ProjectNotFoundError(projectKey);
  await projectAccessService.assertCanManage(project.id, ctx, tx);
  return project.id;
}

function jsonActions(actions: AutomationActionConfig[]): Prisma.InputJsonValue {
  return actions as unknown as Prisma.InputJsonValue;
}

function jsonTrigger(config: AutomationTriggerConfig): Prisma.InputJsonValue {
  return config as unknown as Prisma.InputJsonValue;
}

export const automationRulesService = {
  /** List a project's rules (admin-only). Bounded by the per-project cap. */
  async list(projectKey: string, ctx: WorkspaceContext): Promise<AutomationRuleDto[]> {
    return withWorkspaceContext(ctx, async (tx) => {
      const projectId = await resolveManageableProject(projectKey, ctx, tx);
      const rows = await automationRuleRepository.listByProject(projectId, tx);
      return rows.map(toAutomationRuleDto);
    });
  },

  /** Read one rule (admin-only). 404 if it isn't this project's. */
  async get(projectKey: string, ruleId: string, ctx: WorkspaceContext): Promise<AutomationRuleDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const projectId = await resolveManageableProject(projectKey, ctx, tx);
      const row = await automationRuleRepository.findByIdInProject(ruleId, projectId, tx);
      if (!row) throw new AutomationRuleNotFoundError(ruleId);
      return toAutomationRuleDto(row);
    });
  },

  /** Create a rule (admin-only). Owner = the creating admin (the rule actor —
   * the recorded 6.6 deviation). Enforces the 100-rule per-project cap. New
   * rules are enabled by default (the Jira default). */
  async create(
    projectKey: string,
    input: AutomationRuleWriteInput,
    ctx: WorkspaceContext,
  ): Promise<AutomationRuleDto> {
    const normalized = normalizeRule(input);
    return withWorkspaceContext(ctx, async (tx) => {
      const projectId = await resolveManageableProject(projectKey, ctx, tx);
      const count = await automationRuleRepository.countByProject(projectId, tx);
      if (count >= AUTOMATION_RULES_PER_PROJECT_CAP) {
        throw new AutomationRuleLimitError(AUTOMATION_RULES_PER_PROJECT_CAP);
      }
      const row = await automationRuleRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId,
          ownerId: ctx.userId,
          name: normalized.name,
          enabled: true,
          triggerType: normalized.triggerType,
          triggerConfig: jsonTrigger(normalized.triggerConfig),
          conditionAst: normalized.conditionEnvelope,
          actions: jsonActions(normalized.actions),
        },
        tx,
      );
      return toAutomationRuleDto(row);
    });
  },

  /** Replace a rule's content (admin-only): name, trigger, condition, actions.
   * Does NOT touch `enabled` or the failure counter (that's `setEnabled`). */
  async update(
    projectKey: string,
    ruleId: string,
    input: AutomationRuleWriteInput,
    ctx: WorkspaceContext,
  ): Promise<AutomationRuleDto> {
    const normalized = normalizeRule(input);
    return withWorkspaceContext(ctx, async (tx) => {
      const projectId = await resolveManageableProject(projectKey, ctx, tx);
      const locked = await automationRuleRepository.lockByIdInProject(ruleId, projectId, tx);
      if (!locked) throw new AutomationRuleNotFoundError(ruleId);
      const row = await automationRuleRepository.update(
        ruleId,
        {
          name: normalized.name,
          triggerType: normalized.triggerType,
          triggerConfig: jsonTrigger(normalized.triggerConfig),
          conditionAst: normalized.conditionEnvelope,
          actions: jsonActions(normalized.actions),
        },
        tx,
      );
      return toAutomationRuleDto(row);
    });
  },

  /** Enable or disable a rule (admin-only). Enabling RESETS the
   * consecutive-failure counter (the verified Jira rule — a re-enabled rule
   * starts fresh against the auto-disable threshold). Disabling leaves the
   * count intact. */
  async setEnabled(
    projectKey: string,
    ruleId: string,
    enabled: boolean,
    ctx: WorkspaceContext,
  ): Promise<AutomationRuleDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const projectId = await resolveManageableProject(projectKey, ctx, tx);
      const locked = await automationRuleRepository.lockByIdInProject(ruleId, projectId, tx);
      if (!locked) throw new AutomationRuleNotFoundError(ruleId);
      const row = await automationRuleRepository.update(
        ruleId,
        enabled ? { enabled: true, consecutiveFailureCount: 0 } : { enabled: false },
        tx,
      );
      return toAutomationRuleDto(row);
    });
  },

  /** Delete a rule (admin-only). The execution audit log cascades (Prisma
   * onDelete). */
  async delete(projectKey: string, ruleId: string, ctx: WorkspaceContext): Promise<void> {
    return withWorkspaceContext(ctx, async (tx) => {
      const projectId = await resolveManageableProject(projectKey, ctx, tx);
      const locked = await automationRuleRepository.lockByIdInProject(ruleId, projectId, tx);
      if (!locked) throw new AutomationRuleNotFoundError(ruleId);
      await automationRuleRepository.delete(ruleId, tx);
    });
  },
};
