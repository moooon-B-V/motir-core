import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_TTL_MS,
  CLI_PACKAGE,
  REGISTRY_TIMEOUT_MS,
  REGISTRY_URL,
  announceStaleness,
  checkStaleness,
  defaultNotify,
  defaultPrefixWritable,
  defaultRun,
  compareVersions,
  fetchLatestVersion,
  globalPrefixDir,
  isOutdated,
  isWritable,
  pullAndRerunRecipe,
  isUnattendedArgv,
  readVersionCache,
  runSelfUpgrade,
  shouldCheckStaleness,
  stalenessNotice,
  versionCachePath,
  writeVersionCache,
} from '../src/staleness.js';

// A STALE CLI SAYS SO (MOTIR-4973 · MOTIR-4970).
//
// The reported failure was `Unknown command "login"` on a six-week-old install.
// Everything here exists so that the reader is told the actual problem instead —
// and so that being told never becomes a new way for the CLI to break.
//
// ⚠️ THE UNWRITABLE-PREFIX ARM IS DRIVEN WITH A REAL `chmod`, NOT A MOCK. The
// card asked for exactly that: the sandbox installs the CLI as root and drops to
// `USER node`, so the question is whether the upgrade WOULD work, and a
// "am I in a container" sniff answers a merely-correlated question.

const temp = (): string => mkdtempSync(join(tmpdir(), 'motir-staleness-'));

const ok = (version: unknown) => vi.fn(async () => ({ ok: true, json: async () => ({ version }) }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('compareVersions / isOutdated', () => {
  it('orders by numeric component, not lexically', () => {
    // The lexical trap: '0.10.0' < '0.9.0' as strings, and a CLI that believed
    // that would announce itself stale on the newest release ever published.
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('tolerates ragged and non-numeric input rather than throwing', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(compareVersions('what', '1.0.0')).toBe(-1);
  });

  it('says nothing when either side is missing', () => {
    expect(isOutdated('', '1.0.0')).toBe(false);
    expect(isOutdated('1.0.0', '')).toBe(false);
    expect(isOutdated('0.1.0', '0.5.0')).toBe(true);
    expect(isOutdated('0.5.0', '0.5.0')).toBe(false);
    expect(isOutdated('0.6.0', '0.5.0')).toBe(false);
  });
});

describe('fetchLatestVersion — every failure answers null', () => {
  it('reads the version off a healthy answer', async () => {
    const fetchImpl = ok('0.5.0');
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBe('0.5.0');
    expect(fetchImpl).toHaveBeenCalledWith(REGISTRY_URL, expect.anything());
  });

  it('answers null on a non-200', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it('answers null when the network throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it('answers null when the body will not parse', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    await expect(fetchLatestVersion(fetchImpl)).resolves.toBeNull();
  });

  it('answers null when the body carries no usable version', async () => {
    await expect(fetchLatestVersion(ok(undefined))).resolves.toBeNull();
    await expect(fetchLatestVersion(ok(42))).resolves.toBeNull();
    await expect(fetchLatestVersion(ok(''))).resolves.toBeNull();
  });

  it('is BOUNDED — it aborts rather than hanging the command it precedes', async () => {
    // The worst case is added to every invocation, so "slow" has to become
    // "silent" on its own. A registry that never answers must not mean a `motir`
    // that never starts.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ ok: boolean; json: () => Promise<unknown> }>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(fetchLatestVersion(fetchImpl, 5)).resolves.toBeNull();
    expect(REGISTRY_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('the cache — so this does NOT run on every invocation', () => {
  it('round-trips a fresh answer', () => {
    const path = join(temp(), 'nested', 'version-check.json');
    writeVersionCache('0.5.0', 1_000, path);
    expect(readVersionCache(1_000, path)).toBe('0.5.0');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ latest: '0.5.0', checkedAt: 1_000 });
  });

  it('expires at the stated TTL', () => {
    const path = join(temp(), 'version-check.json');
    writeVersionCache('0.5.0', 0, path);
    expect(readVersionCache(CACHE_TTL_MS - 1, path)).toBe('0.5.0');
    expect(readVersionCache(CACHE_TTL_MS, path)).toBeNull();
  });

  it('treats a missing, unparseable or mis-shaped file as no answer', () => {
    const dir = temp();
    expect(readVersionCache(0, join(dir, 'absent.json'))).toBeNull();

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, 'not json');
    expect(readVersionCache(0, broken)).toBeNull();

    const shaped = join(dir, 'shaped.json');
    writeFileSync(shaped, JSON.stringify({ latest: 5, checkedAt: 'soon' }));
    expect(readVersionCache(0, shaped)).toBeNull();
  });

  it('does not fail the command when the state home cannot be written', () => {
    // The sandbox mounts the CONFIG dir read-only, and a locked-down state home
    // is the same shape. A cache that cannot be written is a reason to ask again
    // next time, never an error.
    const dir = temp();
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    expect(() => writeVersionCache('0.5.0', 0, join(locked, 'x.json'))).not.toThrow();
    chmodSync(locked, 0o755);
  });

  it('lives in the STATE home, not beside the credential', () => {
    expect(versionCachePath().endsWith(join('motir', 'version-check.json'))).toBe(true);
  });
});

describe('can this install upgrade itself?', () => {
  it('resolves the global npm root from the running node', () => {
    expect(globalPrefixDir(join('/usr', 'local', 'bin', 'node'))).toBe(
      join('/usr', 'local', 'lib', 'node_modules'),
    );
  });

  it('answers by WRITABILITY — a real chmod, not a container sniff', () => {
    const dir = temp();
    expect(isWritable(dir)).toBe(true);
    chmodSync(dir, 0o555);
    expect(isWritable(dir)).toBe(false);
    chmodSync(dir, 0o755);
    expect(isWritable(join(dir, 'does-not-exist'))).toBe(false);
  });
});

describe('checkStaleness', () => {
  const base = {
    now: () => 1_000,
    writeCache: () => {},
    prefixWritable: () => true,
  };

  it('prefers the cache and does NOT reach the registry', async () => {
    const fetchImpl = ok('0.5.0');
    const check = await checkStaleness({
      ...base,
      current: '0.1.0',
      readCache: () => '0.5.0',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(check.notice).toBe(stalenessNotice('0.1.0', '0.5.0'));
    expect(check.canUpgrade).toBe(true);
  });

  it('fetches on a cache miss and remembers a real answer', async () => {
    const writeCache = vi.fn();
    const check = await checkStaleness({
      ...base,
      current: '0.1.0',
      readCache: () => null,
      fetchImpl: ok('0.5.0'),
      writeCache,
    });
    expect(writeCache).toHaveBeenCalledWith('0.5.0', 1_000);
    expect(check.latest).toBe('0.5.0');
  });

  it('does NOT cache a failure — one blink must not silence six hours', async () => {
    const writeCache = vi.fn();
    const check = await checkStaleness({
      ...base,
      current: '0.1.0',
      readCache: () => null,
      fetchImpl: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
      writeCache,
    });
    expect(writeCache).not.toHaveBeenCalled();
    expect(check.notice).toBeNull();
    expect(check.canUpgrade).toBe(false);
  });

  it('says nothing when this install is current or ahead', async () => {
    const current = await checkStaleness({ ...base, current: '0.5.0', readCache: () => '0.5.0' });
    expect(current.notice).toBeNull();
    const ahead = await checkStaleness({ ...base, current: '0.6.0', readCache: () => '0.5.0' });
    expect(ahead.notice).toBeNull();
  });

  it('withholds the upgrade offer when the prefix is not writable', async () => {
    const check = await checkStaleness({
      ...base,
      current: '0.1.0',
      readCache: () => '0.5.0',
      prefixWritable: () => false,
    });
    expect(check.notice).not.toBeNull();
    expect(check.canUpgrade).toBe(false);
  });
});

describe('announceStaleness', () => {
  const stale = {
    now: () => 0,
    current: '0.1.0',
    readCache: () => '0.5.0',
    writeCache: () => {},
  };

  const lines = () => {
    const captured: string[] = [];
    return { captured, notify: (line: string) => captured.push(line) };
  };

  it('prints nothing at all when the install is current', async () => {
    const { captured, notify } = lines();
    await announceStaleness({ ...stale, current: '0.5.0', notify });
    expect(captured).toEqual([]);
  });

  it('names BOTH versions — that is the whole job', async () => {
    const { captured, notify } = lines();
    await announceStaleness({ ...stale, notify, prefixWritable: () => true });
    expect(captured[0]).toContain('0.1.0');
    expect(captured[0]).toContain('0.5.0');
    expect(captured[0]).toContain(CLI_PACKAGE);
  });

  it('prints the pull-and-rerun recipe instead of an offer that would fail', async () => {
    const { captured, notify } = lines();
    const upgrade = vi.fn(() => ({ ok: true }));
    await announceStaleness({
      ...stale,
      notify,
      prefixWritable: () => false,
      interactive: () => true,
      confirm: async () => 'y',
      upgrade,
    });
    const text = captured.join('\n');
    expect(text).toContain('--pull=always');
    expect(text).toContain('motir-auth:/home/node/.config/motir');
    expect(text).not.toContain('npm install -g');
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('NEVER prompts without a TTY, and still prints the notice', async () => {
    // The unattended case: a prompt here hangs a loop nobody is watching, but
    // the notice is what makes a stale CI agent diagnosable.
    const { captured, notify } = lines();
    const confirm = vi.fn(async () => 'y');
    await announceStaleness({
      ...stale,
      notify,
      prefixWritable: () => true,
      interactive: () => false,
      confirm,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(captured[0]).toContain('0.5.0');
  });

  it('never prompts when the caller supplies no confirm at all', async () => {
    const { captured, notify } = lines();
    await announceStaleness({
      ...stale,
      notify,
      prefixWritable: () => true,
      interactive: () => true,
    });
    expect(captured.join('\n')).toContain('npm install -g');
  });

  it('upgrades on yes and reports the new version', async () => {
    const { captured, notify } = lines();
    const upgrade = vi.fn(() => ({ ok: true, version: '0.5.0' }));
    await announceStaleness({
      ...stale,
      notify,
      prefixWritable: () => true,
      interactive: () => true,
      confirm: async () => ' Y \n',
      upgrade,
    });
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(captured.join('\n')).toContain('Upgraded to 0.5.0');
  });

  it('leaves the command alone on no', async () => {
    const { captured, notify } = lines();
    const upgrade = vi.fn(() => ({ ok: true }));
    await announceStaleness({
      ...stale,
      notify,
      prefixWritable: () => true,
      interactive: () => true,
      confirm: async () => '',
      upgrade,
    });
    expect(upgrade).not.toHaveBeenCalled();
    expect(captured.join('\n')).not.toContain('Upgraded');
  });

  it('a FAILED upgrade is still not fatal', async () => {
    const { captured, notify } = lines();
    await announceStaleness({
      ...stale,
      notify,
      prefixWritable: () => true,
      interactive: () => true,
      confirm: async () => 'yes',
      upgrade: () => ({ ok: false }),
    });
    expect(captured.join('\n')).toContain('Upgrade failed');
    expect(captured.join('\n')).toContain('continuing on');
  });
});

describe('the real IO seams', () => {
  it('probes the running node’s own global root', () => {
    // Whatever this box answers, the point is that it ANSWERS — a probe that
    // throws would take down every command instead of withholding an offer.
    expect(typeof defaultPrefixWritable()).toBe('boolean');
  });

  it('writes a notice to stderr, never to stdout', () => {
    // stdout is the payload channel (`output.ts`). A courtesy notice that
    // corrupted a piped `--json` read would be worse than the staleness it
    // reports.
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    defaultNotify('hello');
    expect(err).toHaveBeenCalledWith('hello\n');
    expect(out).not.toHaveBeenCalled();
  });

  it('really does shell out', () => {
    // Driven against `node --version` rather than a package install: it proves
    // the wrapper without mutating this machine's global prefix.
    expect(defaultRun(process.execPath, ['--version']).trim()).toBe(process.version);
  });
});

describe('runSelfUpgrade', () => {
  it('reports success when the package manager exits clean', () => {
    const run = vi.fn(() => '');
    expect(runSelfUpgrade(run)).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('npm', ['install', '-g', `${CLI_PACKAGE}@latest`]);
  });

  it('turns an EACCES into a VALUE, never an exception', () => {
    // This runs inside a courtesy notice. It may not take down the command the
    // user actually typed.
    expect(
      runSelfUpgrade(() => {
        throw new Error('EACCES: permission denied');
      }),
    ).toEqual({ ok: false });
  });
});

describe('which argv gets a version check at all', () => {
  it('never checks for --version, --help or a bare `motir`', () => {
    // ⚠️ `--version` ABOVE ALL: the cheapest command in the CLI has to stay the
    // cheapest. A version flag that waited on a registry round-trip in order to
    // announce that a newer version exists would be a self-parody.
    for (const argv of [
      [],
      ['--version'],
      ['-v'],
      ['--help'],
      ['-h'],
      ['help'],
      ['help', 'auth'],
    ]) {
      expect(shouldCheckStaleness(argv), argv.join(' ') || '(bare)').toBe(false);
    }
  });

  it('checks for the commands a stale CLI actually breaks', () => {
    for (const argv of [['login'], ['run'], ['auto'], ['batch'], ['doctor']]) {
      expect(shouldCheckStaleness(argv), argv.join(' ')).toBe(true);
    }
  });

  it('marks the loop lanes UNATTENDED so they are notified but never prompted', () => {
    expect(isUnattendedArgv(['auto'])).toBe(true);
    expect(isUnattendedArgv(['batch'])).toBe(true);
    expect(isUnattendedArgv(['run'])).toBe(false);
    expect(isUnattendedArgv([])).toBe(false);
  });
});

describe('the recipe is TRANSCRIBED, and the unattended lanes are never prompted', () => {
  it('quotes the disposable recipe MOTIR-4972 settled', () => {
    const text = pullAndRerunRecipe().join('\n');
    expect(text).toContain('docker run -it --rm --pull=always');
    expect(text).toContain('-v "$PWD:/workspace"');
    expect(text).toContain('-v motir-auth:/home/node/.config/motir');
    expect(text).not.toContain('--name');
    expect(text).not.toContain('docker start');
  });
});
