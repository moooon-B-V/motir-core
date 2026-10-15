import { describe, expect, it } from 'vitest';

import type { GuideReplanOffer } from '@/lib/ai/guideWorkItem';
import {
  latestUndecidedReplanOffer,
  replanOfferOf,
  replanOfferStateOf,
  type ReplanOfferTurn,
} from '@/lib/planning/guideReplanOffer';

const offer = (over: Partial<GuideReplanOffer> = {}): GuideReplanOffer => ({
  reason: 'r',
  requestMd: 'q',
  requestedTargetKey: null,
  targetKey: 'MOTIR-1',
  targetResolution: 'guided_card',
  declinedAt: null,
  declinedById: null,
  ...over,
});

const reply = (id: string, replanOffer?: GuideReplanOffer): ReplanOfferTurn => ({
  id,
  role: 'assistant',
  guide: { actions: [], outcomes: [], temporary: false, ...(replanOffer ? { replanOffer } : {}) },
});

describe('replanOfferStateOf', () => {
  it('is null for a turn with no offer, an unknown turn and a non-assistant turn', () => {
    const turns: ReplanOfferTurn[] = [
      {
        id: 'u1',
        role: 'user',
        guide: { actions: [], outcomes: [], temporary: false, replanOffer: offer() },
      },
      reply('a1'),
    ];
    expect(replanOfferStateOf(turns, 'a1')).toBeNull();
    expect(replanOfferStateOf(turns, 'nope')).toBeNull();
    expect(replanOfferStateOf(turns, 'u1')).toBeNull();
    expect(replanOfferOf(turns, 'a1')).toBeNull();
  });

  it('reads the latest offer as undecided', () => {
    expect(replanOfferStateOf([reply('a1', offer())], 'a1')).toBe('undecided');
  });

  it('reads an earlier offer as superseded once a later turn holds one', () => {
    const turns = [reply('a1', offer()), reply('a2'), reply('a3', offer())];
    expect(replanOfferStateOf(turns, 'a1')).toBe('superseded');
    expect(replanOfferStateOf(turns, 'a3')).toBe('undecided');
  });

  it('reads a declined offer as declined, even when superseded too', () => {
    const declined = offer({ declinedAt: '2026-10-15T00:00:00.000Z', declinedById: 'u' });
    expect(replanOfferStateOf([reply('a1', declined)], 'a1')).toBe('declined');
    expect(replanOfferStateOf([reply('a1', declined), reply('a2', offer())], 'a1')).toBe(
      'declined',
    );
  });
});

describe('latestUndecidedReplanOffer', () => {
  it('is the latest offer while undecided', () => {
    const o = offer();
    expect(latestUndecidedReplanOffer([reply('a1', offer()), reply('a2', o)])).toEqual({
      turnId: 'a2',
      offer: o,
    });
  });

  it('is null when there is no offer, or the latest one is declined', () => {
    expect(latestUndecidedReplanOffer([reply('a1')])).toBeNull();
    expect(
      latestUndecidedReplanOffer([reply('a1', offer({ declinedAt: '2026-10-15T00:00:00.000Z' }))]),
    ).toBeNull();
  });
});
