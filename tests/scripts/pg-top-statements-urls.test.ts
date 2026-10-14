import { describe, expect, it } from 'vitest';
import { hostOf, PgTopStatementsUsageError, resolveDirectUrl } from '../../scripts/pgTopStatements';

// MOTIR-8556 — the two unparseable-URL arms of `pg-top-statements`: a refusal
// that names the variable (never echoes the value, which carries credentials),
// and a host label that never throws.

describe('an unparseable connection string', () => {
  it('is refused as a usage error naming its variable, without the value', () => {
    const attempt = () => resolveDirectUrl({ DATABASE_URL_UNPOOLED: 'not a url p4ssw0rd' });
    expect(attempt).toThrow(PgTopStatementsUsageError);
    expect(attempt).toThrow('DATABASE_URL_UNPOOLED is not a parseable URL');
    expect(attempt).not.toThrow(/p4ssw0rd/);
  });

  it('hostOf labels it (unparseable) rather than throwing', () => {
    expect(hostOf('not a url')).toBe('(unparseable)');
  });
});
