// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DirectionDocFullPage } from '@/app/(authed)/direction/[tier]/_components/DirectionDocFullPage';
import zhMessages from '@/messages/zh.json';

// The read-only tier-doc full page (MOTIR-1355) is shared by the in-shell
// `/direction/[tier]` and the shell-less `/onboarding/direction/[tier]`. MOTIR-8326:
// its chrome and state copy come from the catalogue (a Chinese reader saw English
// there), and its secondary copy sits on `--el-surface`, where `--el-text-muted` is
// 4.17:1 — under AA — so it paints in `--el-text-secondary` instead.

const back = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back, push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  back.mockReset();
});

const baseProps = { tier: 'discovery' as const, catalog: null, availableDocs: [] };

describe('DirectionDocFullPage', () => {
  it('renders the back affordance and breadcrumb from the catalogue', () => {
    render(<DirectionDocFullPage {...baseProps} doc={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Back to roadmap' }));
    expect(back).toHaveBeenCalledTimes(1);

    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Roadmap')).toBeTruthy();
    expect(within(crumbs).getByText('Direction')).toBeTruthy();
  });

  it('links Back to the onboarding roadmap when opened from onboarding', () => {
    render(<DirectionDocFullPage {...baseProps} doc={null} origin="onboarding" />);
    expect(screen.getByRole('link', { name: 'Back to roadmap' }).getAttribute('href')).toBe(
      '/onboarding',
    );
  });

  it('renders the chrome, the error copy and the empty copy in Chinese for a zh reader', () => {
    const { unmount } = render(<DirectionDocFullPage {...baseProps} doc={null} error />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByRole('button', { name: '返回路线图' })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: '面包屑导航' });
    expect(within(crumbs).getByText('路线图')).toBeTruthy();
    expect(within(crumbs).getByText('方向')).toBeTruthy();
    expect(screen.getByText('无法加载此文档')).toBeTruthy();
    expect(screen.queryByText(/Couldn't load|Back to roadmap/)).toBeNull();
    unmount();

    render(<DirectionDocFullPage {...baseProps} doc={null} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByText(/尚未就绪/)).toBeTruthy();
    expect(screen.queryByText(/isn't ready yet|hasn't been drafted/)).toBeNull();
  });

  it('paints the breadcrumb, the error body and the empty body in --el-text-secondary, never muted', () => {
    const { container, unmount } = render(<DirectionDocFullPage {...baseProps} doc={null} error />);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Roadmap').className).toContain('text-(--el-text-secondary)');
    expect(within(crumbs).getByText('Direction').className).toContain('text-(--el-text-secondary)');
    expect(screen.getByText(/Something went wrong reading your direction/).className).toContain(
      'text-(--el-text-secondary)',
    );
    expect(container.innerHTML).not.toContain('--el-text-muted');
    unmount();

    const empty = render(<DirectionDocFullPage {...baseProps} doc={null} />);
    expect(screen.getByText(/hasn't been drafted for this project/).className).toContain(
      'text-(--el-text-secondary)',
    );
    expect(empty.container.innerHTML).not.toContain('--el-text-muted');
  });
});
