// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  DeliveryDetail,
  deliveryPill,
} from '@/app/(authed)/settings/workspace/jobs/_components/JobsDashboard';
import type { EmailDeliveryState, JobDeliveryDTO } from '@/lib/dto/jobs';

// The DELIVERY column's presentation (Bug MOTIR-3507 · Subtask MOTIR-3517),
// against `design/jobs/design-notes.md` § "Every value, and the token it takes".
//
// What is asserted here is the DESIGN's decisions, not the markup: which tint
// each value carries, that `accepted` is deliberately NOT a success tone, and
// that a run with no delivery record says so in words rather than showing an
// empty box.

afterEach(cleanup);

/** The tint each value must carry, per the asset's table. */
const EXPECTED_TINT: Record<EmailDeliveryState, string> = {
  accepted: '--el-chip-bg',
  delayed: '--el-tint-sky',
  delivered: '--el-tint-mint',
  bounced: '--el-tint-rose',
  complained: '--el-tint-peach',
};

function delivery(over: Partial<JobDeliveryDTO> = {}): JobDeliveryDTO {
  return {
    state: 'bounced',
    providerMessageId: 'a3f1c2d4-0000-4000-8000-000000000001',
    recipient: 'alice@example.com',
    template: 'workspace-invite',
    lastEventAt: '2026-08-26T00:52:00.000Z',
    ...over,
  };
}

describe('the delivery chip', () => {
  it.each(Object.entries(EXPECTED_TINT))('draws %s on its specified tint', (state, tint) => {
    render(deliveryPill(state as EmailDeliveryState, state));

    const chip = screen.getByText(state);
    expect(chip.className).toContain(tint);
  });

  it('does NOT give `accepted` a success tone — it is the absence of news', () => {
    // The asset is explicit about this one: the provider took the message and
    // has said nothing since. Drawing it green would restate the exact
    // conflation the column exists to end.
    render(deliveryPill('accepted', 'accepted'));

    expect(screen.getByText('accepted').className).not.toContain('--el-tint-mint');
  });

  it('gives every value a DISTINCT tint, so no two states read alike', () => {
    const tints = Object.values(EXPECTED_TINT);
    expect(new Set(tints).size).toBe(tints.length);
  });

  it('carries the hue in the BACKGROUND with strong ink, the AA-safe recipe', () => {
    render(deliveryPill('bounced', 'bounced'));

    const chip = screen.getByText('bounced');
    expect(chip.className).toContain('bg-(--el-tint-rose)');
    expect(chip.className).toContain('text-(--el-text-strong)');
  });
});

describe('the run detail`s delivery block', () => {
  it('surfaces the provider message id, so a bounce is something you can act on', () => {
    renderWithIntl(<DeliveryDetail delivery={delivery()} />);

    expect(screen.getByText('a3f1c2d4-0000-4000-8000-000000000001')).toBeTruthy();
    expect(screen.getByText('alice@example.com')).toBeTruthy();
    expect(screen.getByText('workspace-invite')).toBeTruthy();
  });

  it('says a message has no provider event yet rather than showing a blank', () => {
    renderWithIntl(
      <DeliveryDetail delivery={delivery({ state: 'accepted', lastEventAt: null })} />,
    );

    expect(screen.getByText(/no provider event yet/i)).toBeTruthy();
  });

  it('shows an em-dash for an accepted send that carried no message id', () => {
    renderWithIntl(
      <DeliveryDetail delivery={delivery({ providerMessageId: null, lastEventAt: null })} />,
    );

    expect(screen.getByText('—')).toBeTruthy();
  });

  it('says so in WORDS when the run has no delivery record at all', () => {
    // A job that is not `email.send`, or a send that predates the record. The
    // asset's no-row case: not an empty panel, and not a fabricated `accepted`.
    renderWithIntl(<DeliveryDetail delivery={null} />);

    expect(screen.getByText(/no delivery record/i)).toBeTruthy();
  });
});
