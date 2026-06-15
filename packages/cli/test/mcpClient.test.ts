import { describe, expect, it } from 'vitest';
import { mcpEndpoint } from '../src/mcpClient.js';
import { AuthError, CliError, NotLinkedError } from '../src/errors.js';

describe('mcpEndpoint', () => {
  it('derives /api/mcp from a server base, trailing slash or not', () => {
    expect(mcpEndpoint('https://app.motir.co').toString()).toBe('https://app.motir.co/api/mcp');
    expect(mcpEndpoint('https://app.motir.co/').toString()).toBe('https://app.motir.co/api/mcp');
    expect(mcpEndpoint('http://localhost:3000').toString()).toBe('http://localhost:3000/api/mcp');
  });
});

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
