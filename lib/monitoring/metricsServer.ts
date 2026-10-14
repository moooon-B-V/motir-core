import { createServer, type Server } from 'node:http';
import { requestDbTimingRegistry } from './requestDbTiming';

// THE PRIVATE METRICS PORT (MOTIR-8553).
//
// Serves `./requestDbTiming`'s registry as Prometheus text on
// `MONITORING_METRICS_PORT`, for Fly's managed Prometheus to scrape (`[metrics]`
// in `fly.toml`). The port is NOT in `[http_service]`, so Fly's proxy never routes
// public traffic to it.
//
// ⚠️ UNSET MEANS NO PORT. A self-hosted build and a local `next dev` open nothing
// new; only the Fly deployment sets the variable. One server per process, kept on
// `globalThis` for the same module-instance reason as the registry.

export const METRICS_PATH = '/metrics';

const SERVER_KEY = Symbol.for('motir.metricsServer.server');

type Holder = { [SERVER_KEY]?: Server };

function parsePort(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.warn(
      `[metricsServer] MONITORING_METRICS_PORT="${value}" is not a port; serving no metrics.`,
    );
    return null;
  }
  return port;
}

/**
 * Start the metrics server when `MONITORING_METRICS_PORT` is set. Returns the
 * server, or null when no port is configured. A second call returns the first
 * server.
 */
export function startMetricsServer(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Server | null {
  const holder = globalThis as Holder;
  if (holder[SERVER_KEY]) return holder[SERVER_KEY];
  const port = parsePort(env['MONITORING_METRICS_PORT']);
  if (port === null) return null;

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== METRICS_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found\n');
      return;
    }
    const registry = requestDbTimingRegistry();
    registry.metrics().then(
      (body) => {
        res.writeHead(200, { 'Content-Type': registry.contentType }).end(body);
      },
      (err: unknown) => {
        console.error('[metricsServer] rendering the metrics failed:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('error\n');
      },
    );
  });
  server.on('error', (err) => {
    console.error(`[metricsServer] the metrics port ${port} failed:`, err);
  });
  server.listen(port);
  // Never keep a process alive for the metrics port alone.
  server.unref();
  holder[SERVER_KEY] = server;
  return server;
}

/** Tests only: close the server and forget it. */
export async function stopMetricsServerForTests(): Promise<void> {
  const holder = globalThis as Holder;
  const server = holder[SERVER_KEY];
  delete holder[SERVER_KEY];
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
