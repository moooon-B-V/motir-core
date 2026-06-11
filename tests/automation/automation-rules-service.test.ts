import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { automationRulesService } from '@/lib/services/automationRulesService';
import type { AutomationRuleWriteInput } from '@/lib/services/automationRulesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { automationRuleRepository } from '@/lib/repositories/automationRuleRepository';
import { ProjectNotFoundError, NotProjectAdminError } from '@/lib/projects/errors';
import { FilterValidationError } from '@/lib/filters/errors';
import {
  AutomationActionLimitError,
  AutomationRuleLimitError,
  AutomationRuleNotFoundError,
  InvalidAutomationActionConfigError,
  InvalidAutomationRuleError,
  UnknownAutomationTriggerError,
} from '@/lib/automation/errors';
import {
  AUTOMATION_ACTIONS_PER_RULE_CAP,
  AUTOMATION_RULES_PER_PROJECT_CAP,
} from '@/lib/automation/constants';
import { encodeFilterParam, type FilterAst, type FilterCondition } from '@/lib/filters/ast';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Service-layer tests for automationRulesService (Story 6.6 · Subtask 6.6.1).
// Real Postgres, no DB mocks; truncateAuthTables CASCADEs workspace → project →
// automation_rule → automation_rule_execution between tests. Covers: CRUD, the
// admin-gating matrix (the whole surface is admin-only), the caps (100 rules /
// 10 actions / 20 condition rows), the condition envelope round-trip + the
// stored-degraded read, the stale-referent "degrades, never crashes" rule, and
// the execution-log cascade on delete.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

/** A workspace owner + project, plus a member at every project role and an
 * outsider — the full gating cast. */
async function makeScenario(slug: string) {
  const owner = await usersService.createUser({
    email: `owner-${slug}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const key = project.identifier;
  const ownerCtx = ctxFor(owner.id, workspace.id);

  async function memberAt(role: 'admin' | 'member' | 'viewer', label: string) {
    const user = await usersService.createUser({
      email: `${label}-${slug}@example.com`,
      password: PASSWORD,
      name: label,
    });
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: workspace.id,
      role: 'member',
    });
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: user.id,
      role,
    });
    return user;
  }

  const admin = await memberAt('admin', 'admin');
  const member = await memberAt('member', 'member');
  const viewer = await memberAt('viewer', 'viewer');

  // A plain workspace member with NO project membership — on an `open` project
  // they browse + edit, but never manage (the admin gate is strictly above edit).
  const plainWs = await usersService.createUser({
    email: `plain-${slug}@example.com`,
    password: PASSWORD,
    name: 'Plain',
  });
  await workspacesService.addMember({
    userId: plainWs.id,
    workspaceId: workspace.id,
    role: 'member',
  });

  // Not a workspace member at all — the project is hidden (404).
  const outsider = await usersService.createUser({
    email: `outsider-${slug}@example.com`,
    password: PASSWORD,
    name: 'Outsider',
  });

  return {
    workspace,
    project,
    key,
    owner,
    ownerCtx,
    admin,
    member,
    viewer,
    plainWs,
    outsider,
  };
}

function ruleInput(overrides: Partial<AutomationRuleWriteInput> = {}): AutomationRuleWriteInput {
  return {
    name: 'When a bug is done, set priority high',
    triggerType: 'transitioned',
    triggerConfig: { toStatusId: 's-done' },
    conditionFilterParam: null,
    actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
    ...overrides,
  };
}

function conditionParam(conditions: FilterCondition[]): string {
  const ast: FilterAst = { combinator: 'and', conditions };
  return encodeFilterParam(ast);
}

describe('create', () => {
  it('an owner creates a rule (enabled, owned by the creator) and it persists', async () => {
    const s = await makeScenario('create');
    const rule = await automationRulesService.create(s.key, ruleInput(), s.ownerCtx);

    expect(rule.name).toBe('When a bug is done, set priority high');
    expect(rule.enabled).toBe(true);
    expect(rule.owner.id).toBe(s.owner.id);
    expect(rule.trigger).toEqual({
      type: 'transitioned',
      fromStatusId: null,
      toStatusId: 's-done',
    });
    expect(rule.actions).toEqual([{ type: 'set_field', field: 'priority', value: 'high' }]);
    expect(rule.condition).toEqual({ combinator: 'and', conditions: [] });
    expect(rule.conditionError).toBeNull();
    expect(rule.consecutiveFailureCount).toBe(0);
    expect(rule.autoDisableThreshold).toBe(10);

    const persisted = await automationRuleRepository.findByIdInProject(rule.id, s.project.id);
    expect(persisted?.ownerId).toBe(s.owner.id);
  });

  it('a project admin creates a rule attributed to themselves (the rule actor)', async () => {
    const s = await makeScenario('admincreate');
    const rule = await automationRulesService.create(
      s.key,
      ruleInput({ name: 'admin rule' }),
      ctxFor(s.admin.id, s.workspace.id),
    );
    expect(rule.owner.id).toBe(s.admin.id);
  });

  it('round-trips a built-in condition (decoded AST on read)', async () => {
    const s = await makeScenario('cond');
    const param = conditionParam([{ field: 'kind', operator: 'is_any_of', value: ['bug'] }]);
    const rule = await automationRulesService.create(
      s.key,
      ruleInput({ conditionFilterParam: param }),
      s.ownerCtx,
    );
    expect(rule.condition).toEqual({
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    });
    expect(rule.conditionError).toBeNull();
  });

  it('rejects an unknown trigger type as a typed 422', async () => {
    const s = await makeScenario('badtrig');
    await expect(
      automationRulesService.create(s.key, ruleInput({ triggerType: 'exploded' }), s.ownerCtx),
    ).rejects.toBeInstanceOf(UnknownAutomationTriggerError);
  });

  it('rejects a malformed action config as a typed 422', async () => {
    const s = await makeScenario('badact');
    await expect(
      automationRulesService.create(
        s.key,
        ruleInput({ actions: [{ type: 'set_field', field: 'priority', value: 'urgent' }] }),
        s.ownerCtx,
      ),
    ).rejects.toBeInstanceOf(InvalidAutomationActionConfigError);
  });

  it('rejects an empty action list and a non-array', async () => {
    const s = await makeScenario('noact');
    await expect(
      automationRulesService.create(s.key, ruleInput({ actions: [] }), s.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidAutomationRuleError);
    await expect(
      automationRulesService.create(s.key, ruleInput({ actions: 'nope' }), s.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidAutomationRuleError);
  });

  it('rejects a blank / over-long name', async () => {
    const s = await makeScenario('badname');
    await expect(
      automationRulesService.create(s.key, ruleInput({ name: '   ' }), s.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidAutomationRuleError);
    await expect(
      automationRulesService.create(s.key, ruleInput({ name: 'x'.repeat(200) }), s.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidAutomationRuleError);
    await expect(
      automationRulesService.create(
        s.key,
        ruleInput({ name: 123 as unknown as string }),
        s.ownerCtx,
      ),
    ).rejects.toBeInstanceOf(InvalidAutomationRuleError);
  });

  it('rejects a smuggled unknown field id in the condition AST (the 6.1 injection posture)', async () => {
    const s = await makeScenario('inject');
    const param = conditionParam([
      { field: 'totally_bogus' as FilterCondition['field'], operator: 'is_any_of', value: ['x'] },
    ]);
    await expect(
      automationRulesService.create(s.key, ruleInput({ conditionFilterParam: param }), s.ownerCtx),
    ).rejects.toBeInstanceOf(FilterValidationError);
  });

  it('rejects an over-cap (21-row) condition as a typed 422', async () => {
    const s = await makeScenario('rowcap');
    const rows: FilterCondition[] = Array.from({ length: 21 }, () => ({
      field: 'kind',
      operator: 'is_any_of',
      value: ['bug'],
    }));
    await expect(
      automationRulesService.create(
        s.key,
        ruleInput({ conditionFilterParam: conditionParam(rows) }),
        s.ownerCtx,
      ),
    ).rejects.toBeInstanceOf(FilterValidationError);
  });

  it('an OPEN referent (deleted status / label) degrades — create does NOT crash', async () => {
    const s = await makeScenario('stale');
    // A transition to a status id that does not exist + a condition on a label
    // id that does not exist: both are OPEN ids (the 6.1 stale-referent rule),
    // so validation accepts them and the rule persists (matched at execution).
    const param = conditionParam([{ field: 'lbl', operator: 'is_any_of', value: ['ghost-label'] }]);
    const rule = await automationRulesService.create(
      s.key,
      ruleInput({
        triggerType: 'created',
        triggerConfig: {},
        conditionFilterParam: param,
        actions: [{ type: 'transition', toStatusId: 'ghost-status' }],
      }),
      s.ownerCtx,
    );
    expect(rule.actions).toEqual([{ type: 'transition', toStatusId: 'ghost-status' }]);
    expect(rule.conditionError).toBeNull();
  });
});

describe('admin gating (the whole surface is admin-only)', () => {
  it('a workspace owner and a project admin may create; member / viewer / plain-member get 403', async () => {
    const s = await makeScenario('gate');
    // pass
    await expect(
      automationRulesService.create(s.key, ruleInput(), ctxFor(s.admin.id, s.workspace.id)),
    ).resolves.toBeTruthy();
    // 403 — browsable but not admin
    for (const u of [s.member, s.viewer, s.plainWs]) {
      await expect(
        automationRulesService.create(s.key, ruleInput(), ctxFor(u.id, s.workspace.id)),
      ).rejects.toBeInstanceOf(NotProjectAdminError);
    }
  });

  it('an outsider (non-workspace-member) and an unknown key get 404 (hidden)', async () => {
    const s = await makeScenario('hide');
    await expect(
      automationRulesService.list(s.key, ctxFor(s.outsider.id, s.workspace.id)),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(automationRulesService.list('NOPE', s.ownerCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('list / get / update / delete / setEnabled all enforce the admin gate (member → 403)', async () => {
    const s = await makeScenario('gateall');
    const rule = await automationRulesService.create(s.key, ruleInput(), s.ownerCtx);
    const memberCtx = ctxFor(s.member.id, s.workspace.id);
    await expect(automationRulesService.list(s.key, memberCtx)).rejects.toBeInstanceOf(
      NotProjectAdminError,
    );
    await expect(automationRulesService.get(s.key, rule.id, memberCtx)).rejects.toBeInstanceOf(
      NotProjectAdminError,
    );
    await expect(
      automationRulesService.update(s.key, rule.id, ruleInput(), memberCtx),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    await expect(
      automationRulesService.setEnabled(s.key, rule.id, false, memberCtx),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    await expect(automationRulesService.delete(s.key, rule.id, memberCtx)).rejects.toBeInstanceOf(
      NotProjectAdminError,
    );
  });
});

describe('list + get', () => {
  it('lists a project rules newest-first and gets one by id', async () => {
    const s = await makeScenario('listget');
    const a = await automationRulesService.create(s.key, ruleInput({ name: 'A' }), s.ownerCtx);
    const b = await automationRulesService.create(s.key, ruleInput({ name: 'B' }), s.ownerCtx);
    const list = await automationRulesService.list(s.key, s.ownerCtx);
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);

    // A direct repo read (no tx — the read-only `db` path) returns the same set.
    const direct = await automationRuleRepository.listByProject(s.project.id);
    expect(direct.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    const got = await automationRulesService.get(s.key, a.id, s.ownerCtx);
    expect(got.name).toBe('A');
  });

  it('get of an unknown rule id → 404', async () => {
    const s = await makeScenario('getmiss');
    await expect(automationRulesService.get(s.key, 'nope', s.ownerCtx)).rejects.toBeInstanceOf(
      AutomationRuleNotFoundError,
    );
  });

  it('a rule is not visible through ANOTHER project key (404, not cross-project leak)', async () => {
    const s = await makeScenario('crossp');
    const rule = await automationRulesService.create(s.key, ruleInput(), s.ownerCtx);
    const other = await projectsService.createProject({
      workspaceId: s.workspace.id,
      actorUserId: s.owner.id,
      name: 'Other',
    });
    await expect(
      automationRulesService.get(other.identifier, rule.id, s.ownerCtx),
    ).rejects.toBeInstanceOf(AutomationRuleNotFoundError);
  });
});

describe('update', () => {
  it('replaces a rule content (name, trigger, condition, actions) without touching enabled', async () => {
    const s = await makeScenario('update');
    const rule = await automationRulesService.create(s.key, ruleInput(), s.ownerCtx);
    await automationRulesService.setEnabled(s.key, rule.id, false, s.ownerCtx);

    const updated = await automationRulesService.update(
      s.key,
      rule.id,
      ruleInput({
        name: 'renamed',
        triggerType: 'field_changed',
        triggerConfig: { field: 'assignee' },
        actions: [{ type: 'set_field', field: 'assignee', value: null }],
      }),
      s.ownerCtx,
    );
    expect(updated.name).toBe('renamed');
    expect(updated.trigger).toEqual({ type: 'field_changed', field: 'assignee' });
    expect(updated.actions).toEqual([{ type: 'set_field', field: 'assignee', value: null }]);
    // enabled stays whatever it was (disabled) — update is content-only.
    expect(updated.enabled).toBe(false);
  });

  it('update of an unknown rule id → 404', async () => {
    const s = await makeScenario('upmiss');
    await expect(
      automationRulesService.update(s.key, 'nope', ruleInput(), s.ownerCtx),
    ).rejects.toBeInstanceOf(AutomationRuleNotFoundError);
  });
});

describe('enable / disable', () => {
  it('disabling leaves the failure counter; enabling resets it to 0', async () => {
    const s = await makeScenario('toggle');
    const rule = await automationRulesService.create(s.key, ruleInput(), s.ownerCtx);
    // Simulate the engine having recorded failures (6.6.2 writes these).
    await db.automationRule.update({
      where: { id: rule.id },
      data: { consecutiveFailureCount: 5 },
    });

    const disabled = await automationRulesService.setEnabled(s.key, rule.id, false, s.ownerCtx);
    expect(disabled.enabled).toBe(false);
    expect(disabled.consecutiveFailureCount).toBe(5); // untouched

    const enabled = await automationRulesService.setEnabled(s.key, rule.id, true, s.ownerCtx);
    expect(enabled.enabled).toBe(true);
    expect(enabled.consecutiveFailureCount).toBe(0); // reset
  });

  it('setEnabled on an unknown rule id → 404', async () => {
    const s = await makeScenario('togmiss');
    await expect(
      automationRulesService.setEnabled(s.key, 'nope', true, s.ownerCtx),
    ).rejects.toBeInstanceOf(AutomationRuleNotFoundError);
  });
});

describe('delete', () => {
  it('deletes a rule and CASCADES its execution audit log', async () => {
    const s = await makeScenario('del');
    const rule = await automationRulesService.create(s.key, ruleInput(), s.ownerCtx);
    // Seed an execution row (6.6.2 writes these) to prove the cascade.
    await db.automationRuleExecution.create({ data: { ruleId: rule.id, status: 'success' } });
    expect(await db.automationRuleExecution.count({ where: { ruleId: rule.id } })).toBe(1);

    await automationRulesService.delete(s.key, rule.id, s.ownerCtx);

    expect(await automationRuleRepository.findByIdInProject(rule.id, s.project.id)).toBeNull();
    expect(await db.automationRuleExecution.count({ where: { ruleId: rule.id } })).toBe(0);
  });

  it('delete of an unknown rule id → 404', async () => {
    const s = await makeScenario('delmiss');
    await expect(automationRulesService.delete(s.key, 'nope', s.ownerCtx)).rejects.toBeInstanceOf(
      AutomationRuleNotFoundError,
    );
  });
});

describe('caps', () => {
  it('the 11th action on a rule is a typed 422', async () => {
    const s = await makeScenario('actcap');
    const actions = Array.from({ length: AUTOMATION_ACTIONS_PER_RULE_CAP + 1 }, () => ({
      type: 'set_field',
      field: 'priority',
      value: 'low',
    }));
    await expect(
      automationRulesService.create(s.key, ruleInput({ actions }), s.ownerCtx),
    ).rejects.toBeInstanceOf(AutomationActionLimitError);
  });

  it('the 101st rule in a project is a typed 422', async () => {
    const s = await makeScenario('rulecap');
    // Bulk-seed the cap directly (the dev/CI role bypasses RLS), then the next
    // create through the service hits the limit.
    const rows = Array.from({ length: AUTOMATION_RULES_PER_PROJECT_CAP }, (_, i) => ({
      workspaceId: s.workspace.id,
      projectId: s.project.id,
      ownerId: s.owner.id,
      name: `seed-${i}`,
      triggerType: 'created' as const,
      triggerConfig: { type: 'created' } as Prisma.InputJsonValue,
      conditionAst: { v: 'v1', c: 'and', f: [] } as Prisma.InputJsonValue,
      actions: [{ type: 'set_field', field: 'priority', value: 'low' }] as Prisma.InputJsonValue,
    }));
    await db.automationRule.createMany({ data: rows });

    await expect(
      automationRulesService.create(s.key, ruleInput(), s.ownerCtx),
    ).rejects.toBeInstanceOf(AutomationRuleLimitError);
  });
});

describe('stored-condition degraded read (the durability rule)', () => {
  it('a structurally-corrupt stored envelope reads as a typed conditionError, not a crash', async () => {
    const s = await makeScenario('corrupt');
    const rule = await automationRulesService.create(s.key, ruleInput(), s.ownerCtx);
    await db.automationRule.update({
      where: { id: rule.id },
      data: { conditionAst: { not: 'an envelope' } as Prisma.InputJsonValue },
    });
    const got = await automationRulesService.get(s.key, rule.id, s.ownerCtx);
    expect(got.condition).toBeNull();
    expect(got.conditionError?.ok).toBe(false);
  });

  it('a decodable-but-registry-invalid stored envelope also degrades (unknown field id)', async () => {
    const s = await makeScenario('invalidstored');
    const rule = await automationRulesService.create(s.key, ruleInput(), s.ownerCtx);
    await db.automationRule.update({
      where: { id: rule.id },
      data: {
        conditionAst: {
          v: 'v1',
          c: 'and',
          f: [['bogus_field', 'is_any_of', ['x']]],
        } as Prisma.InputJsonValue,
      },
    });
    const got = await automationRulesService.get(s.key, rule.id, s.ownerCtx);
    expect(got.condition).toBeNull();
    expect(got.conditionError?.reason).toBe('invalid');
  });
});
