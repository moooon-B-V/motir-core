// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { StopBuildInPublicDialog } from '@/app/(authed)/settings/project/members/_components/StopBuildInPublicDialog';

// StopBuildInPublicDialog (Subtask 6.17.4) — the reverse "Stop building in
// public?" confirm Modal (design/public-projects Panel 12). Like its forward
// twin (6.17.2) it is presentational + controlled: it does NOT mutate access;
// the owner reverts the level on the confirm callback. These cover the
// centralized `settings.buildInPublic.*` stop copy (en + zh), the confirm/cancel
// wiring, and the pending state.

afterEach(cleanup);

describe('StopBuildInPublicDialog', () => {
  it('renders the stop title, what-happens list, and reassurance (en)', () => {
    renderWithIntl(<StopBuildInPublicDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('Stop building in public?')).toBeTruthy();
    expect(screen.getByText(/goes offline/)).toBeTruthy();
    expect(screen.getByText(/link stops working/)).toBeTruthy();
    expect(screen.getByText(/nothing is deleted/)).toBeTruthy();
    expect(screen.getByText(/start building in public again anytime/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop building in public' })).toBeTruthy();
  });

  it('fires onConfirm when the confirm button is clicked, not on open', () => {
    const onConfirm = vi.fn();
    renderWithIntl(<StopBuildInPublicDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop building in public' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('closes via Cancel through onOpenChange and disables both buttons while pending', () => {
    const onOpenChange = vi.fn();
    const { rerender } = renderWithIntl(
      <StopBuildInPublicDialog open onOpenChange={onOpenChange} onConfirm={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(
      <StopBuildInPublicDialog open onOpenChange={onOpenChange} onConfirm={vi.fn()} pending />,
    );
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Stop building in public' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('renders the native zh copy when the locale is zh', () => {
    renderWithIntl(<StopBuildInPublicDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByText('停止公开构建？')).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止公开构建' })).toBeTruthy();
  });
});
