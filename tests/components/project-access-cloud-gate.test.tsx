// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectMembersSettings } from '@/app/(authed)/settings/project/members/_components/ProjectMembersSettings';
import type { ProjectMemberDTO } from '@/lib/dto/projectMembers';
import type { RoleDTO } from '@/lib/dto/permissions';

// MOTIR-4035 — the UI half of the publish gate: with `MOTIR_CLOUD` unset the
// access control does not OFFER `public`.
//
// The service is the enforcement point and refuses the write regardless
// (`PublicAccessUnavailableError`, `tests/project-members-service.test.ts`).
// This half is what stops a person meeting that refusal: an option you can
// select and that then fails is worse than an option that is not there, because
// it reads as a bug in the product rather than as a capability it does not have.
//
// ⚠️ BOTH ARMS. Off-cloud alone would pass on a control that renders no levels
// at all; on-cloud alone would pass on a gate that never fires.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const SELF = 'u-self';
const members: ProjectMemberDTO[] = [
  { userId: SELF, name: 'Zhu Yue', email: 'zhuyue@motir.co', role: 'admin', roleDefinition: null },
];
const roles: RoleDTO[] = (['admin', 'member', 'viewer'] as const).map((role) => ({
  key: role,
  builtInRole: role,
  labelKey: `settings.roles.${role}.name`,
  descriptionKey: `settings.roles.${role}.description`,
  name: null,
  description: null,
  builtIn: true,
  permissions: [],
  memberCount: 0,
}));

function render(
  overrides: Partial<React.ComponentProps<typeof ProjectMembersSettings>> = {},
): void {
  renderWithIntl(
    <ToastProvider>
      <ProjectMembersSettings
        projectKey="PROD"
        projectName="motir"
        workspaceName="moooon"
        accessLevel="private"
        members={members}
        roles={roles}
        workspaceMembers={[]}
        currentUserId={SELF}
        canManage
        publicAccessAvailable={false}
        {...overrides}
      />
    </ToastProvider>,
  );
}

/** The access radios, by their accessible name. */
const radios = () =>
  screen.getAllByRole('radio').map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');

afterEach(cleanup);

describe('the access control on a SELF-HOSTED build', () => {
  it('does not offer the public level', () => {
    render();
    expect(screen.queryByRole('radio', { name: /Building in public|Public/ })).toBeNull();
  });

  it('still offers every level a self-hosted team actually uses', () => {
    // The gate is one level wide, deliberately: `open` / `limited` / `private`
    // are how a team shares work inside its own workspace, which is what
    // self-hosting is FOR. Gating them would turn a single-tenant product into
    // a walled one.
    render();
    for (const level of [/Open/, /Limited/, /Private/]) {
      expect(screen.getByRole('radio', { name: level })).toBeTruthy();
    }
    expect(radios()).toHaveLength(3);
  });
});

describe('the access control on a CLOUD build', () => {
  it('offers the public level, enabled', () => {
    render({ publicAccessAvailable: true });
    const publicRadio = screen.getByRole('radio', { name: /Building in public|Public/ });
    expect(publicRadio).toBeTruthy();
    expect((publicRadio as HTMLButtonElement).disabled).toBe(false);
    expect(radios()).toHaveLength(4);
  });
});

describe('a project that IS public on a self-hosted build', () => {
  // It can happen: a database restored from cloud, or a project made public
  // before this gate landed. The control has to render the truth.
  it('shows the level as the current selection rather than hiding it', () => {
    render({ publicAccessAvailable: false, accessLevel: 'public' });
    const publicRadio = screen.getByRole('radio', { name: /Building in public|Public/ });
    expect(publicRadio.getAttribute('aria-checked')).toBe('true');
  });

  it('…and does not let anyone re-select it', () => {
    // A radio group whose checked option is absent shows nothing selected,
    // which reads as a broken control. Showing it and refusing to let anyone
    // move INTO it is the honest pair — and moving OUT of it stays available,
    // which is the direction a self-hoster in this state actually wants.
    render({ publicAccessAvailable: false, accessLevel: 'public' });
    const publicRadio = screen.getByRole('radio', {
      name: /Building in public|Public/,
    }) as HTMLButtonElement;
    expect(publicRadio.disabled).toBe(true);
    expect((screen.getByRole('radio', { name: /Private/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
