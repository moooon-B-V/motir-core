// THE HARNESS'S DETECTABILITY FIXTURE (MOTIR-8616) — a test-only process,
// never shipped.
//
// The two-instance lane's claim is that it can SEE per-instance state. That is
// proven here, not assumed: this tiny server is started twice through the SAME
// harness the app is (`startInstances`), and offers two "limiters":
//
//   GET /counter-limit?key=K&max=N  — counts in a module-level Map. Per process,
//                                     so 3 calls to A and 1 to B are 3 and 1.
//   GET /shared-limit?key=K&max=N   — counts in Postgres `rate_limit_counter`,
//                                     one atomic upsert, like the app's store.
//
// A correct shared limiter refuses the 4th call across A and B; the counter one
// lets it through. If the harness ever stopped reaching two processes, the
// counter case would refuse the 4th as well and the spec would go red.
//
// Plain Node and `pg` on purpose: no Next build, no app import, so it proves
// the HARNESS, independent of anything the app does.

import { createServer } from 'node:http';
import pg from 'pg';

const port = Number(process.env.PORT);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const counts = new Map();
/** One fixed window wide enough that no case crosses it. */
const WINDOW_START = 0;
const WINDOW_MS = 10 * 365 * 24 * 3600 * 1000;

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-fixture-pid': String(process.pid),
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const key = url.searchParams.get('key') ?? '';
  const max = Number(url.searchParams.get('max') ?? '0');
  try {
    if (url.pathname === '/health') return send(res, 200, { pid: process.pid });
    if (url.pathname === '/counter-limit') {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return send(res, count <= max ? 200 : 429, { count, pid: process.pid });
    }
    if (url.pathname === '/shared-limit') {
      const { rows } = await pool.query(
        `INSERT INTO "rate_limit_counter" ("key", "window_start", "count", "expires_at")
         VALUES ($1, $2, 1, $3)
         ON CONFLICT ("key", "window_start") DO UPDATE SET "count" = "rate_limit_counter"."count" + 1
         RETURNING "count"`,
        [`two-instance-fixture:${key}`, WINDOW_START, new Date(WINDOW_START + WINDOW_MS)],
      );
      const count = rows[0].count;
      return send(res, count <= max ? 200 : 429, { count, pid: process.pid });
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: String(err) });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fixture listening on port ${port}\n`);
});

const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
