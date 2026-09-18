import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { uniqueViolationConstraints } from '@/lib/prisma/uniqueViolation';

// `uniqueViolationConstraints` — the ONE reader of which constraint a `P2002`
// violated (MOTIR-5273). Every shape the client has been measured to produce is
// handed to it here, so a client upgrade that moves the name breaks this file
// rather than silently retiring every classifier that asks it.

function p2002(meta: Record<string, unknown> | undefined): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta,
  });
}

/** The driver-adapter shape, as MEASURED under Prisma 7.8 / 7.9 + adapter-pg. */
function driverMeta(constraint: string): Record<string, unknown> {
  return {
    modelName: 'ProjectRepo',
    driverAdapterError: {
      cause: {
        originalCode: '23505',
        originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
        kind: 'UniqueConstraintViolation',
      },
    },
  };
}

describe('uniqueViolationConstraints', () => {
  it('reads `meta.target` when it is the COLUMN LIST', () => {
    expect(uniqueViolationConstraints(p2002({ target: ['project_id', 'name'] }))).toEqual([
      'project_id',
      'name',
    ]);
  });

  it('reads `meta.target` when it is the INDEX NAME', () => {
    expect(uniqueViolationConstraints(p2002({ target: 'public_address_hostname_key' }))).toEqual([
      'public_address_hostname_key',
    ]);
  });

  it('reads the constraint out of the DRIVER error when `meta.target` is absent — the ordinary case under this client', () => {
    expect(
      uniqueViolationConstraints(
        p2002(driverMeta('project_repository_project_id_github_repo_id_key')),
      ),
    ).toEqual(['project_repository_project_id_github_repo_id_key']);
  });

  it('falls through an EMPTY `meta.target` to the driver error rather than stopping at it', () => {
    expect(
      uniqueViolationConstraints(
        p2002({ target: [], ...driverMeta('project_repository_project_id_name_key') }),
      ),
    ).toEqual(['project_repository_project_id_name_key']);
    expect(
      uniqueViolationConstraints(
        p2002({ target: '', ...driverMeta('project_repository_project_id_name_key') }),
      ),
    ).toEqual(['project_repository_project_id_name_key']);
  });

  it('takes only the QUOTED identifier, so a localized message still classifies', () => {
    const meta = {
      driverAdapterError: {
        cause: {
          originalMessage: 'llave duplicada viola restricción de unicidad "the_real_key"',
        },
      },
    };
    expect(uniqueViolationConstraints(p2002(meta))).toEqual(['the_real_key']);
  });

  it('answers null — never a guess — when neither layer names a constraint', () => {
    expect(uniqueViolationConstraints(p2002({ modelName: 'ProjectRepo' }))).toBeNull();
    expect(uniqueViolationConstraints(p2002(undefined))).toBeNull();
    expect(
      uniqueViolationConstraints(
        p2002({ driverAdapterError: { cause: { originalMessage: 'no quotes' } } }),
      ),
    ).toBeNull();
  });

  it('answers null for anything that is not a P2002', () => {
    expect(uniqueViolationConstraints(new Error('boom'))).toBeNull();
    expect(uniqueViolationConstraints(null)).toBeNull();
    expect(
      uniqueViolationConstraints(
        new Prisma.PrismaClientKnownRequestError('fk', {
          code: 'P2003',
          clientVersion: 'test',
          meta: { target: ['name'] },
        }),
      ),
    ).toBeNull();
  });

  it('narrows STRUCTURALLY — a plain object shaped like the error is read too', () => {
    expect(uniqueViolationConstraints({ code: 'P2002', meta: { target: ['hostname'] } })).toEqual([
      'hostname',
    ]);
  });
});
