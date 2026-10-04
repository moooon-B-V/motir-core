import { describe, expect, it } from 'vitest';
import { toPlatformRunModelListDTO } from '@/lib/mappers/platformRunModelMappers';

/**
 * The hosted-run model list's page DTO (MOTIR-7525), as a pure function — the
 * adder's label and the not-offered entry, which the service suite reaches only
 * on its happy rows (MOTIR-7529).
 */

const createdAt = new Date('2026-10-04T09:00:00.000Z');
const offer = {
  models: [{ id: 'claude-opus-5-5', provider: 'anthropic' }],
  defaultsByDifficulty: { trivial: null, low: null, medium: null, high: 'claude-opus-5-5' },
};
const users = [
  { id: 'u-named', name: '  Ops Lead ', email: 'lead@moooon.net' },
  { id: 'u-blank', name: '  ', email: 'blank@moooon.net' },
];

describe('toPlatformRunModelListDTO', () => {
  it('labels the adder by name, by email when the name is blank, and null when gone', () => {
    const dto = toPlatformRunModelListDTO(
      [
        { model: 'claude-opus-5-5', addedById: 'u-named', createdAt },
        { model: 'glm-5.2', addedById: 'u-blank', createdAt },
        { model: 'kimi-k2.6', addedById: 'u-removed', createdAt },
      ],
      offer,
      [],
      users,
      false,
    );
    expect(dto.entries.map((e) => [e.model, e.addedBy, e.seeded])).toEqual([
      ['claude-opus-5-5', 'Ops Lead', false],
      ['glm-5.2', 'blank@moooon.net', false],
      ['kimi-k2.6', null, false],
    ]);
  });

  it('marks an entry motir-ai no longer offers, with no provider, and keeps its uses', () => {
    const dto = toPlatformRunModelListDTO(
      [{ model: 'glm-5.2', addedById: null, createdAt }],
      offer,
      [
        {
          identifier: 'ACME',
          name: 'Acme',
          hostedModelTrivial: 'glm-5.2',
          hostedModelLow: null,
          hostedModelMedium: null,
          hostedModelHigh: 'glm-5.2',
        },
      ],
      [],
      true,
    );
    expect(dto.entries[0]).toMatchObject({
      model: 'glm-5.2',
      provider: null,
      offered: false,
      seeded: true,
      platformDefaultLevels: [],
      projects: [{ projectKey: 'ACME', projectName: 'Acme', levels: ['trivial', 'high'] }],
    });
    expect(dto.addable).toEqual([{ id: 'claude-opus-5-5', provider: 'anthropic' }]);
    expect(dto.canEdit).toBe(true);
  });
});
