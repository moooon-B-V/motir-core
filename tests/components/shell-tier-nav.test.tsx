// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// MOTIR-2556 — the shell's CONTEXT PATH, `org › workspace › project`
// (`design/shell/design-notes.md` § *The context row*).
//
// ── WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT ────────────────
// happy-dom has no layout engine, so nothing here can measure a pixel — the
// widths this design was decided on were measured in Chromium and live in the
// asset, and the runtime geometry (zero overflow at 320px, the hamburger's
// hit-test) is `tests/e2e/cloud-top-bar-budget.spec.ts`, in a real browser.
//
// What this file CAN pin — and what no browser test pins as cheaply — is the
// CONTRACT the ladder is: which tiers exist, in which order, and behind which
// two independent gates. Both gates are load-bearing and they are easy to
// confuse for one:
//
//   COUNT  the workspace tier appears only at ≥2 workspaces (Story 6.10.5).
//   WIDTH  the org appears from `md`, its NAME and the workspace tier from
//          `xl`, and the project is the one tier present at every width.
//
// A test that asserted only the COUNT gate would pass on a build that shows all
// three tiers at 320px — which is the exact state this story exists to end, and
// the state that still ships today (the bar overflows by 47px there). So the
// band gate is asserted through the responsive utility each tier carries.

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/app/(authed)/_components/CreateProjectModal', () => ({
  CreateProjectModal: () => null,
}));

import { ShellTierNav } from '@/app/(authed)/_components/ShellTierNav';

const ORG = { id: 'org1', name: 'moooon B.V.', slug: 'moooon', role: 'owner' };
const ORGS = [{ id: 'org1', name: 'moooon B.V.', slug: 'moooon' }] as unknown as OrganizationDTO[];

const ws = (id: string, name: string) =>
  ({ id, name, slug: name.toLowerCase(), role: 'admin' }) as unknown as WorkspaceSummaryDTO;
const ONE_WORKSPACE = [ws('w1', 'moooon')];
const TWO_WORKSPACES = [ws('w1', 'Engineering'), ws('w2', 'Marketing')];

const project = (over: Partial<ProjectDTO> = {}) =>
  ({
    id: 'p1',
    name: 'Motir',
    identifier: 'MOTIR',
    archivedAt: null,
    ...over,
  }) as unknown as ProjectDTO;

function render(props: Partial<React.ComponentProps<typeof ShellTierNav>> = {}) {
  return renderWithIntl(
    <ToastProvider>
      <ShellTierNav
        activeOrg={ORG}
        orgs={ORGS}
        workspaces={TWO_WORKSPACES}
        activeWorkspaceId="w1"
        cloudBilling={false}
        activeProject={project()}
        projects={[project()]}
        {...props}
      />
    </ToastProvider>,
  );
}

/** A class list carries a utility, matched as a whole token (so `xl:contents`
 *  never satisfies a check for `contents`). */
function has(el: Element, utility: string): boolean {
  return el.className.split(/\s+/).includes(utility);
}

/** The wrapper a tier's control sits in — the element carrying its band gate. */
function tierWrapper(el: Element): HTMLElement {
  return el.closest('span[class*="contents"]') as HTMLElement;
}

afterEach(cleanup);

describe('the shell’s context path (MOTIR-2556)', () => {
  describe('the COUNT gate — unchanged from Story 6.10.5', () => {
    it('shows the workspace tier at TWO workspaces', () => {
      render();
      expect(screen.getByRole('button', { name: 'Switch workspace' })).toBeTruthy();
    });

    it('hides it at ONE — the middle tier stays implicit, so the path reads org › project', () => {
      render({ workspaces: ONE_WORKSPACE });
      expect(screen.queryByRole('button', { name: 'Switch workspace' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Organization menu' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Switch project' })).toBeTruthy();
    });
  });

  describe('the WIDTH gate — the ladder', () => {
    it('gives the project tier NO band gate: it is the one tier present at every width', () => {
      render();
      const project = screen.getByRole('button', { name: 'Switch project' });
      expect(tierWrapper(project)).toBeNull();
    });

    it('gates the ORG tier at md', () => {
      render();
      const wrapper = tierWrapper(screen.getByRole('button', { name: 'Organization menu' }));
      expect(has(wrapper, 'hidden')).toBe(true);
      expect(has(wrapper, 'md:contents')).toBe(true);
    });

    // ⚠️ AMENDED by MOTIR-2679. This used to assert the opposite — that the org
    // NAME was `hidden xl:inline`, because the org's MARK stood in for it
    // between `md` and `xl`. `docs/decisions/entity-marks.md` §2 deletes that
    // mark (an organization cannot have one), so a hidden name would have left
    // the tier as a chevron in an empty button. The name now renders from `md`:
    // +2px against the old mark form at 768px, 0 overflow at every band
    // (MOTIR-2674, design/shell/design-notes.md § The ladder).
    it('renders the org NAME from md — it is no longer gated behind xl', () => {
      render();
      const name = screen.getByText('moooon B.V.');
      expect(has(name, 'hidden')).toBe(false);
      expect(has(name, 'xl:inline')).toBe(false);
    });

    it('renders NO org mark — not a tile, not an initial, nothing', () => {
      const { container } = render();
      // The retired OrgAvatar was the only `--el-tint-lavender` 20px tile in
      // this tree; nothing replaces it.
      expect(container.querySelector('.bg-\\(--el-tint-lavender\\)')).toBeNull();
      // And the org tier is not a control whose only content is a chevron.
      const org = screen.getByRole('button', { name: /organization|Organisation|org menu/i });
      expect((org.textContent ?? '').trim().length).toBeGreaterThan(0);
    });

    it('gates the WORKSPACE tier at xl, separator included', () => {
      render();
      const wrapper = tierWrapper(screen.getByRole('button', { name: 'Switch workspace' }));
      expect(has(wrapper, 'hidden')).toBe(true);
      expect(has(wrapper, 'xl:contents')).toBe(true);
      // the separator rides INSIDE the wrapper, so the tier leaves whole — a
      // dangling `›` at md would be the tell that it does not
      expect(within(wrapper).getByText('›')).toBeTruthy();
    });
  });

  // MOTIR-4897 — the ladder decides WHICH tiers are present at a width; it
  // cannot decide how WIDE they are, because a name is data. At `xl` all three
  // tiers are live, the right cluster is labelled and `flex-none`, and the row
  // leaves ~267px for three names capped at 20ch / 24ch / 22ch. The ancestors
  // could not shrink at all — a flex child's automatic minimum is its content,
  // and an `inline-flex` Button's content is its whole (capped) name — so the
  // row overflowed and the project tier, LAST in it, passed UNDER the right
  // cluster: visible, enabled, and unclickable.
  //
  // The pixel half is `tests/e2e/cloud-top-bar-budget.spec.ts` at 1280px. What
  // happy-dom can pin is the contract the geometry follows from
  // (design/shell/design-notes.md § *The context path's truncation budget*).
  describe('the TRUNCATION budget — every tier shrinks, the ancestors first', () => {
    it('lets each ANCESTOR tier go below its name, three times as readily as the project', () => {
      render();
      for (const name of ['Organization menu', 'Switch workspace']) {
        const trigger = screen.getByRole('button', { name });
        expect(has(trigger, 'min-w-0'), `${name}: may go below its content width`).toBe(true);
        expect(has(trigger, 'shrink-3'), `${name}: yields width before the project`).toBe(true);
        // The Button wraps its children in a bare <span>, which is itself a flex
        // item with an automatic minimum — without this the trigger shrinks and
        // its label overflows it instead of ellipsizing. The chevron's span is
        // `aria-hidden` and deliberately keeps its minimum.
        expect(has(trigger, '[&>span:not([aria-hidden])]:min-w-0'), name).toBe(true);
        const label = trigger.querySelector('span.truncate')!;
        expect(has(label, 'min-w-0'), `${name}: the name itself ellipsizes`).toBe(true);
        // `text-overflow` applies only to a BLOCK container; an inline span
        // ignores `truncate` and spills. A flex parent blockifies its child.
        expect(
          has(label, 'block') || has(label.parentElement!, 'flex'),
          `${name}: the name is a box truncation can apply to`,
        ).toBe(true);
      }
    });

    it('keeps the PROJECT the slowest to shrink — the most specific tier stays the most legible', () => {
      render();
      const trigger = screen.getByRole('button', { name: 'Switch project' });
      expect(has(trigger, 'min-w-0')).toBe(true);
      expect(has(trigger, 'shrink')).toBe(true);
      expect(has(trigger, 'shrink-3')).toBe(false);
    });
  });

  it('orders the path org › workspace › project', () => {
    const { container } = render();
    const labels = Array.from(container.querySelectorAll('button[aria-label]')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Organization menu', 'Switch workspace', 'Switch project']);
  });

  describe('the three states the project tier inherits from the old rail head', () => {
    it('renders the switcher for an active project', () => {
      render();
      expect(screen.getByRole('button', { name: 'Switch project' }).textContent).toContain('Motir');
    });

    it('renders the Archived pill for an archived active project, and keeps the name', () => {
      render({
        activeProject: project({ archivedAt: new Date('2026-07-01').toISOString() }),
        projects: [],
      });
      const trigger = screen.getByRole('button', { name: 'Switch project' });
      expect(trigger.textContent).toContain('Motir');
      expect(trigger.textContent).toContain('Archived');
    });

    it('renders NOTHING — no switcher and no door — when there is no project', () => {
      // ⚠️ INVERTED (MOTIR-4873). It asserted the create-first door: an accent
      // `+` square opening `CreateProjectModal`, in the project tier. Every
      // member is inside a project (MOTIR-4870), so the door serves nobody, and
      // a tier that draws something for a state the product cannot produce is a
      // tier teaching that it can happen.
      //
      // The state is unreachable rather than unconstructable, so the assertion
      // is about what the tier DOES with it: nothing. Creating an ADDITIONAL
      // project is untouched and lives on the switcher.
      render({ activeProject: null, projects: [] });
      expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Create your first project' })).toBeNull();
    });
  });

  describe('placement="drawer" — the ANCESTORS, and only those', () => {
    it('carries no project tier: the control has exactly ONE host', () => {
      render({ placement: 'drawer' });
      expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Create your first project' })).toBeNull();
    });

    it('shows org › workspace with NO band gate — the drawer is where they always are', () => {
      render({ placement: 'drawer' });
      const org = screen.getByRole('button', { name: 'Organization menu' });
      expect(tierWrapper(org)).toBeNull();
      expect(screen.getByRole('button', { name: 'Switch workspace' })).toBeTruthy();
      expect(has(screen.getByText('moooon B.V.'), 'hidden')).toBe(false);
    });

    it('still honours the COUNT gate', () => {
      render({ placement: 'drawer', workspaces: ONE_WORKSPACE });
      expect(screen.queryByRole('button', { name: 'Switch workspace' })).toBeNull();
    });
  });
});
