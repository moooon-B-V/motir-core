import { describe, expect, it } from 'vitest';
import * as route from '@/app/api/mcp/route';

// Endpoint wiring smoke test (Subtask 7.8.4). Importing the route evaluates the
// real `createMcpHandler` + `withMcpAuth` composition at module load, so this
// catches a broken transport/auth wiring that typecheck can't (a bad mcp-handler
// option shape, a missing export). The behavioural auth + tool tests live in
// auth.test.ts / tools.test.ts.

describe('app/api/mcp/route', () => {
  it('exports a single auth-wrapped handler for GET / POST / DELETE', () => {
    expect(typeof route.GET).toBe('function');
    expect(route.GET).toBe(route.POST);
    expect(route.POST).toBe(route.DELETE);
  });

  it('runs on the Node runtime and is force-dynamic (never cached)', () => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});
