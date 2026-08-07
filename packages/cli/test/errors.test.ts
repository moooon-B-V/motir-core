import { describe, expect, it } from 'vitest';
import { AuthError, CliError, NotLinkedError } from '../src/errors.js';

// ⚠️ This file also pinned `mcpEndpoint` — the `/api/mcp` URL builder — which
// went with the MCP transport (11.5.6). The `/api/v1` URL building that replaced
// it is asserted in `transport.test.ts`, where the builder lives.

describe('errors', () => {
  it('AuthError carries a re-login hint and exit code 1', () => {
    const e = new AuthError();
    expect(e).toBeInstanceOf(CliError);
    expect(e.exitCode).toBe(1);
    expect(e.hint).toMatch(/auth login/);
  });

  it('NotLinkedError points at `motir link`', () => {
    expect(new NotLinkedError().hint).toMatch(/motir link/);
  });

  it('CliError defaults to exit 1 and honors an override', () => {
    expect(new CliError('x').exitCode).toBe(1);
    expect(new CliError('x', { exitCode: 2 }).exitCode).toBe(2);
  });
});
