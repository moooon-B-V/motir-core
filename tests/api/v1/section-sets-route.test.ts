import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/section-sets/route';
import { presentSectionSets } from '@/lib/api/v1/sectionSets/schema';
import { sectionSchemaService } from '@/lib/services/sectionSchemaService';
import { createV1Caller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/section-sets (MOTIR-9029). Real Postgres, real PATs.

const URL = 'http://localhost:3000/api/v1/section-sets';

describe('GET /api/v1/section-sets', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the descriptor the service builds', async () => {
    const caller = await createV1Caller();
    const res = await GET(new Request(URL, { headers: caller.headers }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(presentSectionSets(sectionSchemaService.describe()));
  });

  it('narrows to a cell', async () => {
    const caller = await createV1Caller();
    const res = await GET(new Request(`${URL}?kind=task&type=code`, { headers: caller.headers }));
    const body = (await res.json()) as { sets: { kind: string; type: string }[] };
    expect(body.sets).toHaveLength(1);
    expect(body.sets[0]).toMatchObject({ kind: 'task', type: 'code' });
  });

  it('refuses an unauthenticated call', async () => {
    const res = await GET(new Request(URL));
    expect(res.status).toBe(401);
  });

  it('is a 422 UNKNOWN_SECTION_CELL in the v1 envelope on an unknown kind', async () => {
    const caller = await createV1Caller();
    const res = await GET(new Request(`${URL}?kind=nope`, { headers: caller.headers }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'UNKNOWN_SECTION_CELL' });
  });
});
