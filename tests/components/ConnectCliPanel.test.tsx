// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ConnectCliPanel } from '@/app/(authed)/settings/account/_components/ConnectCliPanel';
import { ApiTokensManager } from '@/app/(authed)/settings/account/_components/ApiTokensManager';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { cliTokenLabel } from '@/lib/cliDevice/constants';
import { CLI_TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { truncateAuthTables } from '../helpers/db';

// The "Connect the CLI" panel (Subtask MOTIR-1869) — the only surface in the
// product that says the CLI exists. Three things are worth a test and one of them
// is not about React at all:
//
//   1. The panel renders both commands and each copies with the pane's existing
//      affordance (the CreateTokenModal clipboard + success Toast).
//   2. The commands are TRUE — asserted against the shipped CLI's own source and
//      package manifest, not from memory, so a rename in `packages/cli` fails HERE
//      rather than in a user's terminal.
//   3. The tie line's promise holds: a token minted by `motir login` really does
//      appear in the table below under its `CLI · <hostname>` label. That is
//      asserted against a token SEEDED through the real service and read back
//      through the same `listForUser` read the page uses — no hand-authored DTO.

const CLI_PKG_DIR = resolve(__dirname, '../../packages/cli');

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(cleanup);

describe('ConnectCliPanel', () => {
  it('renders both commands, the docs link and the present-tense tie line', () => {
    renderWithIntl(
      <ToastProvider>
        <ConnectCliPanel hasTokens />
      </ToastProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Connect the CLI' })).toBeTruthy();
    expect(screen.getByText('npm install -g @motir/cli')).toBeTruthy();
    // `motir login` appears in the snippet AND inside the prose, so scope the
    // snippet assertion to its copy control's row rather than a bare text match.
    expect(screen.getByLabelText('Copy sign-in command')).toBeTruthy();
    expect(screen.getByLabelText('Copy install command')).toBeTruthy();

    // The PUBLISHED guide, not a GitHub blob (MOTIR-2331). Still a literal, so
    // a future silent change fails here — and still the assertion the story
    // gate crosses with the real route tree, which is what stops the link and
    // the page from disagreeing about where the page lives.
    const guide = screen.getByRole('link', { name: 'Read the CLI guide' });
    expect(guide.getAttribute('href')).toBe('/docs/cli');
    // In-product now: the new-tab pair is this pane's mark for a link that
    // LEAVES the application, and this one does not.
    expect(guide.getAttribute('target')).toBeNull();
    expect(guide.getAttribute('rel')).toBeNull();

    // The revoke-to-disconnect relationship — the panel points at the pane's
    // EXISTING revoke rather than adding a second disconnect control.
    expect(screen.getByText(/revoking it there disconnects that terminal/i)).toBeTruthy();

    // Both prose bodies render as PROSE. Every string here is rich text, and a
    // `t.rich` call whose chunk names don't match the message's tags does not
    // throw — next-intl falls back to printing the raw key, which reads as
    // `settings.apiTokens.cli.next` on the page. Caught in the render check for
    // this card; asserted here so it cannot come back.
    expect(screen.getByText(/shows a short code and opens Motir in your browser/i)).toBeTruthy();
    expect(screen.getByText(/SSH sessions and containers use the same command/i)).toBeTruthy();
  });

  it('never falls back to a raw translation key', () => {
    const { container } = renderWithIntl(
      <ToastProvider>
        <ConnectCliPanel hasTokens />
      </ToastProvider>,
    );
    expect(container.textContent).not.toMatch(/settings\.apiTokens\./);
  });

  it('states the tie in the future tense while no token exists yet', () => {
    renderWithIntl(
      <ToastProvider>
        <ConnectCliPanel hasTokens={false} />
      </ToastProvider>,
    );

    expect(screen.getByText(/will appear below as/i)).toBeTruthy();
    expect(screen.queryByText(/revoking it there disconnects that terminal/i)).toBeNull();
  });

  it.each([
    { label: 'Copy install command', command: 'npm install -g @motir/cli' },
    { label: 'Copy sign-in command', command: 'motir login' },
  ])('copies $command and confirms it', async ({ label, command }) => {
    renderWithIntl(
      <ToastProvider>
        <ConnectCliPanel hasTokens />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByLabelText(label));

    expect(writeText).toHaveBeenCalledWith(command);
    // The copy confirmation is the pane's shipped success Toast.
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(screen.getByText('Paste it into your terminal and press enter.')).toBeTruthy();
  });
});

describe('a11y', () => {
  // Same shape as the sibling `/device` screen's sweep (device-approval.test.tsx,
  // MOTIR-1867): color-contrast is disabled because happy-dom has no layout engine
  // to compute real ratios — the design measured those directly (design-notes.md
  // § Token + a11y discipline). Everything structural — the copy buttons' names,
  // the link's name, heading order — is what this catches. `document.body` holds
  // only the island in a test, so the `<main>` landmark the shipped settings
  // layout always wraps the pane in is put back; without it axe reports `region`
  // for content that is never actually outside a landmark.
  const options = { rules: { 'color-contrast': { enabled: false } } } as const;

  it('the panel is axe-clean in both tie states', async () => {
    for (const hasTokens of [true, false]) {
      const main = document.createElement('main');
      document.body.appendChild(main);
      renderWithIntl(
        <ToastProvider>
          <ConnectCliPanel hasTokens={hasTokens} />
        </ToastProvider>,
        { container: main },
      );

      const result = await axe.run(document.body, options);
      expect(result.violations.map((v) => v.id)).toEqual([]);
      cleanup();
      main.remove();
    }
  }, 30_000);
});

describe('the commands the panel prints are the shipped ones', () => {
  it('installs the package name `packages/cli` actually publishes', () => {
    const manifest = JSON.parse(readFileSync(resolve(CLI_PKG_DIR, 'package.json'), 'utf8')) as {
      name: string;
    };

    renderWithIntl(
      <ToastProvider>
        <ConnectCliPanel hasTokens />
      </ToastProvider>,
    );
    expect(screen.getByText(`npm install -g ${manifest.name}`)).toBeTruthy();
  });

  it('prints `motir login` — a TOP-LEVEL command, not the `auth login` subcommand', async () => {
    // RE-POINTED, not weakened, by MOTIR-2324: `program.ts` no longer spells a
    // command's name, arguments, description or group inline — it builds them
    // from `commandCatalog.ts`, so the old source-regex for
    // `program.command('login')` now matches nothing, and a regex for
    // `register(program, 'login')` would only have moved the same brittleness
    // one refactor along.
    //
    // The record IS the registration, and it is plain data, so read the fact
    // instead of the syntax. This is strictly stronger than the regex: it
    // distinguishes the top-level `login` from the `auth login` subcommand by
    // its PATH rather than by which identifier the call was chained off, and it
    // sees the argument signature rather than inferring it from a name string.
    const { COMMAND_CATALOG } = await import('../../packages/cli/src/commandCatalog');

    const login = COMMAND_CATALOG.find((entry) => entry.path === 'login');
    expect(login, 'the top-level `login` command the panel tells people to run').toBeDefined();
    // `auth login` also exists (the `--token` path CI keeps using); the panel
    // prints the other one, and these two lines are what tell them apart.
    expect(COMMAND_CATALOG.some((entry) => entry.path === 'auth login')).toBe(true);
    expect(login!.helpGroup).not.toBeNull();

    // …and it takes no argument, which is why the panel can print the bare
    // command with nothing for the reader to fill in.
    expect(login!.signature).toBe('');
  });
});

describe('the tie line’s promise — a CLI token is listed in the table below', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('shows a seeded `CLI · <hostname>` token in the pane’s list', async () => {
    const { workspace, owner } = await createTestWorkspace();

    // Seeded through the REAL service with the REAL label helper the device-grant
    // approval mints with (`cliDeviceService.approve` → `cliTokenLabel`), then read
    // back through the same `listForUser` the page server-reads — so this asserts
    // the shipped label reaches the shipped row, not a string typed into a fixture.
    await apiTokensService.create(owner.id, workspace.id, {
      label: cliTokenLabel('workbox'),
      scopes: CLI_TOKEN_SCOPES,
    });
    const tokens = await apiTokensService.listForUser(owner.id);

    renderWithIntl(
      <ToastProvider>
        <ConnectCliPanel hasTokens={tokens.length > 0} />
        <ApiTokensManager initialTokens={tokens} scopeOrgs={[]} activeWorkspaceId={null} />
      </ToastProvider>,
    );

    expect(screen.getByText('CLI · workbox')).toBeTruthy();
    // With a token present, the panel commits to the present tense.
    expect(screen.getByText(/revoking it there disconnects that terminal/i)).toBeTruthy();
  });
});
