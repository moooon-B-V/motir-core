import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import type { RawUsageResponse } from '@/lib/ai/types';
import type { Locale } from '@/lib/i18n/locales';
import type { AiJobsFixture, SubmittedJob, TranslateJobOutcome } from '@/lib/test-ai-jobs-mock';
import { usersService } from '@/lib/services/usersService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces';
import { createTestWorkItem, type WorkItemFixture } from '../../../fixtures/workItemFixtures';
import { adminDb } from '../../../helpers/adminDb';

// The seams the translation STORY test (Story MOTIR-7735 · MOTIR-8124) runs
// through: motir-ai replaced on the wire by the in-repo jobs mock
// (`lib/test-ai-jobs-mock.ts`), its job record read back as the charge count, and
// each request's reader and interface language carried per request.

export const ORIGIN = 'http://motir-ai.translation-story.test';

/** The credits one successful `translate` job adds to the test's usage block. */
export const UNIT = 6;

/** The AI figures the usage reply carries, which no translation may move. */
export const AI_TOTAL_SPEND = 147_520;

/** Who is asking, and in which interface language — per request, never shared. */
export interface Reader {
  ctx: WorkspaceContext;
  locale: Locale;
}

/** The reader of the request in flight (the route's session and locale read it). */
export const readerScope = new AsyncLocalStorage<Reader>();

/** The signed-in user `getSession` answers with (the usage route's gate). */
export const sessionUser = { current: null as { id: string; email: string } | null };

/** How the test's `/v1/usage` reply reports translation. */
export type UsageMode = 'reported' | 'absent' | 'zero';

export interface MotirAiSeam {
  agent: MockAgent;
  fixturePath: string;
  /** The `tenant.organizationId` of every `translate` submit, in order. */
  submittedOrgs: string[];
  usageMode: UsageMode;
  /** The balance the `/v1/usage` reply reports (the auto-translate story's credit knob). */
  balance: number;
  /** The status the subscription read answers — `null` is a free organisation. */
  subscriptionStatus: string | null;
  /** How many `/v1/usage` reads were served since the last {@link resetJobs}. */
  usageReads: number;
}

/** What the usage reply reports unless a case sets {@link MotirAiSeam.balance}. */
export const DEFAULT_BALANCE = 12_480;

/** Point the app at a mocked motir-ai and install the in-repo jobs mock on it. */
export async function installMotirAi(): Promise<MotirAiSeam> {
  const fixturePath = join(mkdtempSync(join(tmpdir(), 'motir-translation-story-')), 'jobs.json');
  writeFileSync(fixturePath, '{}');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixturePath);
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/localhost|127\.0\.0\.1/);
  setGlobalDispatcher(agent);
  const seam: MotirAiSeam = {
    agent,
    fixturePath,
    submittedOrgs: [],
    usageMode: 'reported',
    balance: DEFAULT_BALANCE,
    subscriptionStatus: null,
    usageReads: 0,
  };
  const { installAiJobsBoundaryMock, observeAiJobSubmit } = await import('@/lib/test-ai-jobs-mock');
  observeAiJobSubmit((raw) => {
    const body = JSON.parse(raw) as { jobKind?: string; tenant?: { organizationId?: string } };
    if (body.jobKind === 'translate') seam.submittedOrgs.push(body.tenant?.organizationId ?? '');
  });
  installAiJobsBoundaryMock(agent);
  installUsageReply(seam);
  installSubscriptionReply(seam);
  return seam;
}

function readJobs(seam: MotirAiSeam): AiJobsFixture {
  return JSON.parse(readFileSync(seam.fixturePath, 'utf8')) as AiJobsFixture;
}

/** Start a case from an empty job record. */
export function resetJobs(seam: MotirAiSeam): void {
  writeFileSync(seam.fixturePath, '{}');
  seam.submittedOrgs.length = 0;
  seam.usageMode = 'reported';
  seam.balance = DEFAULT_BALANCE;
  seam.subscriptionStatus = null;
  seam.usageReads = 0;
}

/** Declare the `translate` outcomes, one per submit attempt, KEEPING the record. */
export function script(seam: MotirAiSeam, translate: TranslateJobOutcome[]): void {
  writeFileSync(seam.fixturePath, JSON.stringify({ ...readJobs(seam), translate }));
}

/** Every `translate` submit the mock received, refused ones included, in order. */
export function translateSubmits(seam: MotirAiSeam): SubmittedJob[] {
  return (readJobs(seam).submitted ?? []).filter((s) => s.kind === 'translate');
}

/** The `translate` jobs motir-ai accepted — each one a model turn. */
export function translateJobs(seam: MotirAiSeam): SubmittedJob[] {
  return translateSubmits(seam).filter((s) => !s.refused);
}

/**
 * The units billed: one per accepted `translate` job whose declared outcome is a
 * success, none for a failed, hung or refused one — the rule motir-ai's ledger
 * follows (one debit per completed turn), read from the mock's own record.
 */
export function billedUnits(seam: MotirAiSeam): number {
  const queue = readJobs(seam).translate ?? [];
  return translateSubmits(seam).filter((s, i) => {
    const outcome = queue.length === 0 ? {} : queue[Math.min(i, queue.length - 1)]!;
    return !s.refused && (outcome.status ?? 'succeeded') === 'succeeded';
  }).length;
}

/** The org usage reply, its translation block derived from the billed units. */
function usageBody(seam: MotirAiSeam, coreOrganizationId: string): RawUsageResponse {
  const spend = billedUnits(seam) * UNIT;
  const translation =
    seam.usageMode === 'absent'
      ? {}
      : {
          translation:
            seam.usageMode === 'zero'
              ? { totalSpend: 0, monthSpend: 0 }
              : { totalSpend: spend, monthSpend: spend },
        };
  return {
    scope: 'org',
    coreOrganizationId,
    coreWorkspaceId: null,
    coreProjectId: null,
    balance: seam.balance,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 20_000 },
    totalSpend: AI_TOTAL_SPEND,
    monthSpend: 7_520,
    monthlyHistory: [{ yearMonth: '2026-10', credits: 7_520 }],
    perModel: [],
    recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
    ...translation,
  };
}

/**
 * `GET /v1/usage`, which the in-repo jobs mock does not serve. Registered on the
 * same origin, on a path the jobs mock never claims.
 */
function installUsageReply(seam: MotirAiSeam): void {
  seam.agent
    .get(ORIGIN)
    .intercept({ path: (p) => p.startsWith('/v1/usage'), method: 'GET' })
    .reply((req) => {
      seam.usageReads += 1;
      const org = new URL(`${ORIGIN}${req.path}`).searchParams.get('coreOrganizationId') ?? '';
      return {
        statusCode: 200,
        data: usageBody(seam, org),
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    })
    .persist();
}

/**
 * `GET /v1/stripe/subscription`, which `getOrgSubscription` makes beside the usage
 * read when an organisation's AI access is resolved (cloud billing on). Added for
 * the auto-translate story's credit verdict; a self-host build never asks.
 */
function installSubscriptionReply(seam: MotirAiSeam): void {
  seam.agent
    .get(ORIGIN)
    .intercept({ path: (p) => p.startsWith('/v1/stripe/subscription'), method: 'GET' })
    .reply(() => ({
      statusCode: 200,
      data: {
        status: seam.subscriptionStatus,
        currentPeriodEnd: null,
        priceId: null,
        planTier: null,
      },
      responseOptions: { headers: { 'content-type': 'application/json' } },
    }))
    .persist();
}

// ── the item and its readers ─────────────────────────────────────────────────

export const ZH = {
  title: '为所有客户构建导出功能',
  description: '导出需要包含所有字段，并且按日期排序。',
  explanation: '客户每周都需要这份报告来核对账目。',
  todos: [
    { text: '检查现有的导出代码', notes: '先阅读服务层的实现。' },
    { text: '编写新的日期排序', notes: '按创建日期升序排列。' },
  ],
} as const;

/** A task whose five field kinds — and both to-dos' two — are recorded Chinese. */
export async function seedChineseItem(fx: WorkItemFixture) {
  const item = await createTestWorkItem(fx, { kind: 'task', title: ZH.title });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      descriptionMd: ZH.description,
      explanationMd: ZH.explanation,
      titleLanguage: 'zh',
      descriptionLanguage: 'zh',
      explanationLanguage: 'zh',
    },
  });
  const todoIds: string[] = [];
  for (const t of ZH.todos) {
    const res = await workItemTodosService.addTodo(
      item.id,
      { text: t.text, notesMd: t.notes, languages: { text: 'zh', notes: 'zh' } },
      fx.ctx,
    );
    todoIds.push(res.todo.id);
  }
  return { item, todoIds };
}

/** Another member of the fixture's workspace (and so of its organisation). */
export async function memberOf(fx: WorkItemFixture, email: string): Promise<WorkspaceContext> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}
