import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { endpointHost, endpointHostList } from '@/loadtest/lib/endpointHost';
import {
  EXIT,
  OPTIONS,
  formatLine,
  parsePrintenv,
  runPreflight,
  sentryProjectId,
  type FlyRunner,
} from '@/loadtest/preflight/sideEffects';
import {
  PROVISIONING_SET_NAMES,
  REQUIRED_SET,
  ROW_IDS,
  SWITCH_TABLE,
  renderSecretsTemplate,
  tableKeys,
  templateDoNotSetNames,
  templateSetNames,
} from '@/loadtest/staging/sideEffectSwitches';

// The staging side-effect preflight (Story MOTIR-8538 · MOTIR-8672), over a stubbed
// `fly` runner. The real command reads a deployed app; here every platform reply is
// a fixture, so each row's live state can be produced on purpose.

const APP = 'motir-core-staging';
const STAGING_HOST = 'ep-staging-1.us-east-2.aws.neon.tech';
const PROD_HOST = 'ep-prod-9.us-east-2.aws.neon.tech';
const PROD_SENTRY = '4501';

const CONFIG_ENV = {
  LOADTEST_STAGING_APP: APP,
  LOADTEST_ALLOWED_DB_HOST: STAGING_HOST,
  LOADTEST_PRODUCTION_DB_HOSTS: `${PROD_HOST},ep-prod-9-pooler.us-east-2.aws.neon.tech`,
  LOADTEST_PRODUCTION_SENTRY_PROJECT_ID: PROD_SENTRY,
};

/** A machine environment holding every sink state, with distinctive secret values. */
function sinkEnv(): Record<string, string> {
  return {
    EMAIL_PROVIDER: 'console',
    SENTRY_DSN: 'https://secretkey123@o9.ingest.sentry.io/7777',
    SENTRY_ENVIRONMENT: 'staging',
    DATABASE_URL: `postgresql://motir_app:pw-runtime-secret@ep-staging-1-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`,
    DATABASE_URL_UNPOOLED: `postgresql://neondb_owner:pw-owner-secret@${STAGING_HOST}/neondb?sslmode=require`,
    BETTER_AUTH_SECRET: 'auth-secret-value-xyz',
    GOOGLE_CLIENT_ID: 'placeholder-google-id',
    GOOGLE_CLIENT_SECRET: 'placeholder-google-secret',
    MOTIR_BASE_URL: 'http://motir-core-staging.flycast',
    MOTIR_API_V1_RATE_LIMIT: '6000',
    SENTRY_TRACES_SAMPLE_RATE: '0.1',
    NODE_ENV: 'production',
    FLY_MACHINE_ID: 'm-app-1',
  };
}

interface Stub {
  machines?: Array<{ id: string; group: string; state?: string }>;
  envs?: Record<string, Record<string, string> | 'fail'>;
  secrets?: string[] | 'fail';
  listFails?: boolean;
}

function stubFly(stub: Stub): { fly: FlyRunner; calls: string[][] } {
  const calls: string[][] = [];
  const machines = stub.machines ?? [
    { id: 'm-app-1', group: 'app' },
    { id: 'm-worker-1', group: 'worker' },
  ];
  const fly: FlyRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'machine') {
      if (stub.listFails) return { code: 1, stdout: '', stderr: 'boom' };
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify(
          machines.map((m) => ({
            id: m.id,
            state: m.state ?? 'started',
            config: {
              metadata: { fly_process_group: m.group },
              image: 'registry.fly.io/motir-core:abc',
            },
            image_ref: { digest: `sha256:${m.id}` },
          })),
        ),
      };
    }
    if (args[0] === 'secrets') {
      if (stub.secrets === 'fail') return { code: 1, stdout: '', stderr: 'denied' };
      const names = stub.secrets ?? templateSetNames();
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify(names.map((Name) => ({ Name, Digest: 'd' }))),
      };
    }
    if (args[0] === 'ssh') {
      const id = args[args.indexOf('--machine') + 1]!;
      const env = stub.envs?.[id] ?? sinkEnv();
      if (env === 'fail') return { code: 1, stdout: '', stderr: 'ssh: connection refused' };
      return {
        code: 0,
        stderr: '',
        stdout: Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
      };
    }
    throw new Error(`unexpected fly ${args.join(' ')}`);
  };
  return { fly, calls };
}

const NOW = () => new Date('2026-10-15T20:00:00Z');

async function run(
  stub: Stub,
  env: Record<string, string | undefined> = CONFIG_ENV,
  argv = ['--app', APP],
) {
  const { fly, calls } = stubFly(stub);
  const outcome = await runPreflight(argv, env, fly, NOW);
  const printed = outcome.lines.map(formatLine).join('\n') + '\n' + outcome.message;
  return { outcome, calls, printed };
}

describe('endpointHost', () => {
  it('removes a -pooler suffix from the first label and nothing else', () => {
    expect(endpointHost('ep-x-pooler.region.aws.neon.tech')).toBe('ep-x.region.aws.neon.tech');
    expect(endpointHost('ep-x.region.aws.neon.tech')).toBe('ep-x.region.aws.neon.tech');
    expect(endpointHost('postgresql://u:p@ep-x-pooler.region.aws.neon.tech:5432/db')).toBe(
      'ep-x.region.aws.neon.tech',
    );
    expect(endpointHost('db.example-pooler.com')).toBe('db.example-pooler.com');
    expect(endpointHost('')).toBeNull();
    expect(endpointHost('postgresql://[bad')).toBeNull();
    expect(endpointHostList(' a-pooler.x , ,b.y')).toEqual(['a.x', 'b.y']);
  });
});

describe('the switch table', () => {
  it('has exactly the nine row ids, in order, each with a seam and a reason', () => {
    expect(SWITCH_TABLE.map((r) => r.id)).toEqual([...ROW_IDS]);
    expect(ROW_IDS).toEqual([
      'email',
      'github',
      'sentry',
      'motir-ai',
      'fleet',
      'billing',
      'database',
      'stored-credentials',
      'provider-seams',
    ]);
    for (const row of SWITCH_TABLE) {
      expect(row.seams.length, row.id).toBeGreaterThan(0);
      expect(row.why.length, row.id).toBeGreaterThan(20);
      expect(row.keys.length > 0 || row.coveredBy !== undefined, row.id).toBe(true);
    }
    expect(new Set(tableKeys()).size).toBe(tableKeys().length);
  });

  it('generates the checked-in template, and the template holds every table key', () => {
    const file = readFileSync(
      resolve(__dirname, '../../loadtest/staging/staging.secrets.example'),
      'utf8',
    );
    expect(file).toBe(renderSecretsTemplate());
    for (const key of [...tableKeys(), ...REQUIRED_SET.map((r) => r.key)]) {
      expect(file, key).toContain(key);
    }
    const setNames = [...file.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(setNames.sort()).toEqual([...templateSetNames()].sort());
    for (const key of templateDoNotSetNames()) expect(setNames).not.toContain(key);
  });

  it("the template's set names are the provisioning card's list, exactly", () => {
    expect([...templateSetNames()].sort()).toEqual([...PROVISIONING_SET_NAMES].sort());
  });

  it('exports the CLI options', () => {
    expect(OPTIONS.app.flag).toBe('--app');
  });
});

describe('runPreflight', () => {
  it('exits 0 with one PASS line per row × machine when every machine holds the sink state', async () => {
    const { outcome, printed } = await run({});
    expect(outcome.exitCode).toBe(EXIT.ok);
    for (const machine of ['m-app-1', 'm-worker-1']) {
      for (const id of ROW_IDS) {
        const line = outcome.lines.find((l) => l.row === id && l.machineId === machine);
        expect(line?.verdict, `${id}@${machine}`).toBe('PASS');
        expect(line?.image).toBe(`sha256:${machine}`);
        expect(line?.readAt).toBe('2026-10-15T20:00:00.000Z');
      }
    }
    expect(printed).toContain('machine=m-app-1 image=sha256:m-app-1 read=2026-10-15T20:00:00.000Z');
  });

  const liveCases: Array<[string, string, Record<string, string | undefined>]> = [
    ['email', 'EMAIL_PROVIDER=resend', { EMAIL_PROVIDER: 'resend' }],
    [
      'github',
      'a GITHUB_*APP* key',
      { GITHUB_STUDIO_APP_PRIVATE_KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----' },
    ],
    [
      'sentry',
      "production's Sentry project",
      { SENTRY_DSN: `https://k@o1.ingest.sentry.io/${PROD_SENTRY}` },
    ],
    ['motir-ai', 'MOTIR_AI_URL', { MOTIR_AI_URL: 'https://ai.internal' }],
    ['fleet', 'FLY_FLEET_API_TOKEN', { FLY_FLEET_API_TOKEN: 'fo1_token' }],
    [
      'stored-credentials',
      'GITHUB_TOKEN_ENCRYPTION_KEY',
      { GITHUB_TOKEN_ENCRYPTION_KEY: 'deadbeef' },
    ],
    [
      'database',
      'a production host',
      { DATABASE_URL: `postgresql://u:p@ep-prod-9-pooler.us-east-2.aws.neon.tech/db` },
    ],
    [
      'database',
      'a pooled host that is not staging',
      { DATABASE_URL: 'postgresql://u:p@ep-other-3-pooler.x.aws.neon.tech/db' },
    ],
    [
      'database',
      "production's direct host on the unpooled URL",
      { DATABASE_URL_UNPOOLED: `postgresql://u:p@${PROD_HOST}/db` },
    ],
  ];

  for (const [row, label, patch] of liveCases) {
    it(`exits 2 and names ${row} on the machine holding ${label}`, async () => {
      const env = { ...sinkEnv(), ...patch } as Record<string, string>;
      const { outcome } = await run({ envs: { 'm-app-1': env } });
      expect(outcome.exitCode).toBe(EXIT.live);
      const line = outcome.lines.find((l) => l.row === row && l.machineId === 'm-app-1');
      expect(line?.verdict).toBe('LIVE');
      expect(
        outcome.lines.find((l) => l.row === row && l.machineId === 'm-worker-1')?.verdict,
      ).toBe('PASS');
      expect(outcome.message).toContain(`${row}@m-app-1`);
    });
  }

  it('the billing row follows the motir-ai row', async () => {
    const { outcome } = await run({
      envs: { 'm-app-1': { ...sinkEnv(), MOTIR_AI_SERVICE_TOKEN: 't' } },
    });
    expect(
      outcome.lines.find((l) => l.row === 'billing' && l.machineId === 'm-app-1')?.verdict,
    ).toBe('LIVE');
  });

  it('passes a pooled URL whose stripped host equals the staging host', async () => {
    const { outcome } = await run({});
    expect(
      outcome.lines.find((l) => l.row === 'database' && l.machineId === 'm-app-1')?.verdict,
    ).toBe('PASS');
  });

  it('a live value on a worker machine alone still exits 2', async () => {
    const { outcome } = await run({
      envs: { 'm-worker-1': { ...sinkEnv(), RESEND_API_KEY: 're_live' } },
    });
    expect(outcome.exitCode).toBe(EXIT.live);
    expect(
      outcome.lines.find((l) => l.row === 'email' && l.machineId === 'm-worker-1')?.verdict,
    ).toBe('LIVE');
  });

  it('an extra secret name exits 2 and names it; a missing required name is MISSING', async () => {
    const extra = await run({ secrets: [...templateSetNames(), 'STRIPE_SECRET_KEY'] });
    expect(extra.outcome.exitCode).toBe(EXIT.live);
    expect(extra.printed).toContain('STRIPE_SECRET_KEY');

    const missing = await run({
      secrets: templateSetNames().filter((n) => n !== 'BETTER_AUTH_SECRET'),
    });
    expect(missing.outcome.exitCode).toBe(EXIT.live);
    const line = missing.outcome.lines.find((l) => l.verdict === 'MISSING');
    expect(line?.detail).toContain('BETTER_AUTH_SECRET');

    const env = sinkEnv();
    delete env['BETTER_AUTH_SECRET'];
    const machineMissing = await run({ envs: { 'm-app-1': env } });
    expect(machineMissing.outcome.exitCode).toBe(EXIT.live);
    expect(
      machineMissing.outcome.lines.find(
        (l) => l.row === 'required-set' && l.machineId === 'm-app-1',
      )?.verdict,
    ).toBe('MISSING');
  });

  it('an ssh failure, no started machine or an unreadable secret list each exit 4, never 0', async () => {
    expect((await run({ envs: { 'm-worker-1': 'fail' } })).outcome.exitCode).toBe(EXIT.unread);
    expect(
      (await run({ machines: [{ id: 'm-app-1', group: 'app', state: 'stopped' }] })).outcome
        .exitCode,
    ).toBe(EXIT.unread);
    expect((await run({ secrets: 'fail' })).outcome.exitCode).toBe(EXIT.unread);
    expect((await run({ listFails: true })).outcome.exitCode).toBe(EXIT.unread);
  });

  it('only started machines are read', async () => {
    const { calls } = await run({
      machines: [
        { id: 'm-app-1', group: 'app' },
        { id: 'm-app-2', group: 'app', state: 'stopped' },
        { id: 'm-worker-1', group: 'worker' },
      ],
    });
    const sshed = calls.filter((c) => c[0] === 'ssh').map((c) => c[c.indexOf('--machine') + 1]);
    expect(sshed).toEqual(['m-app-1', 'm-worker-1']);
  });

  const refusals: Array<[string, string[], Record<string, string | undefined>]> = [
    [
      '--app motir-core',
      ['--app', 'motir-core'],
      { ...CONFIG_ENV, LOADTEST_STAGING_APP: 'motir-core' },
    ],
    ['an --app that is not LOADTEST_STAGING_APP', ['--app', 'motir-relay'], CONFIG_ENV],
    [
      'an unset LOADTEST_STAGING_APP',
      ['--app', APP],
      { ...CONFIG_ENV, LOADTEST_STAGING_APP: undefined },
    ],
    ['a missing --app', [], CONFIG_ENV],
    [
      'an unset LOADTEST_ALLOWED_DB_HOST',
      ['--app', APP],
      { ...CONFIG_ENV, LOADTEST_ALLOWED_DB_HOST: '' },
    ],
    [
      'an unset LOADTEST_PRODUCTION_DB_HOSTS',
      ['--app', APP],
      { ...CONFIG_ENV, LOADTEST_PRODUCTION_DB_HOSTS: '' },
    ],
    [
      'an unset production Sentry id',
      ['--app', APP],
      { ...CONFIG_ENV, LOADTEST_PRODUCTION_SENTRY_PROJECT_ID: '' },
    ],
  ];
  for (const [label, argv, env] of refusals) {
    it(`refuses ${label} with exit 2 before any platform call`, async () => {
      const { outcome, calls } = await run({}, env, argv);
      expect(outcome.exitCode).toBe(EXIT.live);
      expect(outcome.message).toMatch(/^refused:/);
      expect(calls).toEqual([]);
    });
  }
  it('refuses --app motir-core even when LOADTEST_STAGING_APP names another app', async () => {
    const { outcome, calls } = await run({}, CONFIG_ENV, ['--app=motir-core']);
    expect(outcome.exitCode).toBe(EXIT.live);
    expect(calls).toEqual([]);
  });

  it('never prints a secret value', async () => {
    const live = {
      ...sinkEnv(),
      EMAIL_PROVIDER: 'resend-live-value',
      RESEND_API_KEY: 're_super_secret_value',
      SENTRY_DSN: `https://dsnsecretkey@o1.ingest.sentry.io/${PROD_SENTRY}`,
      MOTIR_AI_SERVICE_TOKEN: 'svc-token-secret',
      DATABASE_URL: `postgresql://u:prod-password-secret@${PROD_HOST}/db`,
    };
    const { printed } = await run({ envs: { 'm-app-1': live, 'm-worker-1': sinkEnv() } });
    const values = [...Object.values(live), ...Object.values(sinkEnv())].filter(
      (v) => !['console', 'staging', 'production', '6000', '0.1', 'm-app-1'].includes(v),
    );
    for (const v of values) expect(printed, v).not.toContain(v);
  });
});

describe('parsers', () => {
  it('parsePrintenv keeps a multi-line value whole', () => {
    const env = parsePrintenv('A=1\nKEY=-----BEGIN\nline2\n-----END\nB=x=y');
    expect(env.get('KEY')).toBe('-----BEGIN\nline2\n-----END');
    expect(env.get('B')).toBe('x=y');
  });
  it('sentryProjectId reads the trailing numeric segment', () => {
    expect(sentryProjectId('https://k@o1.ingest.sentry.io/123')).toBe('123');
    expect(sentryProjectId('not a url')).toBeNull();
    expect(sentryProjectId('https://k@o1.ingest.sentry.io/abc')).toBeNull();
  });
});
