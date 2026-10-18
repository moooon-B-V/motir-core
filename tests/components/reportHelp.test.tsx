// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/messages/en.json';
import {
  ReportHelp,
  ReportHelpRegion,
  ReportHelpToggle,
  type ReportHelpId,
} from '@/app/(authed)/reports/_components/ReportHelp';
import { resetReportHelpHiddenForTests } from '@/lib/hooks/useReportHelpHidden';

const wrap = (ui: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  window.localStorage.clear();
  resetReportHelpHiddenForTests();
});
afterEach(() => cleanup());

describe('ReportHelp', () => {
  it('shows the region with both paragraphs and an expanded toggle', () => {
    wrap(<ReportHelp report="velocity" />);
    const button = screen.getByRole('button', { name: 'Hide help text' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const region = screen.getByRole('region', { name: 'About this report' });
    expect(button.getAttribute('aria-controls')).toBe(region.id);
    expect(region.textContent).toContain('What it shows.');
    expect(region.textContent).toContain('How to read it.');
  });

  it('hides the region, flips the label, and a split toggle + region stay in sync', () => {
    wrap(
      <>
        <ReportHelpToggle report="workload" />
        <ReportHelpRegion report="workload" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide help text' }));
    expect(screen.queryByRole('region', { name: 'About this report' })).toBeNull();
    const show = screen.getByRole('button', { name: 'Show help text' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    expect(screen.getByRole('region', { name: 'About this report' })).toBeTruthy();
  });

  it('every report id has its own two paragraphs', () => {
    const ids: ReportHelpId[] = [
      'burndown',
      'velocity',
      'sprintReport',
      'createdVsResolved',
      'distribution',
      'averageAge',
      'resolutionTime',
      'workload',
    ];
    for (const id of ids) {
      const help = (
        messages.reports.help as unknown as Record<string, { what: string; how: string }>
      )[id];
      expect(help?.what, id).toBeTruthy();
      expect(help?.how, id).toBeTruthy();
    }
  });
});
