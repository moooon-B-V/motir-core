import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createElement } from 'react';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { scanMock, violations, formatMockFinding } from './theme/inkContrastMockScan';
import { scanMockStateInk, formatStateInkFinding } from './theme/mockStateInkScan';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY'S INTEGRATION GATE FOR motir-core (Story MOTIR-6960 · MOTIR-6966)
//
// `renderMock` (MOTIR-6961) and the design steps that point agents at it
// (MOTIR-6963) each carry their own unit tests. What neither can see is the
// SEAM: a document `renderMock` actually produces must be a design asset this
// repository ACCEPTS — it clears both ink-contrast guards a committed mock is
// held to, and the design-result publish door takes it as a `mock`. The last
// describe guards the one import that would break a page.
//
// Real Postgres for the publish door. The object store is the one mocked
// external, mocked as a STORE with the real helper's random suffix — the
// `design-publish-integration.test.ts` fake, for the reason written there.
// ═══════════════════════════════════════════════════════════════════════════

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string, body: Buffer, contentType: string) => {
    const dot = pathname.lastIndexOf('.');
    const suffix = randomBytes(5).toString('hex');
    const written =
      dot <= pathname.lastIndexOf('/')
        ? `${pathname}-${suffix}`
        : `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
    store.set(written, { contentType, size: body.byteLength });
    return { pathname: written };
  }),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { designEvidenceService } = await import('@/lib/services/designEvidenceService');
const { makeWorkWaitOn } = await import('./helpers/designWaits');
// The BUILT package, through its published subpath — what a project installs.
const { renderMock } = await import('@motir/design-system/mock');
const { Button, Card, Pill } = await import('@motir/design-system');

const SOURCE_PATH = 'design/settings/save-bar.mock.html';

/** A real mock of real package parts, in both themes and two palettes. */
async function renderRealMock(paletteId: string, theme: 'light' | 'dark'): Promise<string> {
  return renderMock({
    title: 'Save bar',
    axes: { styleId: 'warm-editorial', paletteId, typeId: 'motir' },
    theme,
    panels: [
      {
        label: 'Unsaved changes',
        element: createElement(
          Card,
          null,
          createElement(Pill, { status: 'in-progress' }, 'Unsaved'),
          createElement(Button, { variant: 'primary' }, 'Save'),
          createElement(Button, { variant: 'secondary' }, 'Discard'),
        ),
      },
      { label: 'Danger', element: createElement(Button, { variant: 'danger' }, 'Delete') },
    ],
  });
}

const RENDERS: [string, 'light' | 'dark'][] = [
  ['motir', 'light'],
  ['motir', 'dark'],
  ['cobalt', 'light'],
];

describe('a rendered mock clears BOTH design ink-contrast guards', () => {
  it.each(RENDERS)('the resting-state guard (%s, %s)', async (palette, theme) => {
    const html = await renderRealMock(palette, theme);
    const findings = scanMock(SOURCE_PATH, html);
    expect(violations(findings).map(formatMockFinding).join('\n')).toBe('');
  });

  it.each(RENDERS)('the state guard, which renders the tree (%s, %s)', async (palette, theme) => {
    const html = await renderRealMock(palette, theme);
    const scan = scanMockStateInk(SOURCE_PATH, html);
    expect(scan.findings.map(formatStateInkFinding).join('\n')).toBe('');
  });

  it('the guards are LIVE on a rendered document: muted ink on a tint is reported', async () => {
    // Without this, a document the scanners could not read would pass the two
    // tests above by ruling on nothing.
    const html = (await renderRealMock('motir', 'light')).replace(
      '</main>',
      '<div class="bg-(--el-surface)"><p class="text-(--el-text-muted)">caption</p></div></main>',
    );
    expect(violations(scanMock(SOURCE_PATH, html))).not.toEqual([]);
  });
});

describe('the design-result publish door accepts a rendered mock as a `mock` asset', () => {
  let fx: WorkItemFixture;

  beforeEach(async () => {
    store.clear();
    await adminDb.$executeRawUnsafe(
      'TRUNCATE TABLE "design_asset", "design_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
    );
    await truncateAuthTables();
    fx = await makeWorkItemFixture();
  });

  it('records it through the service, as text/html, at the bytes it was', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Save bar' });
    const card = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Design the save bar',
      parentId: story.id,
    });
    await makeWorkWaitOn(card.id, fx);

    const html = await renderRealMock('motir', 'light');
    const dto = await designEvidenceService.recordFromBytes(
      {
        workItemId: card.id,
        commitSha: 'c0389f2',
        producedByKey: card.identifier,
        assets: [
          {
            kind: 'mock',
            sourcePath: SOURCE_PATH,
            contentType: 'text/html',
            bytes: Buffer.from(html, 'utf8'),
          },
          {
            kind: 'note_file',
            sourcePath: 'design/settings/design-notes.md',
            contentType: 'text/markdown',
            bytes: Buffer.from('On Motir Design: package.json and globals.css read.\n'),
          },
        ],
      },
      fx.ctx,
    );

    const mock = dto.assets.find((a) => a.kind === 'mock')!;
    expect(mock.sourcePath).toBe(SOURCE_PATH);
    expect(mock.mimeType).toBe('text/html');
    expect(mock.sizeBytes).toBe(Buffer.byteLength(html, 'utf8'));
  });
});

describe('the node-only subpath stays out of the app', () => {
  const ROOT = process.cwd();

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sources(path, out);
      else if (/\.(tsx?|jsx?|mjs)$/.test(entry))
        out.push(relative(ROOT, path).split(sep).join('/'));
    }
    return out;
  }

  const FILES = [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'components'))];
  const IMPORTS_MOCK = /(?:from|import\(?)\s*['"]@motir\/design-system\/mock['"]/;

  it('scans a real set of app and component sources', () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it('no app/ or components/ file imports @motir/design-system/mock', () => {
    // It reads files and imports react-dom/server: a build-time tool, never a
    // page dependency. A client import would break the page it lands in.
    expect(FILES.filter((f) => IMPORTS_MOCK.test(readFileSync(join(ROOT, f), 'utf8')))).toEqual([]);
  });

  it('the pattern is live on both import forms', () => {
    expect(IMPORTS_MOCK.test("import { renderMock } from '@motir/design-system/mock';")).toBe(true);
    expect(IMPORTS_MOCK.test("await import('@motir/design-system/mock')")).toBe(true);
    expect(IMPORTS_MOCK.test("import { Button } from '@motir/design-system';")).toBe(false);
  });
});
