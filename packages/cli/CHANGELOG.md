# Changelog — `@motir/cli`

Notable changes to the `motir` command-line tool, newest first. Written for
someone who INSTALLS it: what changed for you, and what you might have to do
about it.

The version here is the CLI's own. It is not the Motir server's release number
and not the API contract version — see
[§ When your server is older](../../docs/cli.md#when-your-server-is-older) for
that distinction, which this release makes visible for the first time.

---

## 0.2.0

**The CLI now speaks Motir's public REST API.** Every command is an ordinary
HTTPS request to `/api/v1` with your personal access token as its bearer — the
same documented endpoints, the same credential and the same scopes any
third-party integration gets. Until this release it spoke the Model Context
Protocol at `/api/mcp`.

**Your commands, flags and output are unchanged.** That is the point of the
release rather than a footnote: the suite that drives the built binary end to
end asserts the same expected output it did before the migration, byte for byte,
and not one of those expectations was edited. If you script against `motir`,
nothing you have written needs to change.

### What you will actually notice

- **`@modelcontextprotocol/sdk` is gone.** Installing `@motir/cli` no longer
  pulls an agent-protocol SDK into your `node_modules`. Motir still serves MCP at
  `/api/mcp` — for agents — and the CLI is simply no longer one of its clients.
- **A missing scope now says which scope.** A refusal arrives as an HTTP 403 and
  the CLI names the scope the operation needed, instead of a generic tool error:
  `This token lacks the 'read' scope required for getProjectReadySet.` Scopes are
  fixed when a token is minted, so the fix is a new token, not a retry.
- **A rate-limited call tells you when to try again**, from the server's own
  reset header rather than a guess.
- **A server older than this CLI says so, once, clearly.** This is the only
  genuinely new thing to learn, and it exists because the CLI ships to npm on its
  own schedule while your Motir upgrades on yours:

  ```
  Error: This CLI needs Motir API >= 1.6.0; https://motir.example.com serves 1.4.0.
  Hint: Upgrade your Motir server, or install a CLI built for it.
  ```

  The numbers are the **API contract's** version — not an app release, not this
  CLI's `--version`. Two remedies, and only two: upgrade the server, or
  `npm install -g @motir/cli@<older>`. A server at or AHEAD of this CLI is never
  reported as skew, and a probe that cannot reach the spec leaves the original
  error standing rather than inventing a diagnosis.
  [Full section](../../docs/cli.md#when-your-server-is-older).

### For anyone integrating

The API this CLI uses is documented at
[`/docs/api`](https://app.motir.co/docs/api), with the machine-readable spec at
[`/api/openapi/v1.json`](https://app.motir.co/api/openapi/v1.json) — the same
document this package's types are generated from. Nothing the CLI does is
privileged; if you would rather script it yourself, you can.

---

## 0.1.1

Bumped so the published **sandbox images** would stop shipping a `motir` that
predated `motir login`: the image tagged `:claude` carried a binary from eleven
commits earlier and greeted new users with a credential banner naming a tier the
docs no longer described. No change to the CLI itself beyond the version string.

Also added the drift tripwire that makes the next such gap loud — a check that
compares the newest `cli-v*` tag against the repository and fails once unreleased
work has sat past its window.

---

## 0.1.0

First public release: the `motir` command set — `login` / `auth`, `link`,
`doctor`, the read commands (`ready` / `status` / `sprints` / `sprint` / `show`
/ `open`), single dispatch (`next` / `run` / `done`), the loop (`auto` /
`batch`), and `plan`. Published to npm with provenance, alongside the BYOK
sandbox images that carry the same binary by construction.
