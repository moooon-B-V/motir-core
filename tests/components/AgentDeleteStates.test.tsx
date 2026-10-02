// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { AgentPanelHeader } from '@/app/(authed)/my-agents/_components/AgentPanelHeader';
import { AgentRowMenu } from '@/app/(authed)/my-agents/_components/AgentRowMenu';
import type { AgentInstanceListItemDto, AgentInstanceState } from '@/lib/dto/agentInstances';

// DELETE FROM A BOOT OR A STOP THAT HAS NOT SETTLED (MOTIR-7341,
// `agent-instances.md` AMENDMENT 4). The panel header and the row menu offer
// Delete… for a `starting`, `waking` or `hibernating` agent, in both locales, and
// keep it disabled for `deleting` and `updating`. A run working in the agent still
// disables it, with the sentence saying why.

function agent(over: Partial<AgentInstanceListItemDto> = {}): AgentInstanceListItemDto {
  return {
    id: 'a1',
    name: 'yue-claude',
    projectId: 'p1',
    profileId: 'claude',
    profileName: 'Claude Code',
    imageTag: 'ghcr.io/moooon-b-v/motir-sandbox:claude',
    imageDigest: 'sha256:abc',
    imageVersion: '0.4.0',
    update: null,
    pendingImageVersion: null,
    updateFailureReason: null,
    region: 'iad',
    state: 'running',
    failureReason: null,
    terminalServer: 'absent',
    stateChangedAt: '2026-09-29T10:00:00.000Z',
    lastActivityAt: '2026-09-29T10:00:00.000Z',
    createdAt: '2026-09-29T10:00:00.000Z',
    machineSecondsThisMonth: 60,
    creditsThisMonth: 1,
    stopReason: null,
    scheduledDeletionAt: null,
    activeRun: null,
    lastRun: null,
    ...over,
  };
}

const LOCALES = [
  ['en', enMessages],
  ['zh', zhMessages],
] as const;

const deleteLabel = (messages: typeof enMessages, where: 'panel' | 'menu') =>
  where === 'panel' ? messages.myAgents.panel.delete : messages.myAgents.menu.delete;

afterEach(() => cleanup());

const CASES: ReadonlyArray<readonly [AgentInstanceState, boolean]> = [
  ['starting', true],
  ['waking', true],
  ['hibernating', true],
  ['running', true],
  ['hibernated', true],
  ['failed', true],
  ['deleting', false],
  ['updating', false],
];

describe.each(LOCALES)('Delete… by state (%s)', (locale, messages) => {
  it.each(CASES)('the panel header: %s → enabled %s', (state, enabled) => {
    const onDelete = vi.fn();
    render(
      <AgentPanelHeader
        agent={agent({ state })}
        projectName="motir"
        signIn={null}
        onClose={vi.fn()}
        onHibernate={vi.fn()}
        onDelete={onDelete}
        onUpdate={vi.fn()}
      />,
      { locale, messages },
    );
    const button = screen.getByRole('button', {
      name: deleteLabel(messages, 'panel'),
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(!enabled);
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it.each(CASES)('the row menu: %s → enabled %s', (state, enabled) => {
    const onMove = vi.fn();
    render(<AgentRowMenu name="yue-claude" state={state} onMove={onMove} />, {
      locale,
      messages,
    });
    fireEvent.click(screen.getByRole('button', { name: /yue-claude/ }));
    const item = screen.getByRole('menuitem', {
      name: deleteLabel(messages, 'menu'),
    }) as HTMLButtonElement;
    expect(item.disabled).toBe(!enabled);
    fireEvent.click(item);
    expect(onMove).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it('a run working in the agent still disables Delete…, and says why', () => {
    render(
      <AgentPanelHeader
        agent={agent({
          activeRun: {
            id: 'run-1',
            workItemKey: 'MOTIR-1789',
            title: 'A run',
            startedAt: '2026-09-30T10:00:00.000Z',
          },
        })}
        projectName="motir"
        signIn={null}
        onClose={vi.fn()}
        onHibernate={vi.fn()}
        onDelete={vi.fn()}
        onUpdate={vi.fn()}
      />,
      { locale, messages },
    );
    const button = screen.getByRole('button', {
      name: deleteLabel(messages, 'panel'),
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('agent-run-off').textContent).toBe(
      messages.myAgents.panel.run.offWhy,
    );
  });
});
