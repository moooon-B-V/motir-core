// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectMembersSettings } from '@/app/(authed)/settings/project/members/_components/ProjectMembersSettings';
import type { ProjectMemberDTO } from '@/lib/dto/projectMembers';

// MOTIR-4035 — the UI half of the publish gate: with `MOTIR_CLOUD` unset the
// access control does not let anyone CHOOSE Public.
//
// The service is the enforcement point and refuses the write regardless
// (`PublicAccessUnavailableError`, `tests/project-members-service.test.ts`).
// This half is what stops a person meeting that refusal.
//
// ⚠️ AMENDED BY THE DESIGN (Story MOTIR-6169 · MOTIR-6550 · A10). The option used
// to be REMOVED off-cloud; it is now DRAWN, disabled, with the reason in text —
// an absent option explains nothing, and the three modes are the whole
// vocabulary. The gate is the same: nobody can move INTO Public here.
//
// ⚠️ BOTH ARMS. Off-cloud alone would pass on a control that renders no modes at
// all; on-cloud alone would pass on a gate that never fires.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const SELF = 'u-self';
const members: ProjectMemberDTO[] = [{ userId: SELF, name: 'Zhu Yue', email: 'zhuyue@motir.co' }];
const REASON =
  'Publishing runs on Motir Cloud — this self-hosted install has no public site to publish to.';

function render(
  overrides: Partial<React.ComponentProps<typeof ProjectMembersSettings>> = {},
): void {
  renderWithIntl(
    <ToastProvider>
      <ProjectMembersSettings
        projectKey="PROD"
        projectName="motir"
        workspaceName="moooon"
        accessMode="members"
        members={members}
        workspaceMembers={[]}
        currentUserId={SELF}
        canManageAccess
        canManageMembers
        publicAccessAvailable={false}
        // MOTIR-4242 — required, and inert here: this file's subject is the
        // access control, not the public cards.
        publicPageUrl="https://motir.co/p/PROD"
        {...overrides}
      />
    </ToastProvider>,
  );
}

const publicRadio = () => screen.getByRole('radio', { name: /^Public/ }) as HTMLButtonElement;

afterEach(cleanup);

describe('the access control on a SELF-HOSTED build', () => {
  it('draws Public disabled, with the reason in text', () => {
    render();
    expect(publicRadio().disabled).toBe(true);
    expect(publicRadio().getAttribute('aria-disabled')).toBe('true');
    expect(within(publicRadio()).getByText(REASON)).toBeTruthy();
  });

  it('still offers both modes a self-hosted team actually uses', () => {
    // Open to the workspace and Members only are how a team shares work inside
    // its own workspace, which is what self-hosting is FOR.
    render();
    for (const mode of [/^Open to the workspace/, /^Members only/]) {
      expect((screen.getByRole('radio', { name: mode }) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });
});

describe('the access control on a CLOUD build', () => {
  it('offers Public, enabled, with no unavailable reason', () => {
    render({ publicAccessAvailable: true });
    expect(publicRadio().disabled).toBe(false);
    expect(screen.queryByText(REASON)).toBeNull();
  });
});

describe('a project that IS public on a self-hosted build', () => {
  // It can happen: a database restored from cloud, or a project made public
  // before this gate landed. The control has to render the truth.
  it('shows Public as the current selection rather than hiding it', () => {
    render({ accessMode: 'public' });
    expect(publicRadio().getAttribute('aria-checked')).toBe('true');
  });

  it('…and lets the project move OUT of it, never back in', () => {
    render({ accessMode: 'public' });
    expect(publicRadio().disabled).toBe(true);
    expect(
      (screen.getByRole('radio', { name: /^Open to the workspace/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
