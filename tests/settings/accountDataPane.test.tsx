// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderToHtml } from '../helpers/serverPageHarness';
import {
  ACCOUNT_SETTINGS_NAV,
  ACCOUNT_SETTINGS_NAV_GROUP_ORDER,
  ACCOUNT_SETTINGS_ROUTES,
  groupAccountSettingsNav,
  isAccountSettingsEntryActive,
} from '@/lib/settings/accountSettingsNav';
import type { AccountErasurePreviewDTO } from '@/lib/dto/accountErasure';

// The `Data › Data & privacy` pane (Story 8.4 · Subtask MOTIR-1136) — the route,
// its rail entry, and the deletion card's BLOCKED state.
//
// Two things this suite owns that no sibling does:
//
//  1. THE ACCESS PATH. The registry assertions below are additions, not edits:
//     `tests/settings/accountSettingsNav.test.ts` already pairs the filesystem
//     against the registry in both directions, so the route↔entry totality is
//     covered there and unchanged. What is asserted here is the design's own
//     argument — a FOURTH group, ordered LAST, because the rail renders groups
//     in array order and an irreversible account action appended to `general`
//     would land second overall, three rows above the language picker.
//
//  2. ⚠️ THE BLOCK IS A READ, NEVER A CAUGHT ERROR. Design DECISION 5 and the
//     card's own acceptance criterion: the blocked state must be rendered
//     "without the delete write ever being invoked". That is asserted here by
//     making every deletion-side entry point THROW if it is called, and then
//     rendering the pane to completion — so a pane that reached the refusal by
//     calling delete and catching `LastOrgOwnerError` fails rather than passes.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { previewAccountErasure } = vi.hoisted(() => ({ previewAccountErasure: vi.fn() }));
const { getLatestExportForUser } = vi.hoisted(() => ({ getLatestExportForUser: vi.fn() }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

/** Every write the erasure flow owns. Called ⇒ the pane took the wrong route. */
const deletionWrites = vi.hoisted(() => ({
  scheduleAccountDeletion: vi.fn(() => {
    throw new Error('the pane must not schedule a deletion');
  }),
  cancelAccountDeletion: vi.fn(() => {
    throw new Error('the pane must not cancel a deletion');
  }),
  cancelAccountDeletionIfScheduled: vi.fn(() => {
    throw new Error('the pane must not cancel a deletion');
  }),
}));

// ⚠️ A READ, AND IT IS NO LONGER A THROW (amended by MOTIR-3704). This stub
// used to raise *"the scheduled state is MOTIR-3704, not this card"*, which was
// true when MOTIR-1136 wrote it and is the card now running: the pane reads the
// open request so it can render EITHER the delete card or the scheduled state.
// It is deliberately NOT a member of `deletionWrites` above — that object is
// *"every WRITE the erasure flow owns"*, and folding a read into it would make
// the *"never invokes the delete write"* assertion below quietly weaker the
// moment the pane started calling it. `null` here = no deletion scheduled,
// which is what every case in THIS suite is about; the scheduled state has its
// own suite (`accountDeletionBanner.test.tsx`).
const findOpenDeletion = vi.hoisted(() => vi.fn(async () => null));
const { assertNotLastOwner } = vi.hoisted(() => ({
  assertNotLastOwner: vi.fn(() => {
    throw new Error('the pane must READ the block, not call the guard and catch its error');
  }),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}));
// `getTranslations` is next-intl's SERVER entry, and under happy-dom next-intl
// resolves to its client build. Bind a real translator over the real `en`
// catalogue rather than echoing keys back: the criterion is that the pane NAMES
// the organization and its member count, and a key-echo stub would assert
// nothing about either.
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    // `getLocale` joins the mock with MOTIR-3704: the pane now formats the
    // erasure date, and a date is a function of the locale.
    getLocale: async () => 'en',
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/services/accountErasureService', () => ({
  accountErasureService: { previewAccountErasure },
}));
vi.mock('@/lib/services/dataExportService', () => ({
  dataExportService: { getLatestExportForUser },
}));
vi.mock('@/lib/services/accountDeletionService', () => ({
  accountDeletionService: { ...deletionWrites, findOpenDeletion },
}));
vi.mock('@/lib/services/organizationsService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/organizationsService')>()),
  assertNotLastOwner,
}));
// The Server Action the export card calls. Importing the real module pulls
// `next/cache` into a unit render; its own behaviour is covered by
// `tests/export/dataExportLatest.test.ts`.
vi.mock('@/app/(authed)/settings/account/data/actions', () => ({
  requestDataExportAction: vi.fn(async () => ({ ok: true, started: true })),
}));

const ORG = { id: 'org_moooon', name: 'moooon', memberCount: 6 };

/** A preview with nothing to lose and nothing blocking — the ordinary reader. */
function emptyPreview(): AccountErasurePreviewDTO {
  return {
    blocked: false,
    blockingOrganization: null,
    deleted: {
      credentials: 1,
      passkeys: 0,
      twoFactorEnrolments: 0,
      apiTokens: 0,
      dataExports: 0,
      soleMemberWorkspaces: [],
      projects: 0,
      workItems: 0,
    },
    anonymised: { comments: 0, workItems: 0 },
    kept: ['billing_records', 'backups'],
  };
}

async function renderPane(): Promise<string> {
  const mod = await import('@/app/(authed)/settings/account/data/page');
  return renderToHtml(await mod.default());
}

// ⚠️ WARM THE FIRST RENDER HERE, NOT ON THE FIRST TEST THAT RENDERS. Measured on
// an idle box: the first `renderPane()` costs **6.5 s** and every later one costs
// 7-16 ms. The cost is NOT `react-dom/server.edge` — warming that alone moved
// nothing — it is transforming this page's whole import graph (the export card,
// the design system, lucide, next-intl) on the first `import`. Left where it
// falls, that one-time cost sits under the 15 s `testTimeout` and blows it under
// sibling load (observed on this box) and on CI's slower runner. Paid in a hook it
// sits under the larger `hookTimeout`, and what the tests then measure is the page
// rather than the module registry.
beforeAll(async () => {
  getSession.mockResolvedValue({ user: { id: 'warm', email: 'warm@example.com' } });
  previewAccountErasure.mockResolvedValue(emptyPreview());
  getLatestExportForUser.mockResolvedValue(null);
  findOpenDeletion.mockResolvedValue(null);
  await renderPane();
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1', email: 'reader@example.com' } });
  previewAccountErasure.mockResolvedValue(emptyPreview());
  getLatestExportForUser.mockResolvedValue(null);
  findOpenDeletion.mockResolvedValue(null);
});

afterEach(cleanup);

describe('the access path — a FOURTH rail group, ordered LAST', () => {
  it('adds `data` as the last group in the rail order', () => {
    expect(ACCOUNT_SETTINGS_NAV_GROUP_ORDER.at(-1)).toBe('data');
    // Not merely present — LAST. An entry appended to `general` would render
    // SECOND overall, which is the placement the design rejects by name.
    expect(ACCOUNT_SETTINGS_NAV_GROUP_ORDER).toEqual([
      'general',
      'preferences',
      'security',
      'data',
    ]);
  });

  it('holds exactly one entry, and it is the pane', () => {
    const groups = groupAccountSettingsNav(ACCOUNT_SETTINGS_NAV);
    expect(groups.at(-1)?.group).toBe('data');
    expect(groups.at(-1)?.entries.map((entry) => entry.id)).toEqual(['data']);

    const entry = ACCOUNT_SETTINGS_NAV.find((e) => e.id === 'data')!;
    expect(entry.href).toBe('/settings/account/data');
    expect(entry.labelKey).toBe('data');
    // A real route, not a reserved "Soon" slot: the pane ships with its entry.
    expect(entry.placeholder).toBeUndefined();
    expect(ACCOUNT_SETTINGS_ROUTES).toContainEqual(entry);
  });

  it('is active on its own route and on no sibling', () => {
    const entry = ACCOUNT_SETTINGS_NAV.find((e) => e.id === 'data')!;
    expect(isAccountSettingsEntryActive(entry, '/settings/account/data')).toBe(true);
    expect(isAccountSettingsEntryActive(entry, '/settings/account/profile')).toBe(false);
    expect(isAccountSettingsEntryActive(entry, '/settings/account')).toBe(false);
  });

  it('carries a label and a group label in the catalogue the rail reads', async () => {
    const en = (await import('@/messages/en.json')).default;
    const nav = en.settings.account.nav as Record<string, unknown> & {
      group: Record<string, string>;
    };
    expect(nav.data).toBe('Data & privacy');
    expect(nav.group.data).toBe('Data');
  });
});

describe('the pane at rest', () => {
  it('renders the two cards and the mailbox route', async () => {
    const html = await renderPane();
    expect(html).toContain('Data &amp; privacy');
    expect(html).toContain('Export your data');
    expect(html).toContain('Delete your account');
    // The pane is not the only route — correction, restriction and objection
    // have no control here, and the Privacy Policy publishes a mailbox.
    expect(html).toContain('privacy@motir.co');
  });

  it('redirects an anonymous request to /sign-in', async () => {
    getSession.mockResolvedValue(null);
    const mod = await import('@/app/(authed)/settings/account/data/page');
    await expect(mod.default()).rejects.toThrow('NEXT_REDIRECT:/sign-in');
  });

  it('leaves the delete control ENABLED when nothing blocks', async () => {
    const html = await renderPane();
    expect(html).toContain('Motir will show you exactly what is deleted');
    expect(html).not.toContain('Action needed');
  });
});

describe('⚠️ the BLOCKED state — read at rest, never raised at submit', () => {
  beforeEach(() => {
    previewAccountErasure.mockResolvedValue({
      ...emptyPreview(),
      blocked: true,
      blockingOrganization: ORG,
      deleted: {
        ...emptyPreview().deleted,
        soleMemberWorkspaces: [
          { id: 'ws_1', name: 'Solo' },
          { id: 'ws_2', name: 'Scratch' },
        ],
      },
    });
  });

  it('names the organization, shows its member count, and links to its Members page', async () => {
    const html = await renderPane();
    expect(html).toContain('moooon');
    expect(html).toContain('6 members');
    expect(html).toContain('you are the only owner');
    expect(html).toContain('/settings/organization/members');
    expect(html).toContain('Action needed');
  });

  it('renders the Delete control DISABLED, with the reason beside it', async () => {
    const html = await renderPane();
    expect(html).toContain('Available once every organization you own has another owner.');
    // The shipped Button renders `disabled` on the element itself.
    expect(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Delete account/.test(html)).toBe(
      true,
    );
  });

  it('⚠️ never invokes the delete write, nor the guard whose error it would catch', async () => {
    await renderPane();
    // The whole criterion: the refusal came from the PREVIEW's answer, not from
    // trying the action and translating `LastOrgOwnerError`. A reader must not
    // type their own email address into a form that was always going to refuse.
    expect(previewAccountErasure).toHaveBeenCalledWith('u1');
    expect(assertNotLastOwner).not.toHaveBeenCalled();
    for (const write of Object.values(deletionWrites)) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('says workspaces are NOT a second block, and states the escape', async () => {
    const html = await renderPane();
    // With an organization block on screen a reader has every reason to assume
    // their sole-membership workspaces are another one. They are not:
    // `deleteWorkspace` asserts membership and checks no role.
    expect(html).toContain('a block');
    expect(html).toContain('To keep one, invite somebody to it first.');
  });
});
