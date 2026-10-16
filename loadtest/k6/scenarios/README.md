# Load-test scenarios

The k6 scenario functions the load profile (`MOTIR-8678`) wires into its
`scenarios` block. Each VU is one seeded identity from
`loadtest/.out/manifest.json` (see `loadtest/seed/manifest.ts`) and holds it for
the whole run.

## Agent scenarios (MCP)

| file             | group   | tools                                                                                                         |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `agentReads.js`  | `read`  | `get_work_item`, `search_work_items`, `skeleton`, `get_plan` (read plans only)                                |
| `agentWrites.js` | `write` | `update_work_item`, `transition_status` (todo ↔ in_progress), `add_comment`, `add_plan_items` (scratch plans) |
| `agentClaims.js` | `claim` | `claim_work_item` on a pool key, then the release: `update_work_item`, `transition_status` → `todo`           |
| `burst.js`       | `burst` | `burstSize` sequential `move_to_parent` with `parentKey`                                                      |

`claim_next_ready` is in none of them: it ranks the whole project's ready leaves
and would take cards the other scenarios are using.

## Outcomes

Every call is exactly one of `ok`, `empty`, `limited`, `error`
(`lib/outcome.js`, shared with the run-lifecycle and reader scenarios), tagged
`outcome`:

- `limited`: any HTTP 429, or a tool result with `isError` and
  `structuredContent.code: 'RATE_LIMITED'`. The agent waits the refusal's
  `retryAfterSeconds` (body first, `Retry-After` second, capped by the profile)
  and goes on.
- `empty`: a `claim_work_item` answered `taken` or `not_claimable`. It did no
  work, so it is never a fast success.
- `error`: any other non-200, an `isError` result, a body that does not parse,
  or a 200 with a JSON-RPC `error` and no `result` (the `-32602` unknown-key
  refusal).
- `ok`: everything else.

## Metrics

| metric                | type    | holds                                  | tags                               |
| --------------------- | ------- | -------------------------------------- | ---------------------------------- |
| `mcp_call_duration`   | Trend   | served (`ok`) calls only               | `role`, `group`, `tool`            |
| `mcp_calls`           | Counter | every call; the source for every count | `role`, `group`, `tool`, `outcome` |
| `mcp_errors`          | Rate    | `outcome: error` over every call       | `role`, `group`, `tool`            |
| `mcp_rate_limited`    | Rate    | `outcome: limited` over every call     | `role`, `group`, `tool`            |
| `retry_after_seconds` | Trend   | the wait a `limited` call was told     | `role`, `group`, `tool`            |
| `burst_duration`      | Trend   | one whole burst                        | `role`, `group`                    |

Every metric carries `role` (`agent` here, `run` and `reader` in the sibling
scenarios). The report separates them by `role`, never by k6's `scenario` tag.
No tag, log line or summary field carries a token.

## CI metering

`claim_work_item` refuses for CI credits only when CI metering is on:
`isCiMeteringEnabled()` is cloud billing on **and** `GITHUB_FALLBACK_ORG` set
(`lib/ciMetering/config.ts`). Staging leaves both unset. If a staging run shows
every claim as `error`, check those two variables first.

## Reader scenarios (signed-in sessions)

`readers.js` (`readerTab`, `readerBrowse`, `readerScenarios`, `probeReaderCookie`)
runs the signed-in people beside the agents. Each VU sends one seeded user's
`cookieHeader` exactly as the seed wrote it.

It needs a k6 built with the SSE extension: `loadtest/k6/build.sh` builds the
pair pinned in `versions.env` into `loadtest/.out/k6` (Docker's `grafana/xk6`
when a daemon answers, else `go` + `xk6`). Run it with
`K6_AUTO_EXTENSION_RESOLUTION=false`, so k6 never fetches a build at run time.

| route              | request                                                     |
| ------------------ | ----------------------------------------------------------- |
| `workbench`        | `GET /workbench` and its 307 hop to `?tab=` (both `ok`)     |
| `workbench_stream` | the held `GET /api/workbench/stream` (never timed)          |
| `workbench_window` | one `GET /api/workbench/window?tab=&page=1` per moved frame |
| `boards`           | `GET /boards`                                               |
| `items`            | `GET /items`, `GET /items?page=<n>`                         |
| `plan_get`         | `GET /api/plans/<read plan>`                                |
| `plan_poll`        | `GET /api/plans/<read plan>?since=<reviewVersion or 0>`     |

| metric                 | type    | holds                                                         |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `reader_requests`      | Counter | every reader request — tags `route`, `outcome`, `status`      |
| `reader_duration`      | Trend   | `ok` requests only, never the stream — tag `route`            |
| `http_503`             | Counter | every 503 (also an `error`); says nothing about who sent it   |
| `workbench_renders`    | Counter | one per Workbench page load                                   |
| `stream_opened`        | Counter | held streams that proved open (200 + the opening frame)       |
| `stream_open_failures` | Counter | attempts that did not open — tags `status`, `reconnect`       |
| `stream_open_ms`       | Trend   | time to the opening frame                                     |
| `stream_frames`        | Counter | watermark frames received                                     |
| `stream_drops`         | Counter | open connections that ended before the hold                   |
| `stream_open_at_end`   | Counter | held streams open at the end, never dropped                   |
| `stream_reconnected`   | Counter | held streams that dropped and ended on a successful reconnect |
| `stream_lost`          | Counter | held streams with no live connection at the end               |

Every reader metric carries `role: reader`. A redirect to sign-in, re-consent, a
two-factor hold or no-project is an `error`, never a hop. `setup()` should call
`probeReaderCookie`, which aborts the run before any VU starts when the target
does not accept the first user's cookie.

## Run-lifecycle scenario (`/api/v1`)

`runs.js` (`runsScenario(ctx)`) makes, per iteration, the calls a single-card
`motir run <KEY>` makes when its agent exits without pushing
(`../runs/sequence.js` cites the CLI line by line): `GET /me`,
`GET /workspaces`, read, claim, dispatch prompt, open (`origin: 'local'`, which
starts nothing), a beat at open, `run_opened` and `checkout_ready` each sent at
once, the designs read, a beat plus a flush every 60 s of agent time, the replan
read, the final batch and the close (`stopReason: completed`). No pull request,
CI or container is reached. The card is then recycled (unassigned, back to
`todo`) with two calls tagged `step: recycle`, which the CLI never makes.

Each VU uses its own `run` agent and a disjoint slice of that agent's project's
run pool. `requestsPerIteration({ agentSeconds, recycle })` is the per-token
request count the run command checks against `MOTIR_API_V1_RATE_LIMIT`.

| metric                   | type    | holds                                             |
| ------------------------ | ------- | ------------------------------------------------- |
| `run_steps`              | Counter | every request — tags `step`, `outcome`, `role`    |
| `run_step_duration`      | Trend   | `ok` requests only — tag `step`                   |
| `run_lifecycle_duration` | Trend   | one claim → close, clean iterations only          |
| `runs_completed`         | Counter | iterations that reached the close with every `ok` |
| `run_claim_refused`      | Counter | claims answered `taken` / `not_claimable`         |
| `run_pool_exhausted`     | Counter | iterations whose VU had no run card               |
| `run_limited`            | Counter | 429s on any step (backed off, same run resumed)   |
