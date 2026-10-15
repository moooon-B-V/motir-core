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
