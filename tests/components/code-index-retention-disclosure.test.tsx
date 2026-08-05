// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { CODE_GRAPH_RETENTION_WINDOW_DAYS } from '@/lib/codeGraph/offboarding';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ArchiveProjectModal } from '@/app/(authed)/settings/project/_components/ArchiveProjectModal';

// THE RETENTION DISCLOSURE (MOTIR-2171 ·
// `docs/decisions/code-graph-index-fleet.md` §14).
//
// §14 commits Motir to a DEFINED retention window for a tenant's derived code
// graph, and GitHub's Marketplace terms frame the obligation in exactly that
// language — the provider deletes the user's data "within its defined window".
// A window that exists only in an ADR and a cron expression satisfies the
// engineering half and none of the promise half.
//
// What this suite protects is the JOIN between the two: that the surfaces say
// something, that what they say matches what the code does, and that the number
// cannot drift from the constant that enforces it.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/app/(authed)/_project-actions', () => ({ archiveProjectAction: vi.fn() }));

afterEach(cleanup);

// ── 1. the copy exists, in both catalogs ─────────────────────────────────────

describe('every surface with a code graph discloses what happens to it', () => {
  const surfaces = [
    { name: 'project archive', get: (m: typeof en) => m.settings.archive.modalCodeIndex },
    { name: 'workspace delete', get: (m: typeof en) => m.settings.danger.deleteModalCodeIndex },
    { name: 'GitHub repo selection', get: (m: typeof en) => m.github.repos.codeIndex },
  ];

  it.each(surfaces)('$name states it in en AND zh', ({ get }) => {
    // The i18n parity gate catches a MISSING key; this catches an empty one, and
    // names the surface so a failure says which promise went unstated.
    expect(get(en).length).toBeGreaterThan(0);
    expect(get(zh as unknown as typeof en).length).toBeGreaterThan(0);
  });
});

// ── 2. ⚠️ the two arms say DIFFERENT things ──────────────────────────────────

describe('the windowed arms and the immediate arm do not read alike', () => {
  it('the windowed surfaces interpolate the window and never hardcode it', () => {
    // The failure this prevents is one level down from the decision itself: a
    // duration written into a translation string will not move when the constant
    // does, and it fails silently in every locale at once.
    for (const message of [en.settings.archive.modalCodeIndex, en.github.repos.codeIndex]) {
      expect(message).toContain('{days}');
      expect(message).not.toMatch(/\b\d+\s*days?\b/);
    }
    for (const message of [zh.settings.archive.modalCodeIndex, zh.github.repos.codeIndex]) {
      expect(message).toContain('{days}');
      expect(message).not.toMatch(/\d+\s*天/);
    }
  });

  it('the WORKSPACE-DELETE copy promises no window at all', () => {
    // A workspace delete is a hard cascade with no surface left to undo into, so
    // it has no grace period. Copy that flattened the two arms into one
    // reassuring sentence would promise a recovery window that does not exist for
    // the most destructive action the product offers — worse than saying nothing,
    // because the user would rely on it.
    const message = en.settings.danger.deleteModalCodeIndex;
    expect(message).toMatch(/immediately/i);
    expect(message).not.toContain('{days}');
    expect(message).not.toMatch(/\b\d+\s*days?\b/);

    expect(zh.settings.danger.deleteModalCodeIndex).toContain('立即');
    expect(zh.settings.danger.deleteModalCodeIndex).not.toContain('{days}');
  });

  it('the archive copy no longer claims the archive deletes nothing', () => {
    // The sentence that was TRUE until the offboarding queue shipped. Archiving
    // now schedules removal of the derived index, so leaving it in place would
    // have put a false promise one line above a true one, in the same dialog.
    expect(en.settings.archive.modalDesc).not.toMatch(/does not delete any data/i);
    expect(zh.settings.archive.modalDesc).not.toContain('不会删除任何数据');
  });
});

// ── 3. it actually renders, with the real number ─────────────────────────────

describe('the archive dialog renders the interpolated window', () => {
  it('shows the disclosure with the constant’s value, not a literal', () => {
    // The end of the wire: catalog → interpolation → the sentence a user reads.
    // Asserting the RENDERED number is what makes the interpolation real rather
    // than a placeholder nobody filled in.
    renderWithIntl(
      <ToastProvider>
        <ArchiveProjectModal
          open
          onOpenChange={() => {}}
          projectId="p-1"
          projectName="Motir"
          projectIdentifier="PROD"
        />
      </ToastProvider>,
    );

    const disclosure = screen.getByText(/code index/i);
    expect(disclosure.textContent).toContain(String(CODE_GRAPH_RETENTION_WINDOW_DAYS));
    // …and the raw placeholder never reaches the screen.
    expect(disclosure.textContent).not.toContain('{days}');
  });
});
