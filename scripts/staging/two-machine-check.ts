/**
 * `pnpm staging:two-machine-check` — the two-instance case list, against a
 * DEPLOYED app on two Fly machines (Story MOTIR-8547 · MOTIR-8620).
 *
 * The local lane (`tests/two-instance/`) proves the cases against two `next start`
 * processes on one host. This runs the same cases against the real thing: one base
 * URL behind Fly's proxy, every request pinned to machine A or B with
 * `fly-force-instance-id`. It is an HTTP client only — no database access, no app
 * import — and is run by a person against staging, never by CI.
 *
 * Usage (README.md beside this file has the full setup):
 *   pnpm staging:two-machine-check                  # cases 1-4, the sign-in/MCP/v1 controls, case 6
 *   pnpm staging:two-machine-check --reset-control  # ONLY the password-reset control (a separate hour)
 *   pnpm staging:two-machine-check --json           # the summary as JSON on stdout
 *
 * Exit codes:
 *   0  every case passed
 *   1  a case failed an assertion (a product failure)
 *   2  the configuration was refused — nothing was sent
 *   3  a bucket was already spent by an earlier run (not a product failure; wait it out)
 *   4  the fleet was not ready, or responses could not be attributed to a machine
 */
import {
  AttributionError,
  createPinnedClient,
  StagingConfigError,
  type Machine,
  type PinnedClient,
} from './lib/pinnedClient';
import {
  caseDeviceFlow,
  CaseFailure,
  caseIdempotentWrite,
  caseMcpControl,
  caseMcpSession,
  caseMcpSplit,
  casePlanApprove,
  caseResetControl,
  caseResetSplit,
  caseSession,
  caseSignInControl,
  caseSignInSplit,
  caseStream,
  caseV1Control,
  caseV1Split,
  PreSpentBucketError,
  ServerClock,
  signInOnce,
  type CaseContext,
  type CaseResult,
  type Credentials,
  type Session,
} from './lib/cases';

export const EXIT = { ok: 0, caseFailed: 1, config: 2, preSpent: 3, fleet: 4 } as const;

export interface CheckOutcome {
  readonly exitCode: number;
  readonly results: CaseResult[];
  readonly message: string;
}

type Env = Record<string, string | undefined>;

function credentialsFrom(env: Env, client: PinnedClient): Credentials {
  const missing = [
    'STAGING_USER_EMAIL',
    'STAGING_USER_PASSWORD',
    'STAGING_PAT',
    'STAGING_PROJECT_KEY',
  ].filter((k) => !env[k]);
  if (missing.length) {
    throw new StagingConfigError(
      `${missing.join(', ')} not set — the dedicated test account's credentials.`,
    );
  }
  return {
    email: env['STAGING_USER_EMAIL']!,
    password: env['STAGING_USER_PASSWORD']!,
    pat: env['STAGING_PAT']!,
    projectKey: env['STAGING_PROJECT_KEY']!,
    origin: env['STAGING_ORIGIN'] || client.origin,
  };
}

/** Both machines answer the readiness probe as `ready`, and the proxy enforces the pin. */
async function checkFleet(client: PinnedClient): Promise<string | null> {
  for (const machine of ['A', 'B'] as Machine[]) {
    let state: unknown = null;
    let status = 0;
    try {
      const served = await client.sendTo(machine, '/api/health/ready');
      status = served.response.status;
      state = ((await served.response.json()) as { state?: unknown }).state;
    } catch (err) {
      if (err instanceof AttributionError) return err.message;
      state = `unreachable (${(err as Error).message})`;
    }
    if (status !== 200 || state !== 'ready') {
      return (
        `machine ${machine} (${client.ids[machine]}) is not ready: ${status} ${String(state)}. ` +
        'Check `fly machine list --json` for two started machines in the app process group.'
      );
    }
  }
  if (!(await client.probePinEnforcement())) {
    return (
      `a request pinned to a machine that does not exist was answered by the app, so ` +
      `fly-force-instance-id is not enforced and no response can be attributed to a machine.`
    );
  }
  return null;
}

type Step = (ctx: CaseContext, session: Session) => Promise<CaseResult>;

const LIMIT_CASES: Array<[string, (ctx: CaseContext) => Promise<CaseResult>]> = [
  ['1', caseResetSplit],
  ['2', caseSignInSplit],
  ['5-sign-in', caseSignInControl],
  ['3', caseMcpSplit],
  ['5-3', caseMcpControl],
  ['4', caseV1Split],
  ['5-4', caseV1Control],
];

const FOLLOW_UPS: Array<[string, Step]> = [
  ['6a', caseSession],
  ['6b', (ctx) => caseMcpSession(ctx)],
  ['6c1', (ctx) => caseIdempotentWrite(ctx)],
  ['6c2', casePlanApprove],
  ['6d', caseDeviceFlow],
  ['6e', caseStream],
];

function failed(id: string, err: Error): CaseResult {
  return {
    id,
    title: id,
    pass: false,
    first: null,
    second: null,
    statuses: [],
    detail: err.message,
  };
}

/**
 * Run the check. Refuses the configuration before any request; aborts on a
 * pre-spent bucket or an unattributable response; otherwise runs every case and
 * reports each one.
 */
export async function runTwoMachineCheck(
  env: Env,
  argv: readonly string[],
  fetchImpl?: typeof fetch,
  log: (line: string) => void = () => undefined,
): Promise<CheckOutcome> {
  let client: PinnedClient;
  let creds: Credentials;
  try {
    client = createPinnedClient({
      baseUrl: env['STAGING_BASE_URL'],
      allowedHost: env['STAGING_ALLOWED_HOST'],
      machineA: env['STAGING_MACHINE_A'],
      machineB: env['STAGING_MACHINE_B'],
      fetchImpl,
    });
    creds = credentialsFrom(env, client);
  } catch (err) {
    if (err instanceof StagingConfigError)
      return { exitCode: EXIT.config, results: [], message: err.message };
    throw err;
  }

  const fleet = await checkFleet(client);
  if (fleet) return { exitCode: EXIT.fleet, results: [], message: fleet };

  const ctx: CaseContext = { client, creds, clock: new ServerClock() };
  const results: CaseResult[] = [];
  const record = (r: CaseResult) => {
    results.push(r);
    log(
      `${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${r.title} — first ${r.first ?? '?'}, second ${r.second ?? '?'}, ` +
        `statuses ${r.statuses.join(',') || '-'}${r.detail ? ` — ${r.detail}` : ''}`,
    );
  };

  // A pre-spent bucket or an unattributable response aborts the run: the first is
  // not a product failure, the second means no later case could be judged either.
  const attempt = async (
    id: string,
    run: () => Promise<CaseResult>,
  ): Promise<CheckOutcome | null> => {
    try {
      record(await run());
      return null;
    } catch (err) {
      if (err instanceof PreSpentBucketError) {
        return { exitCode: EXIT.preSpent, results, message: err.message };
      }
      if (err instanceof AttributionError) {
        record(failed(id, err));
        return { exitCode: EXIT.fleet, results, message: err.message };
      }
      if (err instanceof CaseFailure) {
        record(failed(id, err));
        return null;
      }
      throw err;
    }
  };

  const steps: Array<[string, () => Promise<CaseResult>]> = argv.includes('--reset-control')
    ? [['5-reset', () => caseResetControl(ctx)]]
    : LIMIT_CASES.map(([id, run]) => [id, () => run(ctx)] as [string, () => Promise<CaseResult>]);

  for (const [id, run] of steps) {
    const stop = await attempt(id, run);
    if (stop) return stop;
  }

  if (!argv.includes('--reset-control')) {
    let session: Session | null = null;
    const signIn = await attempt('6-sign-in', async () => {
      session = await signInOnce(ctx);
      return {
        id: '6-sign-in',
        title: 'the test user signs in on A',
        pass: true,
        first: session.signedInOn.machineId,
        second: null,
        statuses: [session.signedInOn.response.status],
        detail: '',
      };
    });
    if (signIn) return signIn;
    if (session) {
      for (const [id, run] of FOLLOW_UPS) {
        const stop = await attempt(id, () => run(ctx, session!));
        if (stop) return stop;
      }
    }
  }

  const failures = results.filter((r) => !r.pass);
  return {
    exitCode: failures.length ? EXIT.caseFailed : EXIT.ok,
    results,
    message: failures.length
      ? `${failures.length} of ${results.length} cases failed: ${failures.map((f) => f.id).join(', ')}`
      : `${results.length} cases passed`,
  };
}

/* v8 ignore start -- the process entry: argv, printing and the exit code over
   `runTwoMachineCheck`, which `tests/staging/pinnedClient.test.ts` drives. */
if (/two-machine-check\.ts$/.test(process.argv[1] ?? '')) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const print = (line: string) => process.stdout.write(`${line}\n`);
  runTwoMachineCheck(process.env, argv, undefined, json ? () => undefined : print)
    .then((outcome) => {
      if (json) print(JSON.stringify(outcome, null, 2));
      else
        print(
          `\n${outcome.exitCode === 0 ? 'OK' : `EXIT ${outcome.exitCode}`}: ${outcome.message}`,
        );
      process.exit(outcome.exitCode);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(EXIT.caseFailed);
    });
}
/* v8 ignore stop */
