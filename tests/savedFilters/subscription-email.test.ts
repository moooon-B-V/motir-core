import { describe, expect, it } from 'vitest';
import {
  filterSubscriptionEmail,
  type FilterSubscriptionEmailProps,
} from '@/lib/emailTemplates/filterSubscription';

// Story 6.2 · Subtask 6.2.5 — the filter-subscription email template (pure
// render, per CLAUDE.md). Asserts the subject/text/html contract, the
// unredacted links in plain text (the 1.1.6 dev-console grep contract), the
// truncation note, and the zero-result "report, not an alert" branch.

const FILTER_URL = 'https://motir.test/items?filter=v1%3Aabc';
const UNSUB_URL = 'https://motir.test/unsubscribe/filter-subscription?token=sub-1.sig';

function props(over: Partial<FilterSubscriptionEmailProps> = {}): FilterSubscriptionEmailProps {
  return {
    recipientName: 'Bo',
    filterName: 'Sprint blockers',
    projectKey: 'PROD',
    items: [
      { identifier: 'PROD-12', title: 'Login crashes', status: 'In progress' },
      { identifier: 'PROD-15', title: 'Flaky checkout', status: 'To do' },
    ],
    totalCount: 2,
    resultCap: 50,
    filterUrl: FILTER_URL,
    unsubscribeUrl: UNSUB_URL,
    ...over,
  };
}

describe('filterSubscriptionEmail', () => {
  it('renders subject + html + text with the rows, total, and unredacted links', async () => {
    const email = await filterSubscriptionEmail(props());
    expect(email.subject).toContain('Sprint blockers');
    expect(email.subject).toContain('2 results');

    // Rows appear in both html and plain text.
    for (const channel of [email.html, email.text]) {
      expect(channel).toContain('PROD-12');
      expect(channel).toContain('Login crashes');
      expect(channel).toContain('In progress');
    }
    // Links appear VERBATIM (unredacted) in plain text — the grep contract.
    expect(email.text).toContain(FILTER_URL);
    expect(email.text).toContain(UNSUB_URL);
    expect(email.text.trimEnd().endsWith('— Motir')).toBe(true);
  });

  it('shows the truncation note when the total exceeds the shown rows', async () => {
    const email = await filterSubscriptionEmail(props({ totalCount: 137 }));
    expect(email.text).toContain('first 2 of 137');
    expect(email.html).toContain('137');
  });

  it('uses the empty branch for a zero-result run (a report, not an alert)', async () => {
    const email = await filterSubscriptionEmail(props({ items: [], totalCount: 0 }));
    expect(email.subject).toContain('No results');
    expect(email.text).toContain('no work items');
    // Still carries the unsubscribe link even with nothing to report.
    expect(email.text).toContain(UNSUB_URL);
  });
});
