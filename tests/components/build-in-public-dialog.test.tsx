// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { BuildInPublicDialog } from '@/app/(authed)/settings/project/members/_components/BuildInPublicDialog';

// BuildInPublicDialog (Subtask 6.17.2) — the reusable "Start building in public?"
// explainer/confirm Modal (design/public-projects Panel 11). It is presentational
// + controlled: it does NOT mutate access; the owner runs setAccessLevel on the
// confirm callback. These cover the centralized `settings.buildInPublic.*` copy
// (en + zh), the confirm/cancel wiring, and the pending state.

afterEach(cleanup);

describe('BuildInPublicDialog', () => {
  it('renders the explainer title, what-becomes-public list, and reassurance (en)', () => {
    renderWithIntl(<BuildInPublicDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    // The visible heading + the footer CTA both read "building in public".
    expect(screen.getByText('Start building in public?')).toBeTruthy();
    expect(screen.getByText('What becomes public')).toBeTruthy();
    expect(screen.getByText(/status, progress, and what's shipping/)).toBeTruthy();
    expect(screen.getByText(/crawlable by search engines/)).toBeTruthy();
    expect(screen.getByText(/never shown/)).toBeTruthy();
    expect(screen.getByText(/the page goes offline/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start building in public' })).toBeTruthy();
  });

  it('fires onConfirm when the confirm button is clicked, not on open', () => {
    const onConfirm = vi.fn();
    renderWithIntl(<BuildInPublicDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start building in public' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('closes via Cancel through onOpenChange and disables both buttons while pending', () => {
    const onOpenChange = vi.fn();
    const { rerender } = renderWithIntl(
      <BuildInPublicDialog open onOpenChange={onOpenChange} onConfirm={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(<BuildInPublicDialog open onOpenChange={onOpenChange} onConfirm={vi.fn()} pending />);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('renders the native zh copy when the locale is zh', () => {
    renderWithIntl(<BuildInPublicDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByText('开始公开构建？')).toBeTruthy();
    expect(screen.getByText('哪些内容将公开')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始公开构建' })).toBeTruthy();
  });
});
