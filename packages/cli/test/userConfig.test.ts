import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configPath,
  displayTokenPrefix,
  getAgentCommand,
  getCredential,
  listServers,
  normalizeServerUrl,
  readUserConfig,
  removeCredential,
  setCredential,
  writeUserConfig,
} from '../src/config/userConfig.js';

// The credential store. Point MOTIR_CONFIG_HOME at a temp dir so nothing
// touches a real home; assert the secret persists, the file is 0600, and the
// lookup/normalization rules hold.

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
});

afterEach(() => {
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe('userConfig', () => {
  it('reads an empty config when none exists', () => {
    expect(readUserConfig()).toEqual({ tokens: {} });
    expect(listServers()).toEqual([]);
    expect(getCredential('https://app.motir.co')).toBeUndefined();
  });

  it('persists a credential with 0600 perms and round-trips it', () => {
    setCredential('https://app.motir.co', {
      token: 'motir_pat_abc',
      user: { id: 'u1', name: 'Yue', email: 'yue@motir.co' },
    });
    const cred = getCredential('https://app.motir.co');
    expect(cred?.token).toBe('motir_pat_abc');
    expect(cred?.user?.email).toBe('yue@motir.co');

    const mode = statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('normalizes a trailing slash so the same server keys one entry', () => {
    expect(normalizeServerUrl('https://app.motir.co/')).toBe('https://app.motir.co');
    setCredential('https://app.motir.co/', { token: 'motir_pat_x' });
    expect(getCredential('https://app.motir.co')?.token).toBe('motir_pat_x');
    expect(listServers()).toEqual(['https://app.motir.co']);
  });

  it('removeCredential reports presence and clears the entry', () => {
    setCredential('https://a', { token: 'motir_pat_a' });
    expect(removeCredential('https://a')).toBe(true);
    expect(removeCredential('https://a')).toBe(false);
    expect(getCredential('https://a')).toBeUndefined();
  });

  it('displayTokenPrefix shows a short, non-reconstructable prefix', () => {
    expect(displayTokenPrefix('motir_pat_abcdefghijklmnop')).toBe('motir_pat_abcd…');
    expect(displayTokenPrefix('short')).toBe('short');
  });

  it('treats a corrupt config as empty instead of wedging every command', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(configPath(), '{ not json');
    expect(readUserConfig()).toEqual({ tokens: {} });
  });

  it('tolerates a config file with no tokens map', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ agentCommand: 'claude' }));
    expect(readUserConfig()).toEqual({ tokens: {}, agentCommand: 'claude' });
    expect(listServers()).toEqual([]);
  });

  it('falls back to XDG_CONFIG_HOME when MOTIR_CONFIG_HOME is unset', () => {
    delete process.env['MOTIR_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = home;
    expect(configPath()).toBe(join(home, 'motir', 'config.json'));
    delete process.env['XDG_CONFIG_HOME'];
  });
});

describe('agentCommand', () => {
  it('is undefined when unset, blank, or the wrong type', () => {
    expect(getAgentCommand()).toBeUndefined();
    writeUserConfig({ tokens: {}, agentCommand: '   ' });
    expect(getAgentCommand()).toBeUndefined();

    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ tokens: {}, agentCommand: 42 }));
    expect(readUserConfig().agentCommand).toBeUndefined();
  });

  it('round-trips a full agent command line', () => {
    writeUserConfig({ tokens: {}, agentCommand: 'claude --dangerously-skip-permissions' });
    expect(getAgentCommand()).toBe('claude --dangerously-skip-permissions');
  });

  it('SURVIVES a credential write — the config is rewritten wholesale', () => {
    writeUserConfig({ tokens: {}, agentCommand: 'codex --full-auto' });
    setCredential('https://app.motir.co', { token: 'motir_pat_abc' });
    expect(getAgentCommand()).toBe('codex --full-auto');
    removeCredential('https://app.motir.co');
    expect(getAgentCommand()).toBe('codex --full-auto');
  });
});
