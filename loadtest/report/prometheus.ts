// FLY'S MANAGED PROMETHEUS, READ-ONLY (Story MOTIR-8538 · MOTIR-8679).
//
// `query` (an instant) and `query_range` (15 s step) against
//   ${LOADTEST_PROM_URL:-https://api.fly.io/prometheus/moooon}/api/v1/…
// through an injected `fetch`, so the end-to-end lane points it at a stub.
//
// ⚠️ Any query whose `app` label names `motir-core` (production) is REFUSED before a
// request leaves. The report only ever reads the staging app's series.
//
// The token is `LOADTEST_FLY_PROM_TOKEN`, else `fly auth token` through the injected
// runner, sent as `Authorization: Bearer <token>` (a flyctl token) or, with
// `LOADTEST_FLY_PROM_TOKEN_SCHEME=FlyV1`, as `FlyV1 <token>` (a token made with
// `fly tokens create`, docs.fly.io/monitoring/metrics). It is never printed: every
// error message is redacted against it.
//
// An unreachable endpoint or a non-success answer is a `Reading` that says
// `unmeasured` with the reason; nothing here throws on a platform failure.

import type { Exec } from '../run/fly';
import { redact } from '../capture/redact';
import { ok, unmeasured, type Reading } from './inputs';

export const PROM_URL_DEFAULT = 'https://api.fly.io/prometheus/moooon';
export const PROM_STEP_SECONDS = 15;
/** Generator and Fly clocks are not compared, so every range is widened by this. */
export const CLOCK_MARGIN_SECONDS = 30;
export const PRODUCTION_APP = 'motir-core';

/** One series: its labels and its samples as `[epochSeconds, value]`. */
export interface Series {
  labels: Record<string, string>;
  values: [number, number][];
}

export interface PromClient {
  endpoint: string;
  app: string;
  /** The first time this client asked anything — the header's "queried at". */
  queriedAt(): string | null;
  instant(expr: string, at: Date): Promise<Reading<Series[]>>;
  range(expr: string, start: Date, end: Date): Promise<Reading<Series[]>>;
}

export class ProductionQueryRefusedError extends Error {
  constructor(expr: string) {
    super(`refused: a load-test report never queries production's series (${expr})`);
    this.name = 'ProductionQueryRefusedError';
  }
}

/** True when a PromQL expression selects `app="motir-core"` (or a regex that matches it). */
export function namesProduction(expr: string): boolean {
  const re = /\bapp\s*(=~|=)\s*"([^"]*)"/g;
  for (const m of expr.matchAll(re)) {
    const [, op, value] = m;
    if (op === '=' && value === PRODUCTION_APP) return true;
    if (op === '=~') {
      try {
        if (new RegExp(`^(?:${value})$`).test(PRODUCTION_APP)) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/** `{app="<app>", extra}` — the selector every query starts from. */
export const sel = (app: string, extra = '') => `{app="${app}"${extra ? `, ${extra}` : ''}}`;

export function createPromClient(opts: {
  app: string;
  env: Readonly<Record<string, string | undefined>>;
  exec: Exec;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): PromClient {
  const endpoint = (opts.env['LOADTEST_PROM_URL']?.trim() || PROM_URL_DEFAULT).replace(/\/+$/, '');
  const scheme = opts.env['LOADTEST_FLY_PROM_TOKEN_SCHEME']?.trim() || 'Bearer';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  let token: Reading<string> | null = null;
  let firstAt: string | null = null;

  const readToken = async (): Promise<Reading<string>> => {
    if (token) return token;
    const fromEnv = opts.env['LOADTEST_FLY_PROM_TOKEN']?.trim();
    if (fromEnv) return (token = ok(fromEnv));
    try {
      const r = await opts.exec('fly', ['auth', 'token']);
      const t = r.stdout.trim().split('\n').pop()?.trim() ?? '';
      token =
        r.code === 0 && t
          ? ok(t)
          : unmeasured(
              'no Prometheus token: LOADTEST_FLY_PROM_TOKEN is unset and `fly auth token` failed',
            );
    } catch {
      token = unmeasured('no Prometheus token: `fly auth token` could not run');
    }
    return token;
  };

  const ask = async (path: string, params: Record<string, string>): Promise<Reading<Series[]>> => {
    if (namesProduction(params['query'] ?? ''))
      throw new ProductionQueryRefusedError(params['query']!);
    firstAt ??= now().toISOString();
    const tok = await readToken();
    if (tok.state !== 'ok') return tok;
    const url = `${endpoint}${path}?${new URLSearchParams(params).toString()}`;
    try {
      const res = await fetchImpl(url, {
        headers: { authorization: `${scheme} ${tok.value}`, accept: 'application/json' },
      });
      if (!res.ok) return unmeasured(`Prometheus answered ${res.status}`);
      const body = (await res.json()) as {
        status?: string;
        error?: string;
        data?: { resultType?: string; result?: unknown[] };
      };
      if (body.status !== 'success' || !Array.isArray(body.data?.result)) {
        return unmeasured(
          `Prometheus answered ${body.status ?? 'nothing'}: ${redact(body.error ?? '', [tok.value])}`,
        );
      }
      return ok(
        (
          body.data.result as {
            metric?: Record<string, string>;
            value?: [number, string];
            values?: [number, string][];
          }[]
        ).map((r) => ({
          labels: r.metric ?? {},
          values: (r.values ?? (r.value ? [r.value] : [])).map(
            ([t, v]) => [Number(t), Number(v)] as [number, number],
          ),
        })),
      );
    } catch (err) {
      return unmeasured(`Prometheus unreachable: ${redact((err as Error).message, [tok.value])}`);
    }
  };

  const secs = (d: Date) => String(d.getTime() / 1000);
  return {
    endpoint,
    app: opts.app,
    queriedAt: () => firstAt,
    instant: (expr, at) => ask('/api/v1/query', { query: expr, time: secs(at) }),
    range: (expr, start, end) =>
      ask('/api/v1/query_range', {
        query: expr,
        start: secs(start),
        end: secs(end),
        step: String(PROM_STEP_SECONDS),
      }),
  };
}

/** The labels of a series joined as a key, e.g. `instance=abc`. */
export const labelKey = (labels: Record<string, string>, keys: readonly string[]) =>
  keys.map((k) => `${k}=${labels[k] ?? ''}`).join(',');

/**
 * A counter's increase between two instants as END MINUS START, an absent series
 * counted as 0 at either end — never `increase()`: prom-client creates a label
 * combination only when first observed, so a first event appears as a series
 * already at 1, and `increase()` would read it as 0.
 * A negative delta (a counter reset: a restarted instance) is `null` — unmeasured.
 */
export async function counterDelta(
  prom: PromClient,
  expr: string,
  start: Date,
  end: Date,
  by: readonly string[],
): Promise<Reading<Map<string, number | null>>> {
  const [a, b] = [await prom.instant(expr, start), await prom.instant(expr, end)];
  if (a.state !== 'ok') return a;
  if (b.state !== 'ok') return b;
  const at = (rows: Series[]) => {
    const m = new Map<string, number>();
    for (const s of rows) {
      const k = labelKey(s.labels, by);
      m.set(k, (m.get(k) ?? 0) + (s.values.at(-1)?.[1] ?? 0));
    }
    return m;
  };
  const [ma, mb] = [at(a.value), at(b.value)];
  const out = new Map<string, number | null>();
  for (const k of new Set([...ma.keys(), ...mb.keys()])) {
    const d = (mb.get(k) ?? 0) - (ma.get(k) ?? 0);
    out.set(k, d < 0 ? null : d);
  }
  return ok(out);
}

/** Widen a window by the clock margin. */
export const widen = (start: number, end: number) => ({
  start: new Date(start - CLOCK_MARGIN_SECONDS * 1000),
  end: new Date(end + CLOCK_MARGIN_SECONDS * 1000),
});
