# Request database timing — wait, hold and pool per route

Every interactive transaction the web server opens through a `with*Context`
helper is recorded, sampled for a trace or not, into Prometheus histograms
labelled with the request's route and, on MCP, the tool (MOTIR-8553). A Sentry
trace says what one sampled request did; these series say what the p95 and p99
of every request were.

- **Recorded by** `lib/monitoring/requestDbTiming.ts`, which listens to the
  transaction seam's measurements (`lib/monitoring/transactionSpan.ts`,
  MOTIR-8550).
- **Labelled by** `lib/monitoring/requestLabel.ts`, which the hot routes set.
- **Served by** `lib/monitoring/metricsServer.ts` on `GET /metrics` at
  `MONITORING_METRICS_PORT`. The port is unset everywhere except Fly, where
  `fly.toml` sets it to `9091` and declares the `[[metrics]]` scrape for the
  `app` group.
- **Stored in** Fly's managed Prometheus. It is scraped every 15 s and kept for
  about 15 days (<https://docs.fly.io/monitoring/metrics>).

The job worker does not run `instrumentation.ts`, so it records nothing here.

## The series

| series                       | kind      | labels                                           | what it is                                                                                                            |
| ---------------------------- | --------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `db_tx_wait_seconds`         | histogram | `route`, `tool`, `context`, `outcome`, `attempt` | The helper asked → the body started: pool acquire, `BEGIN` and the `set_config` binds.                                |
| `db_tx_hold_seconds`         | histogram | same                                             | The body started → `COMMIT` / `ROLLBACK`. Not recorded for an attempt whose body never ran (a P2028 before the body). |
| `db_pool_waiting_at_acquire` | histogram | `route`, `tool`                                  | Requests already queued for a connection when this transaction asked, summed over every pool in the process.          |
| `db_pool_idle_at_acquire`    | histogram | `route`, `tool`                                  | Idle connections when this transaction asked.                                                                         |
| `db_pool_max`                | gauge     | —                                                | The summed pool `max` at the latest measurement.                                                                      |
| `db_pool_count`              | gauge     | —                                                | How many pools were registered at the latest measurement.                                                             |
| `db_pool_unmeasured_total`   | counter   | `route`, `tool`                                  | Transactions whose pool could not be read. These are counted here and never recorded as a zero.                       |

The labels:

- **`route`** is one of `workbench` (the `/workbench` page, its Approvals and
  Planning tabs included), `workbench_stream` (`/api/workbench/stream`, for the
  stream's whole life), `plan_get` (`GET /api/plans/<id>`), `mcp` (`/api/mcp`),
  or `unlabelled` for everything else.
- **`tool`** is the MCP tool name on `route="mcp"`. It is empty for the request's
  own work outside a tool call, and for every other route. A name the registry
  never registered is recorded as `other`.
- **`context`** is the helper: `workspace`, `workspace_service`, `system`,
  `bootstrap_slug`, `user`, `org` or `org_service_write`.
- **`outcome`** is `committed`, `rolled_back`, `p2028_wait`, `p2028_timeout` or
  `error_before_body`.
- **`attempt`** is `1`, or `2` for the one retry after a P2028 before the body.

Fly adds `app`, `instance` and `region` at scrape time, so `by (instance)` gives
one machine and leaving it out gives the fleet. That works because these are
histograms, not summaries.

## Where to run the queries

- **Fly's managed Grafana** (`fly dashboard metrics -a motir-core`, or the
  dashboard's Metrics tab). Paste a query into an Explore panel over the managed
  Prometheus data source.
- **The Prometheus HTTP API**, with a Fly access token. The org slug is `moooon`
  (`fly.toml`'s `app` comment):

  ```sh
  curl -sG https://api.fly.io/prometheus/moooon/api/v1/query \
    -H "Authorization: Bearer $(fly auth token)" \
    --data-urlencode 'query=histogram_quantile(0.95, sum by (le, route) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))'
  ```

  A token from `fly tokens create` goes in as `Authorization: FlyV1 <token>`.

Change `[5m]` to the window you want. Use `[1h]` over a load test, or the length
of an incident.

## Queries

### Wait per route — p50, p95, p99

```promql
histogram_quantile(0.50, sum by (le, route) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))
histogram_quantile(0.95, sum by (le, route) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))
histogram_quantile(0.99, sum by (le, route) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))
```

### Hold per route — p50, p95, p99

```promql
histogram_quantile(0.50, sum by (le, route) (rate(db_tx_hold_seconds_bucket{app="motir-core"}[5m])))
histogram_quantile(0.95, sum by (le, route) (rate(db_tx_hold_seconds_bucket{app="motir-core"}[5m])))
histogram_quantile(0.99, sum by (le, route) (rate(db_tx_hold_seconds_bucket{app="motir-core"}[5m])))
```

### Wait and hold per MCP tool — p50, p95, p99

```promql
histogram_quantile(0.50, sum by (le, tool) (rate(db_tx_wait_seconds_bucket{app="motir-core", route="mcp"}[5m])))
histogram_quantile(0.95, sum by (le, tool) (rate(db_tx_wait_seconds_bucket{app="motir-core", route="mcp"}[5m])))
histogram_quantile(0.99, sum by (le, tool) (rate(db_tx_wait_seconds_bucket{app="motir-core", route="mcp"}[5m])))

histogram_quantile(0.50, sum by (le, tool) (rate(db_tx_hold_seconds_bucket{app="motir-core", route="mcp"}[5m])))
histogram_quantile(0.95, sum by (le, tool) (rate(db_tx_hold_seconds_bucket{app="motir-core", route="mcp"}[5m])))
histogram_quantile(0.99, sum by (le, tool) (rate(db_tx_hold_seconds_bucket{app="motir-core", route="mcp"}[5m])))
```

### The same, per machine

Add `instance` to the `by`. For example, the p95 wait per route and machine:

```promql
histogram_quantile(0.95, sum by (le, route, instance) (rate(db_tx_wait_seconds_bucket{app="motir-core"}[5m])))
```

### Pool waiting at acquire, per route

```promql
histogram_quantile(0.95, sum by (le, route) (rate(db_pool_waiting_at_acquire_bucket{app="motir-core"}[5m])))
# the mean queue a transaction joined
sum by (route) (rate(db_pool_waiting_at_acquire_sum{app="motir-core"}[5m]))
  / sum by (route) (rate(db_pool_waiting_at_acquire_count{app="motir-core"}[5m]))
```

### The retry rate

This is the share of transaction attempts that were the one retry after a P2028
before the body.

```promql
sum by (route) (rate(db_tx_wait_seconds_count{app="motir-core", attempt="2"}[5m]))
  / sum by (route) (rate(db_tx_wait_seconds_count{app="motir-core"}[5m]))
```

### The unlabelled share

This is how much of the database's transaction load comes from routes outside the
four hot ones.

```promql
sum(rate(db_tx_wait_seconds_count{app="motir-core", route="unlabelled"}[5m]))
  / sum(rate(db_tx_wait_seconds_count{app="motir-core"}[5m]))
```

### Transactions per second, per route

This shows that every request is recorded, sampled for a trace or not.

```promql
sum by (route) (rate(db_tx_wait_seconds_count{app="motir-core"}[5m]))
```

## What these series do not say

- **Which statement was slow.** Hold is the whole transaction body. A sampled
  trace's `db.transaction.hold` span names its statements, and
  `pnpm ops:pg-top-statements` ranks the statements the database itself timed
  (MOTIR-8552).
- **The request's own latency.** These series are per transaction attempt, and a
  request can open several.
- **That Fly scraped anything.** `fly.toml` declares the scrape. Reading the
  series back from Fly's Prometheus after a deploy is the proof.
