# Load-test report — smoke at N = 2

**Verdict: FAIL** — reads p95 FAIL; reads p99 FAIL; writes, claims and runs p95 FAIL; writes, claims and runs p99 FAIL; P2028 FAIL

## What answered

- **instances**: 2
- **sha**: f8e7d68996e0c9de87ad09f4fdc5eb70728fafd0
- **shaReadFrom**: image_ref tag
- **neon**: {"project":"snowy-truth-13928044","branchId":"br-blue-sea-aup5noib","copiedAt":"2026-10-19T23:31:14Z","copiedAtField":"refresh.json","endpointHost":"ep-jolly-dawn-aumdpqm0.c-10.us-east-1.aws.neon.tech"}
- **app**: {"name":"motir-core-staging","size":"performance-1x-2048MB","machines":[{"id":"83d165ea509708","region":"iad","cpus":1,"memoryMb":2048,"imageRef":"registry.fly.io/motir-core:f8e7d68996e0c9de87ad09f4fdc5eb70728fafd0"},{"id":"82ddd09f047508","region":"iad","cpus":1,"memoryMb":2048,"imageRef":"registry.fly.io/motir-core:f8e7d68996e0c9de87ad09f4fdc5eb70728fafd0"}]}
- **production**: {"cpuKind":"performance","cpus":1,"memoryMb":2048}
- **candidateSize**: false
- **instancesHeld**: true
- **pinEnforced**: true
- **profile**: {"name":"smoke","path":"loadtest/profiles/smoke.json","loadHash":"371d0a8fa6eccb3dc60ebf8081372243127505764f287a1d1305779a20f61ab5"}
- **traceRate**: 0.1
- **concurrency**: {"type":"requests","softLimit":960,"hardLimit":1200}
- **requiredConcurrency**: {"hard":82,"soft":66}
- **rateLimits**: {"apiV1":6000,"mcp":"default","agentWorkspace":"default"}
- **offered**: {"rpsUpperBound":34.41,"perWorkspaceRps":16.91,"perTokenRps":{"mcp":2,"apiV1":0.45},"readerStreamsPerInstance":6}
- **generator**: {"machineId":"85777d7a271148","region":"iad","cpus":2,"cpuMean":0.01971211404070496,"cpuMax":0.022856189522856188}
- **k6**: {"version":"v1.2.1","extensions":["github.com/phymbert/xk6-sse v0.1.12"]}
- **window**: {"startedAt":"2026-10-22T23:26:27.000Z","rampEndedAt":"2026-10-22T23:27:27.000Z","steadyEndedAt":"2026-10-22T23:30:27.000Z","endedAt":"2026-10-22T23:31:35Z"}
- **prometheus**: {"endpoint":"https://api.fly.io/prometheus/moooon","app":"motir-core-staging","queriedAt":"2026-10-23T08:12:33.830Z","settleSeconds":60}
- **pgStatStatements**: {"before":{"host":"ep-jolly-dawn-aumdpqm0.c-10.us-east-1.aws.neon.tech","computeStartedAt":"2026-10-19T23:31:20.328Z","statsReset":"2026-10-19T23:31:20.325Z"},"after":{"host":"ep-jolly-dawn-aumdpqm0.c-10.us-east-1.aws.neon.tech","computeStartedAt":"2026-10-19T23:31:20.328Z","statsReset":"2026-10-19T23:31:20.325Z"}}
- **baseline**: /Users/yuezhu/motir-sandbox/motir-core-8671-a2/loadtest/.out/runs/20261020T191137Z-smoke-n1

> Staging's proxy limits are raised for the load test (1200 hard at the default profile) and are not production's (250), so a PASS says nothing about the production proxy limit — that is the sizing task's.

> Window times are the generator clock and Prometheus timestamps are Fly’s; skew is not measured, so every Prometheus range is widened by ±30 s.

### Comparable

```json
{
  "sha": "f8e7d68996e0c9de87ad09f4fdc5eb70728fafd0",
  "neonBranchId": "br-blue-sea-aup5noib",
  "neonCopiedAt": "2026-10-19T23:31:14Z",
  "app": "motir-core-staging",
  "machineIds": ["82ddd09f047508", "83d165ea509708"],
  "size": "performance-1x-2048MB",
  "instances": 2,
  "profile": "smoke",
  "loadHash": "371d0a8fa6eccb3dc60ebf8081372243127505764f287a1d1305779a20f61ab5",
  "concurrency": {
    "type": "requests",
    "softLimit": 960,
    "hardLimit": 1200
  },
  "requiredConcurrency": {
    "hard": 82,
    "soft": 66
  },
  "rateLimits": {
    "apiV1": 6000,
    "mcp": "default",
    "agentWorkspace": "default"
  },
  "traceRate": 0.1,
  "generatorMachineId": "85777d7a271148",
  "generatorCpus": 2,
  "k6Version": "v1.2.1",
  "baseline": "/Users/yuezhu/motir-sandbox/motir-core-8671-a2/loadtest/.out/runs/20261020T191137Z-smoke-n1"
}
```

## Thresholds

| line                        | status | measured                                                    | limit                   | note                                                                                                                                                                                                                                  |
| --------------------------- | ------ | ----------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| throughput                  | n/a    | N > 1 — 5.81 rps per instance (information)                 | ≥ 13 rps                |                                                                                                                                                                                                                                       |
| reads p95                   | FAIL   | 17362.15 ms                                                 | ≤ 500 ms                |                                                                                                                                                                                                                                       |
| reads p99                   | FAIL   | 20388.1 ms                                                  | ≤ 1500 ms               |                                                                                                                                                                                                                                       |
| writes, claims and runs p95 | FAIL   | 15207.82 ms                                                 | ≤ 2000 ms               |                                                                                                                                                                                                                                       |
| writes, claims and runs p99 | FAIL   | 16617.28 ms                                                 | ≤ 5000 ms               |                                                                                                                                                                                                                                       |
| error rate                  | PASS   | 0 % (0 of 2114)                                             | < 0.1 %                 |                                                                                                                                                                                                                                       |
| P2028                       | FAIL   | 4                                                           | ≤ 0                     | Blind spot: p2028\_\* counts only failures before the transaction body ran (lib/monitoring/transactionSpan.ts failedOutcome); a mid-body expiry is labelled rolled_back and shows as an error outcome in the latency lines, not here. |
| held streams lost           | PASS   | 0 (opened 44, open at end 44, reconnected 0)                | ≤ 0                     |                                                                                                                                                                                                                                       |
| rate-limit refusals         | PASS   | 0 % (0 refused of 2146; retry_after p95 none)               | ≤ 1 %                   |                                                                                                                                                                                                                                       |
| scale-out                   | PASS   | 11.62 rps (shares 82ddd09f047508 52 %, 83d165ea509708 48 %) | ≥ 9.6 rps (0.8 × 2 × 6) |                                                                                                                                                                                                                                       |

Generator CPU over the steady window: mean 0.02, peak 0.02 — ok.

## P2028

P2028: 4 — FAIL

- 82ddd09f047508: p2028_wait 4, p2028_timeout 0, committed rose 21108
- 83d165ea509708: p2028_wait 0, p2028_timeout 0, committed rose 19828
- log cross-check: complete, 0 line(s) — DISAGREES with the platform count

> Blind spot: p2028\_\* counts only failures before the transaction body ran (lib/monitoring/transactionSpan.ts failedOutcome); a mid-body expiry is labelled rolled_back and shows as an error outcome in the latency lines, not here.

## Rate-limit refusals

PASS: 0 % (0 refused of 2146; retry_after p95 none) (limit ≤ 1 %)

## proxy_shed (a reading, not judged)

- platform 503s by instance: 82ddd09f047508 0, 83d165ea509708 0
- proxy log codes: PL01 0, PL02 0, PR01 0
- client http_503: 0

> None of the three says who answered: Fly documents no header that marks a proxy-made response.

## First bottleneck

**app CPU**, saturated from 2026-10-22T23:27:12.000Z

- Fly proxy limit: not reached; peak 72 concurrent (hard limit 1200)
  - proxy_shed: platform 503 0, log codes 0, client http_503 0
- app CPU: from 2026-10-22T23:27:12.000Z; peak 0.99 of the machine's CPUs busy
  - steal peak 0.01 CPU-s/s
  - throttle peak 0 CPU-s/s (limit 0.05)
- app memory: not reached; peak available down to 36.66 % of total
- connection pool (wait/hold sink): from 2026-10-22T23:27:27.000Z; peak mean waiting 32.95, wait p95 1.29 s
  - the app pg.Pool (default max 10 per runtime) is the likelier first limit than the database
- database (Neon load): not reached; peak active 0.55 % of max_connections, 1 waiting on Lock
  - reads the DIRECT endpoint only, so it cannot see pooler saturation
  - readerStreamsPerInstance 6 (each held stream is one watermark read per second of background load)
  - endpoint at start: ep-jolly-dawn-aumdpqm0 active 0.25–2 CU; at end: ep-jolly-dawn-aumdpqm0 active 0.25–2 CU
  - compute at its autoscaling maximum: unmeasured (the endpoint record carries the range, not the current size)

> The database candidate reads the DIRECT endpoint only, so it cannot see pooler saturation; the app’s pg.Pool (default max 10 per runtime) is the likelier first limit.

> Every held stream costs one workbench watermark read per second: readerStreamsPerInstance 6 is background database load named here, not lost inside a req/s figure.

## Agent mix (steady window)

| class            | offered VUs | served rps | share   | ok  | empty | error | limited | p95 ms   | p99 ms   |
| ---------------- | ----------- | ---------- | ------- | --- | ----- | ----- | ------- | -------- | -------- |
| read             | 32          | 4.21       | 36.25 % | 758 | 0     | 0     | 0       | 18205.11 | 20973.2  |
| write            | 16          | 2.44       | 21.04 % | 440 | 0     | 0     | 0       | 15084.68 | 16633.76 |
| claim            | 10          | 1.48       | 12.72 % | 260 | 6     | 0     | 0       | 15608.06 | 16617.28 |
| burst            | 4           | 0.27       | 2.3 %   | 48  | 0     | 0     | 0       | 12459.48 | 12999.35 |
| run              | 6           | 1.01       | 8.66 %  | 181 | 0     | 0     | 0       | 12206.31 | 16146.9  |
| readers          | 16          | 2.21       | 19.03 % | 398 | 0     | 0     | 0       | 6926.31  | 20264.93 |
| readers · tab    | 12          | 1.85       | 15.93 % | 333 | 0     | 0     | 0       | 5968.42  | 7453.86  |
| readers · browse | 4           | 0.36       | 3.11 %  | 65  | 0     | 0     | 0       | 20264.93 | 22384.2  |
| total            | 84          | 11.62      |         |     |       |       |         |          |          |

> Served is ok + empty over the steady window, as the throughput line counts it; the held workbench stream and the run recycle step are in no class, so the top-level rows sum to the served rps. readers · tab and readers · browse split the readers row by k6’s scenario tag.

## Per route (steady window)

| route                   | rps  | p95 ms     | p99 ms     |
| ----------------------- | ---- | ---------- | ---------- |
| mcp get_plan            | 0.83 | 20973.2    | 21534.32   |
| reader plan_poll        | 0.11 | 20561      | 22384.2    |
| run recycle             | 0.13 | 20368.52   | 21716.26   |
| reader plan_get         | 0.05 | 18002.59   | 18002.59   |
| run claim               | 0.08 | 17395.53   | 17395.53   |
| mcp get_work_item       | 1.68 | 16889.19   | 17647.93   |
| mcp transition_status   | 1.13 | 16381.55   | 16931.26   |
| mcp claim_work_item     | 0.52 | 15930.51   | 16683.69   |
| mcp move_to_parent      | 0.27 | 12459.48   | 12999.35   |
| mcp add_comment         | 0.71 | 12320.71   | 12494.22   |
| run read                | 0.36 | 12311.46   | 13316.97   |
| mcp add_plan_items      | 0.16 | 8858.8     | 9239.21    |
| mcp update_work_item    | 1.41 | 8759.1     | 10176.36   |
| mcp search_work_items   | 1.36 | 8533.27    | 9692.07    |
| mcp skeleton            | 0.35 | 8273.2     | 9584.25    |
| run prompt              | 0.08 | 7255.14    | 7255.14    |
| reader workbench_window | 1.48 | 6103.75    | 7525.67    |
| run open                | 0.08 | 4881.64    | 4881.64    |
| run close               | 0.07 | 2961.02    | 2961.02    |
| reader items            | 0.11 | 2779.58    | 2779.58    |
| run heartbeat           | 0.08 | 2718.67    | 2718.67    |
| run events              | 0.24 | 2696.82    | 3339.47    |
| reader workbench        | 0.37 | 2470.35    | 2658.01    |
| reader boards           | 0.09 | 2185.99    | 2185.99    |
| reader workbench_stream | 0.18 | unmeasured | unmeasured |

## Wait and hold (seconds)

| by    | name              | wait p95 | wait p99 | hold p95 | hold p99 |
| ----- | ----------------- | -------- | -------- | -------- | -------- |
| route | mcp               | 1.08     | 1.82     | 0.18     | 0.69     |
| route | plan_get          | 1.22     | 1.84     | 0.14     | 0.23     |
| route | unlabelled        | 0.96     | 1.73     | 0.24     | 0.71     |
| route | workbench         | 0.14     | 0.37     | 0.45     | 0.81     |
| route | workbench_stream  | 1.23     | 1.85     | 0.49     | 1.39     |
| tool  | unknown           | 1.02     | 1.81     | 0.11     | 0.37     |
| tool  | add_comment       | 1.1      | 1.82     | 0.19     | 0.34     |
| tool  | add_plan_items    | 0.99     | 1.78     | 0.15     | 0.23     |
| tool  | claim_work_item   | 1.23     | 1.85     | 0.33     | 2.77     |
| tool  | get_plan          | 1.04     | 1.82     | 0.14     | 0.24     |
| tool  | get_work_item     | 1.05     | 1.81     | 0.17     | 0.34     |
| tool  | move_to_parent    | 1.3      | 1.88     | 0.32     | 0.77     |
| tool  | search_work_items | 1.07     | 1.82     | 0.12     | 0.24     |
| tool  | skeleton          | 1.02     | 1.8      | 0.17     | 0.56     |
| tool  | transition_status | 1.16     | 1.83     | 0.23     | 1.93     |
| tool  | update_work_item  | 1        | 1.81     | 0.19     | 0.25     |

## Top statements by total-time delta

| Δ total ms | Δ calls | statement                                                                                                                                                                                                  |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10560.19   | 209     | `INSERT INTO "public"."notification" ("id","workspace_id","recipient_user_id","type","category","work_item_id","actor_id","data","dedupe_key","created_at") VALUES ($1,$2,$3,$4,CAST($5::text AS "public"` |
| 7352.31    | 2515    | `SELECT "id" FROM "work_item" WHERE "id" = $1 FOR UPDATE`                                                                                                                                                  |
| 3595.7     | 2179    | `SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."watcher"."id" FROM "public"."watcher" LEFT JOIN "public"."work_item" AS "j0" ON ("j0"."id") = ("public"."watcher"."work_item_id") WHERE ("public` |
| 2270.33    | 8680    | `INSERT INTO "public"."job_step" ("id","run_id","step_id","kind","result","workspace_id","created_at") VALUES ($1,$2,$3,CAST($4::text AS "public"."job_step_kind"),$5,$6,$7) RETURNING "public"."job_step` |
| 2162.99    | 1738    | `SELECT "public"."watcher"."id", "public"."watcher"."work_item_id" FROM "public"."watcher" LEFT JOIN "public"."work_item" AS "orderby_1" ON ("orderby_1"."id") = ("public"."watcher"."work_item_id") LEFT` |
| 1293.1     | 8633    | `SELECT o."closing_since" AS "closingSince" FROM "workspace" w JOIN "organization" o ON o."id" = w."organizationId" WHERE w."id" = $1 LIMIT $2`                                                            |
| 920.88     | 4235    | `INSERT INTO "public"."job_queue" ("id","job_id","event_id","event_name","workspace_id","run_at","attempts","max_attempts","state","idempotency_key","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,$6` |
| 868.74     | 4766    | `INSERT INTO "rate_limit_counter" ("key", "window_start", "count", "expires_at") VALUES ($1, $2, $4, $3) ON CONFLICT ("key", "window_start") DO UPDATE SET "count" = "rate_limit_counter"."count" + $5 RE` |
| 707.54     | 2684    | `INSERT INTO "public"."job_run" ("id","workspace_id","function_id","event_name","event_id","lane","attempt","status","started_at","idempotency_key") VALUES ($1,$2,$3,$4,$5,CAST($6::text AS "public"."jo` |
| 684.29     | 9123    | `SELECT $1 AS one FROM "workspace" w JOIN "organization_membership" om ON om."organizationId" = w."organizationId" WHERE w."id" = $2 AND om."userId" = $3 AND om."role" IN ($4 /*, ... */) LIMIT $5`       |

entered the top 200: 8; left it: 7

## Cross-checks

- mcp_rate_limited (summary.json, a Rate: passes = the sum of its values) 0 vs mcp_calls outcome limited over the run 0
- run_limited (summary.json) unmeasured vs run_steps outcome limited over the run 0
- 1597 judged samples fell outside the steady window and were not judged
