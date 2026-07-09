import { describe, expect, it } from 'vitest';
import {
  IMPORT_RETURN_DEFAULT,
  appendStatus,
  safeImportReturnPath,
} from '@/lib/import/oauthReturn';

// Story 7.16 · MOTIR-942 — the import OAuth return-path guard. The value becomes
// a URL a signed-in member is redirected to after the connect round-trip, so the
// open-redirect surface is the whole point: anything that could name another
// origin MUST fall back to the wizard home.

describe('safeImportReturnPath', () => {
  it('accepts the wizard home and preserves its query (resume params survive)', () => {
    expect(safeImportReturnPath('/onboarding/import')).toBe('/onboarding/import');
    expect(safeImportReturnPath('/onboarding/import?projectId=abc123')).toBe(
      '/onboarding/import?projectId=abc123',
    );
  });

  it('accepts a future Settings › Project › Import door (any /settings/ path)', () => {
    expect(safeImportReturnPath('/settings/project/import')).toBe('/settings/project/import');
    expect(safeImportReturnPath('/settings/project/import?projectId=x')).toBe(
      '/settings/project/import?projectId=x',
    );
  });

  it('falls back to the default for a missing / empty value', () => {
    expect(safeImportReturnPath(null)).toBe(IMPORT_RETURN_DEFAULT);
    expect(safeImportReturnPath(undefined)).toBe(IMPORT_RETURN_DEFAULT);
    expect(safeImportReturnPath('')).toBe(IMPORT_RETURN_DEFAULT);
  });

  it('rejects an off-allowlist internal path (not a wizard door)', () => {
    expect(safeImportReturnPath('/dashboard')).toBe(IMPORT_RETURN_DEFAULT);
    expect(safeImportReturnPath('/issues?foo=bar')).toBe(IMPORT_RETURN_DEFAULT);
  });

  it('rejects the open-redirect class — absolute, protocol-relative, backslash, scheme', () => {
    expect(safeImportReturnPath('https://evil.example.com')).toBe(IMPORT_RETURN_DEFAULT);
    expect(safeImportReturnPath('//evil.example.com')).toBe(IMPORT_RETURN_DEFAULT);
    expect(safeImportReturnPath('/\\evil.example.com')).toBe(IMPORT_RETURN_DEFAULT);
    expect(safeImportReturnPath('/onboarding/import\\@evil.com')).toBe(IMPORT_RETURN_DEFAULT);
    expect(safeImportReturnPath('javascript:alert(1)')).toBe(IMPORT_RETURN_DEFAULT);
  });

  it('rejects a URL-encoded protocol-relative bypass (decodes one layer first)', () => {
    // %2F%2Fevil → //evil after one decode
    expect(safeImportReturnPath('%2F%2Fevil.example.com')).toBe(IMPORT_RETURN_DEFAULT);
    // A double-encoded value stays a non-path string after one decode → default.
    expect(safeImportReturnPath('%252F%252Fevil')).toBe(IMPORT_RETURN_DEFAULT);
  });

  it('rejects a control character smuggled into the path', () => {
    expect(safeImportReturnPath('/onboarding/import\n/x')).toBe(IMPORT_RETURN_DEFAULT);
    expect(safeImportReturnPath('/settings/\tx')).toBe(IMPORT_RETURN_DEFAULT);
  });
});

describe('appendStatus', () => {
  it('adds the first query param with ?', () => {
    expect(appendStatus('/onboarding/import', 'jira', 'connected')).toBe(
      '/onboarding/import?jira=connected',
    );
  });

  it('appends with & when a query already exists', () => {
    expect(appendStatus('/onboarding/import?projectId=x', 'jira', 'connected')).toBe(
      '/onboarding/import?projectId=x&jira=connected',
    );
  });

  it('keeps the hash after the appended param', () => {
    expect(appendStatus('/onboarding/import#step', 'import', 'plane_connected')).toBe(
      '/onboarding/import?import=plane_connected#step',
    );
  });

  it('encodes the status value', () => {
    expect(appendStatus('/onboarding/import', 'jira', 'a b')).toBe('/onboarding/import?jira=a%20b');
  });
});
