import { describe, expect, it } from 'vitest';
import {
  toPlatformEnterpriseRequestDTO,
  toPlatformEnterpriseRequestMoveDTO,
} from '@/lib/mappers/platformMappers';
import type { EnterpriseRequestWithParties } from '@/lib/repositories/enterpriseRequestRepository';
import type { PlatformAuditLogWithActor } from '@/lib/repositories/platformAuditLogRepository';

/**
 * The Enterprise-request console's mappers (MOTIR-7608) on the rows the
 * service tests rarely reach: a request whose sender's account is gone, a
 * closed request, and History rows a later build wrote in a shape this one
 * does not know.
 */

const AT = new Date('2026-10-05T10:00:00.000Z');

function request(overrides: Partial<EnterpriseRequestWithParties> = {}) {
  return {
    id: 'er_1',
    organizationId: 'org_1',
    requestedById: 'u_1',
    status: 'new',
    cardsPerDay: 40,
    parallelAgents: 4,
    agentPath: 'hosted',
    autonomy: 'unsure',
    startWhen: 'now',
    teamSize: 'size_11_50',
    contact: 'ada@example.com',
    note: 'Please call.',
    tierKeyAtRequest: 'team',
    createdAt: AT,
    updatedAt: AT,
    closedAt: null,
    organization: { name: 'Acme' },
    requestedBy: { id: 'u_1', name: 'Ada', email: 'ada@example.com' },
    ...overrides,
  } as EnterpriseRequestWithParties;
}

function move(metadata: unknown) {
  return {
    id: 'log_1',
    seq: 1n,
    actorUserId: 'staff_1',
    action: 'enterprise_request.transition',
    metadata,
    createdAt: AT,
    actor: { name: 'Op', email: 'ops@moooon.net' },
  } as unknown as PlatformAuditLogWithActor;
}

describe('toPlatformEnterpriseRequestDTO', () => {
  it('maps an open request with its sender', () => {
    const dto = toPlatformEnterpriseRequestDTO(request());
    expect(dto.requester).toEqual({ id: 'u_1', name: 'Ada', email: 'ada@example.com' });
    expect(dto.organizationName).toBe('Acme');
    expect(dto.createdAt).toBe(AT.toISOString());
    expect(dto.closedAt).toBeNull();
  });

  it('keeps a request whose sender is gone, and dates a closed one', () => {
    const closed = new Date('2026-10-06T09:00:00.000Z');
    const dto = toPlatformEnterpriseRequestDTO(
      request({ requestedById: null, requestedBy: null, status: 'won', closedAt: closed }),
    );
    expect(dto.requester).toBeNull();
    expect(dto.closedAt).toBe(closed.toISOString());
  });
});

describe('toPlatformEnterpriseRequestMoveDTO', () => {
  it('maps a known move', () => {
    expect(toPlatformEnterpriseRequestMoveDTO(move({ from: 'new', to: 'contacted' }))).toEqual({
      from: 'new',
      to: 'contacted',
      actorUserId: 'staff_1',
      actorName: 'Op',
      actorEmail: 'ops@moooon.net',
      at: AT.toISOString(),
    });
  });

  it.each([
    ['no metadata', null],
    ['no from', { to: 'contacted' }],
    ['an unknown from', { from: 'qualified', to: 'contacted' }],
    ['a non-string to', { from: 'new', to: 3 }],
    ['an unknown to', { from: 'new', to: 'archived' }],
  ])('leaves out a row with %s', (_label, metadata) => {
    expect(toPlatformEnterpriseRequestMoveDTO(move(metadata))).toBeNull();
  });
});
