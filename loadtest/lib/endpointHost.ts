// THE ENDPOINT HOST OF A NEON URL (Story MOTIR-8538 · MOTIR-8672).
//
// A Neon branch has one compute endpoint and two hostnames for it: the DIRECT
// host `ep-<id>.<region>.aws.neon.tech` and the POOLED host, which carries a
// `-pooler` suffix on its first label (`ep-<id>-pooler.<region>.aws.neon.tech`).
// The preflight, the seed guard and the run command compare the endpoint behind a
// URL, not the URL, so they all strip that suffix through this one helper.
//
// ⚠️ This is new code. `scripts/pgTopStatements.ts` `resolveDirectUrl` REFUSES a
// `-pooler` host and its `hostOf` returns `host[:port]`; neither strips anything.

const POOLER_SUFFIX = '-pooler';

/**
 * The bare endpoint hostname behind `urlOrHost` — a connection URL
 * (`postgresql://user:pw@host/db`) or a hostname — lowercased, with a `-pooler`
 * suffix on its FIRST label removed and nothing else changed. Returns `null` when
 * no hostname can be read.
 */
export function endpointHost(urlOrHost: string | undefined | null): string | null {
  const raw = (urlOrHost ?? '').trim();
  if (!raw) return null;
  let host: string;
  if (raw.includes('://')) {
    try {
      host = new URL(raw).hostname;
    } catch {
      return null;
    }
  } else {
    host = raw.replace(/:\d+$/, '');
  }
  host = host.toLowerCase();
  if (!host) return null;
  const dot = host.indexOf('.');
  const first = dot === -1 ? host : host.slice(0, dot);
  const rest = dot === -1 ? '' : host.slice(dot);
  return first.endsWith(POOLER_SUFFIX) ? first.slice(0, -POOLER_SUFFIX.length) + rest : host;
}

/** A comma-separated host list (`LOADTEST_PRODUCTION_DB_HOSTS`), each reduced to its endpoint. */
export function endpointHostList(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((h) => endpointHost(h))
    .filter((h): h is string => h !== null);
}
