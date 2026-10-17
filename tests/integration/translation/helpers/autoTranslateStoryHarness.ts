import { vi } from 'vitest';
import {
  GET as settingsGet,
  PATCH as settingsPatch,
} from '@/app/api/projects/[key]/auto-translate/route';
import { POST as titlesRoute } from '@/app/api/projects/[key]/translate-titles/route';
import type { ProjectAutoTranslateSettingsDTO } from '@/lib/dto/projectAutoTranslateSettings';
import type { TitlesTranslateResponseDTO } from '@/lib/dto/workItemTranslation';
import type { Locale } from '@/lib/i18n/locales';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces';
import { createV1ProjectCaller } from '../../../fixtures/apiV1Fixtures';
import { createTestWorkItem } from '../../../fixtures/workItemFixtures';
import { adminDb } from '../../../helpers/adminDb';
import { memberOf, readerScope, type Reader } from './translationStoryFixture';

// The auto-translate story's harness (Story MOTIR-7738 · Subtask MOTIR-8835): the
// real settings and batch routes, driven as a given reader, over the translation
// story's own seams (`translationStoryFixture.ts`). The test FILES own the
// `vi.mock`s; everything they reach is imported here.

const BASE = 'http://localhost:3000';

export interface AutoStory {
  caller: Awaited<ReturnType<typeof createV1ProjectCaller>>;
  projectId: string;
  /** The project's key — the address every route here takes. */
  key: string;
  /** English-titled items, each recorded as English. */
  ids: string[];
  /** The workspace owner, reading in Korean. */
  owner: Reader;
}

/** A fresh tenant: a project holding `count` English titles, its owner reading Korean. */
export async function autoStory(count = 3): Promise<AutoStory> {
  const caller = await createV1ProjectCaller({ scopes: ['read'] });
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const item = await createTestWorkItem(caller.fixture, {
      kind: 'task',
      title: `Build export number ${i}`,
    });
    await adminDb.workItem.update({ where: { id: item.id }, data: { titleLanguage: 'en' } });
    ids.push(item.id);
  }
  return {
    caller,
    projectId: caller.fixture.projectId,
    key: caller.projectKey,
    ids,
    owner: { ctx: caller.ctx as WorkspaceContext, locale: 'ko' },
  };
}

/** Another workspace member, who IS a member of the project, reading in `locale`. */
export async function readerIn(s: AutoStory, email: string, locale: Locale): Promise<Reader> {
  return { ctx: await memberOf(s.caller.fixture, email), locale };
}

/**
 * A workspace member with NO role on the project, after the project is switched to
 * members-only access: they cannot open it.
 */
export async function outsiderOf(s: AutoStory, email: string, locale: Locale): Promise<Reader> {
  await projectMembersService.setAccessMode({
    key: s.key,
    actorUserId: s.owner.ctx.userId,
    ctx: s.owner.ctx,
    mode: 'members',
  });
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: email,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: s.owner.ctx.workspaceId });
  return { ctx: { userId: user.id, workspaceId: s.owner.ctx.workspaceId }, locale };
}

const params = (key: string) => ({ params: Promise.resolve({ key }) });

/** `PATCH …/auto-translate`, as `reader`. */
export function flip(reader: Reader, s: AutoStory, on: boolean) {
  return readerScope.run(reader, async () => {
    const res = await settingsPatch(
      new Request(`${BASE}/api/projects/${s.key}/auto-translate`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoTranslateWorkContent: on }),
      }),
      params(s.key),
    );
    return { status: res.status, body: (await res.json()) as ProjectAutoTranslateSettingsDTO };
  });
}

/** `GET …/auto-translate`, as `reader`. */
export function readSwitch(reader: Reader, s: AutoStory) {
  return readerScope.run(reader, async () => {
    const res = await settingsGet(
      new Request(`${BASE}/api/projects/${s.key}/auto-translate`),
      params(s.key),
    );
    return { status: res.status, body: (await res.json()) as ProjectAutoTranslateSettingsDTO };
  });
}

/** `POST …/translate-titles`, as `reader`: the batch door a browsing surface calls. */
export function titles(reader: Reader, s: AutoStory, workItemIds: string[] = s.ids) {
  return readerScope.run(reader, async () => {
    const res = await titlesRoute(
      new Request(`${BASE}/api/projects/${s.key}/translate-titles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workItemIds }),
      }),
      params(s.key),
    );
    return { status: res.status, body: (await res.json()) as TitlesTranslateResponseDTO };
  });
}

/** The project's STORED switch, read around the application. */
export async function switchOf(s: AutoStory): Promise<boolean> {
  return (await adminDb.project.findUniqueOrThrow({ where: { id: s.projectId } }))
    .autoTranslateWorkContent;
}

/** The project's change trail, newest first, read around the application. */
export const trail = (s: AutoStory) =>
  adminDb.projectAutoTranslateChange.findMany({
    where: { projectId: s.projectId },
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
  });

/** Turn the switch on directly, so a case about the batch does not also test the flip. */
export async function enable(s: AutoStory, on = true): Promise<void> {
  await adminDb.project.update({
    where: { id: s.projectId },
    data: { autoTranslateWorkContent: on },
  });
}

/** Run a case with cloud billing on or off (the paywall only applies on cloud). */
export function cloudBilling(on: boolean): void {
  vi.stubEnv('MOTIR_CLOUD', on ? 'true' : '');
}

/** `[ko] Build export number 1`-style text, as the mock's default success echoes it. */
export const echoedTitle = (lang: string, n: number) => `[${lang}] Build export number ${n}`;

/** How many kept translations exist, of any field, across every tenant. */
export const rowsOfTitles = () => adminDb.workItemTranslation.count();
