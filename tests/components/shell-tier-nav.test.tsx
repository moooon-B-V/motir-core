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
// hit-test) is `tests/e2e/top-bar-budget.spec.ts`, in a real browser.
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
    avatarIcon: 'rocket',
    avatarColor: 'lavender',
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

    it('gates the org NAME one band later, at xl — the org collapses to its mark first', () => {
      render();
      const name = screen.getByText('moooon B.V.');
      expect(has(name, 'hidden')).toBe(true);
      expect(has(name, 'xl:inline')).toBe(true);
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

    it('renders the create-first door — not a switcher — when there is no project', () => {
      render({ activeProject: null, projects: [] });
      expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Create your first project' })).toBeTruthy();
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
