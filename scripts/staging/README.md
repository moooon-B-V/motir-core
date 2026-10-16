# The two-machine staging check

`pnpm staging:two-machine-check` runs the two-instance case list (Story MOTIR-8547) against a
**deployed** app on two Fly machines. Every request goes to one base URL and is pinned to a machine
with the `fly-force-instance-id` request header. That header is the only routing: there are no sticky
cookies, no second proxy and no per-machine hostname.

The local lane (`tests/two-instance/`, `pnpm vitest run --config vitest.two-instance.config.ts`)
proves the same cases against two `next start` processes on one host. This script exists for what that
lane cannot see: Fly's proxy, the platform's secrets (a `MOTIR_RATE_LIMIT_STORE=memory` set there),
the real `DATABASE_URL`, and a deployment that quietly runs one machine.

It is not run in CI. It needs a staging app scaled to two machines and a dedicated test account.

## 1. Two started machines

```sh
fly scale count 2 --process-group app -a <staging app>
fly machine list --json -a <staging app> | jq -r '.[] | select(.config.metadata.fly_process_group=="app") | "\(.id) \(.state)"'
```

Both must be `started`. Their ids are `STAGING_MACHINE_A` and `STAGING_MACHINE_B`.

## 2. A dedicated test account

Never a customer's. The account needs:

- a user with a password (`STAGING_USER_EMAIL`, `STAGING_USER_PASSWORD`);
- a workspace and a project in it (`STAGING_PROJECT_KEY`) where the user may create work items and
  plans;
- a personal access token for that user in that workspace, able to read and write work items
  (`STAGING_PAT`).

The script checks that the token and the password belong to the same user before it runs a follow-up
case. It creates work items, plans and one dispatch run in that project every time it runs.

## 3. Environment

| variable                | what                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STAGING_BASE_URL`      | the app's public URL, e.g. `https://motir-staging.fly.dev`                                                                                          |
| `STAGING_ALLOWED_HOST`  | **must equal the hostname of `STAGING_BASE_URL`**, or nothing is sent. It is the guard that keeps a typo from pointing this at production           |
| `STAGING_MACHINE_A`     | one machine id from step 1                                                                                                                          |
| `STAGING_MACHINE_B`     | the other; the two must differ                                                                                                                      |
| `STAGING_USER_EMAIL`    | the test user                                                                                                                                       |
| `STAGING_USER_PASSWORD` | their password                                                                                                                                      |
| `STAGING_PAT`           | their token                                                                                                                                         |
| `STAGING_PROJECT_KEY`   | the test project's key                                                                                                                              |
| `STAGING_ORIGIN`        | optional: the `origin` header for Better-Auth and the cookie routes. Defaults to the base URL's origin, which is a trusted origin on a deployed app |

## 4. Run it

```sh
pnpm staging:two-machine-check            # cases 1-4, the controls for 2-4, the follow-ups (6a-6e)
pnpm staging:two-machine-check --json     # the same, with a JSON summary to paste
pnpm staging:two-machine-check --reset-control   # the password-reset control alone (see below)
```

It takes several minutes: each budget case waits for a fresh window, so a sequence cannot straddle a
window boundary.

### Expected output

One line per case, naming the machine that served the first and the second request of the pair the
case judges, and the statuses:

```
PASS 1 password reset: 3 on A, the 4th on B is 429 — first 1781e2..., second 3287d9..., statuses 200,200,200,429
PASS 2 sign-in: A, A, B are 401, the 4th on A is 429 — first 3287d9..., second 1781e2..., statuses 401,401,401,429
...
OK: 14 cases passed
```

A control line names the same machine twice, by design: its sequence is pinned to one machine.

### Exit codes

| code | meaning                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | every case passed                                                                                                                    |
| 1    | a case failed an assertion: a product failure                                                                                        |
| 2    | the configuration was refused, and nothing was sent                                                                                  |
| 3    | a bucket was already spent by an earlier run (call 1 was 429). Not a product failure: wait out the printed retry-after and run again |
| 4    | a machine is not ready, or the proxy did not enforce the pin, or a response could not be attributed to a machine                     |

## How a response is tied to a machine

Fly's proxy names no machine on a response (checked 2026-10-14: it adds `fly-request-id`,
`via: 1.1 fly.io` and `server: Fly/…`). So before any case the script pins one request to a machine
id that does not exist. Fly refuses it rather than routing it elsewhere, which shows the pin is
enforced, and from then on a response is attributed to the machine it was pinned to. If the app
answers that request, the pin is not enforced and the script stops with exit 4. A `fly-machine-id`,
`fly-instance-id` or `x-motir-machine-id` response header, if one ever appears, is read first, and one
naming a machine other than the pinned one fails the case.

## Whose bucket

Better-Auth (1.7.7) and `lib/rateLimit/keys.ts` both key a caller on `x-forwarded-for`. Better-Auth
trusts it only when it holds a single address. Behind Fly the proxy sets it to the caller's real
address, so the script sends none of its own: a spoofed value would arrive with a second address
appended, and Better-Auth would put every such request in one shared `no-trusted-ip` bucket. So every
bucket in this check is **the runner's**, for its whole window:

- the password-reset bucket is 3 per **hour**. The split case spends it, so the control for it cannot
  run in the same pass. Run `--reset-control` an hour later, or from a different runner;
- a second full run inside the hour stops on case 1 with exit 3.

## The case list is a copy

`lib/cases.ts` is a documented copy of `tests/two-instance/limits.spec.ts` and `followups.spec.ts`,
not a module both import. The local cases spoof a client IP per sequence and seed their data through
the app's services in-process, and neither is possible against a deployed app. Every assertion they
make is made here too. The three constants copied from the app (the stream's coalescing window and frame
name, the CLI's client id) are pinned to the app's values by `tests/staging/pinnedClient.test.ts`.
