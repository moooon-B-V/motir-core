// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ReactNode } from 'react';
import en from '@/messages/en.json';
import type { AutoTranslateContextDTO } from '@/lib/dto/autoTranslate';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';
import { SurfaceTitleTranslationProvider } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';

// THE SECONDARY LIST SURFACES, inside the provider (Story MOTIR-7738 · MOTIR-8834):
// an approval row names its work item by the translated title in its sentence and
// in its row door's accessible name, and reads as stored with no provider.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/approvals',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONTEXT: AutoTranslateContextDTO = {
  autoTranslateWorkContent: true,
  targetLanguage: 'en',
  credit: 'ok',
  canAddCredit: false,
};

const row = {
  gateId: 'gate-1',
  kind: 'design_result',
  state: 'awaiting',
  canDecide: true,
  routedToName: 'Yue',
  waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
  workItem: {
    id: 'wi-1',
    key: 61,
    identifier: 'ACME-61',
    title: '账单导出每晚运行',
    kind: 'story',
    type: null,
  },
  subject: {
    kind: 'design_result',
    designEvidenceId: 'ev',
    producedByKey: null,
    commitSha: '9840d00ea1b2',
    assetCount: 3,
    noteExcerpt: null,
  },
} as unknown as ApprovalQueueRowDto;

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            targetLanguage: 'en',
            enabled: true,
            truncated: false,
            titles: [
              {
                workItemId: 'wi-1',
                fieldRef: 'wi-1:title',
                status: 'ready',
                text: 'Billing export runs nightly',
                sourceLanguage: 'zh',
              },
            ],
          }),
          { status: 200 },
        ),
    ),
  );
}

async function renderRow(wrap: (ui: ReactNode) => ReactNode) {
  const r = renderWithIntl(wrap(<ApprovalRow record={{ section: 'awaiting', row }} />), {
    locale: 'en',
    messages: en,
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return r;
}

describe('the approval row under auto-translate', () => {
  it('names the work item by its translated title, in the sentence and the door name', async () => {
    stub();
    await renderRow((ui) => (
      <SurfaceTitleTranslationProvider projectKey="ACME" context={CONTEXT}>
        {ui}
      </SurfaceTitleTranslationProvider>
    ));

    expect(screen.getAllByText(/Billing export runs nightly/).length).toBeGreaterThan(0);
    expect(screen.queryByText('账单导出每晚运行')).toBeNull();
    expect(screen.getAllByRole('link')[0]!.getAttribute('aria-label')).toContain(
      'Billing export runs nightly',
    );
  });

  it('reads as stored with no provider', async () => {
    await renderRow((ui) => ui);

    expect(screen.getByText('账单导出每晚运行')).toBeTruthy();
  });
});
