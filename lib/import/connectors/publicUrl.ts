// The SSRF guard for live-API connectors (MOTIR-7816). A connector's base URL can
// come from the member — a GitHub Enterprise host, a self-hosted Plane — so a
// request the server makes on their behalf must not reach this deployment's own
// network: loopback, the private ranges, link-local (the cloud metadata
// endpoint lives there), or any other special-use block.
//
// `fetchWithRetry` runs it before every request it makes with the real `fetch`.
// It resolves the host and refuses when ANY answer is non-public, so a name that
// resolves to both a public and a private address is refused too. The SaaS API
// hosts the connectors default to are public by construction and skip the
// lookup; only a host the member supplied is resolved.

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ConnectorConfigError } from './errors';

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. the metadata endpoint
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['64:ff9b:1::', 48], // local-use NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/** True when `address` (an IP literal) is in a range a connector must not reach. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NON_PUBLIC.check(address, 'ipv4');
  if (family !== 6) return true;
  // An IPv4-mapped address (`::ffff:7f00:1`) is checked against the IPv4 rules too.
  return NON_PUBLIC.check(address, 'ipv6');
}

/** The fixed API hosts the connectors call by default, and Jira Cloud sites. */
function isKnownSaasHost(host: string): boolean {
  return (
    host === 'api.github.com' ||
    host === 'api.linear.app' ||
    host === 'api.plane.so' ||
    host === 'api.atlassian.com' ||
    host.endsWith('.atlassian.net')
  );
}

type Resolve = (hostname: string) => Promise<{ address: string }[]>;

const resolveAll: Resolve = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Throw `ConnectorConfigError` unless `url` is an absolute http(s) URL whose host
 * resolves only to public addresses. `resolve` is injectable for tests.
 */
export async function assertPublicHttpUrl(
  url: string,
  source?: string,
  resolve: Resolve = resolveAll,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectorConfigError('the source URL is not an absolute URL', source);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConnectorConfigError('the source URL must use http or https', source);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol === 'https:' && isKnownSaasHost(host)) return;
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await resolve(host)).map((a) => a.address);
    } catch {
      throw new ConnectorConfigError(`the source host ${host} could not be resolved`, source);
    }
  }
  if (addresses.length === 0 || addresses.some(isNonPublicAddress)) {
    throw new ConnectorConfigError(
      `the source host ${host} is not a public address, so it cannot be imported from`,
      source,
    );
  }
}
