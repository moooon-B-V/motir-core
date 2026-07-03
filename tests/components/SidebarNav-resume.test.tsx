// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The labeled "Resume onboarding" row (MOTIR-1533; design MOTIR-1548) leads the
// primary nav ONLY when the active project has an in-progress onboarding. We
// mock the shared signal (OnboardingResumeProvider) and assert the row appears /
// disappears + routes to /onboarding.

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// Control the resume signal without mounting the provider / fetching.
const { resumeRef } = vi.hoisted(() => ({ resumeRef: { value: false } }));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => resumeRef.value,
}));

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

const PROJECT = {
  id: 'p1',
  key: 'PROD',
  identifier: 'PROD',
  name: 'Prodect',
  avatarIcon: null,
  avatarColor: null,
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };

afterEach(() => {
  cleanup();
  pathname = '/dashboard';
  resumeRef.value = false;
});

describe('SidebarNav — Resume onboarding row', () => {
  it('is hidden when no onboarding is in progress', () => {
    resumeRef.value = false;
    renderWithIntl(<SidebarNav activeProject={PROJECT} projects={[PROJECT]} user={USER} />);
    expect(screen.queryByRole('link', { name: /Resume onboarding/ })).toBeNull();
  });

  it('renders a labeled row to /onboarding when onboarding is in progress', () => {
    resumeRef.value = true;
    renderWithIntl(<SidebarNav activeProject={PROJECT} projects={[PROJECT]} user={USER} />);
    const row = screen.getByRole('link', { name: /Resume onboarding/ });
    expect(row.getAttribute('href')).toBe('/onboarding');
  });

  it('leads the primary nav (sits above Dashboard)', () => {
    resumeRef.value = true;
    renderWithIntl(<SidebarNav activeProject={PROJECT} projects={[PROJECT]} user={USER} />);
    const nav = screen.getByRole('navigation');
    const links = within(nav).getAllByRole('link');
    const labels = links.map((l) => l.textContent);
    const resumeIdx = labels.findIndex((l) => l?.includes('Resume onboarding'));
    const dashIdx = labels.findIndex((l) => l === 'Dashboard');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(resumeIdx).toBeLessThan(dashIdx);
  });

  it('is not shown when there is no active project', () => {
    resumeRef.value = true;
    renderWithIntl(<SidebarNav activeProject={null} projects={[]} user={USER} />);
    // No primary project section renders at all, so no resume row.
    expect(screen.queryByRole('link', { name: /Resume onboarding/ })).toBeNull();
  });

  it('renders the localized label (zh)', () => {
    resumeRef.value = true;
    renderWithIntl(<SidebarNav activeProject={PROJECT} projects={[PROJECT]} user={USER} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    // zh: Resume onboarding = 继续引导
    expect(screen.getByRole('link', { name: /继续引导/ }).getAttribute('href')).toBe('/onboarding');
  });
});
