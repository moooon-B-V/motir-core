# Acceptance-video recording + upload (BYOK)

Story **MOTIR-1627** closes the review loop with a human **acceptance gate**: a
story's E2E, on a green run, records a short **video**; CI ships it to the story
as pending acceptance evidence; a reviewer watches it in the acceptance panel and
Approves (`in_review → done`) or Requests changes.

This is the **BYOK** (bring-your-own-CI) delivery path — your own GitHub Actions
run the acceptance E2E and POST the clip to Motir. (Epic 9's hosted runner does
the same from its own sandbox — a separate concern.)

## Pieces (Subtask MOTIR-1632)

| Piece                                     | What it does                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `playwright.acceptance.config.ts`         | A dedicated lane that records `video: 'on'` (720p) + `trace: 'on'`, matching `**/acceptance-video.spec.ts`. |
| `tests/e2e/_helpers/acceptance-video.ts`  | `test` + `chapter(label, body)` — a chaptered `test.step` that also writes a `chapters.json` sidecar.       |
| `scripts/upload-acceptance-video.mjs`     | Reads the video + trace + chapters from the lane's `outputDir` and POSTs them to the publish endpoint.      |
| `.github/actions/upload-acceptance-video` | A composite Action wrapping the uploader for easy reuse.                                                    |

## The acceptance spec (authored by MOTIR-1638)

Import the harness and wrap each user-visible phase in a `chapter`:

```ts
import { test, expect } from './_helpers/acceptance-video';

test('story acceptance flow', async ({ page, chapter }) => {
  await chapter('Open the story', async () => {
    await page.goto('/items/MOTIR-1627');
    await expect(page.getByRole('heading', { name: /acceptance gate/i })).toBeVisible();
  });
  await chapter('Watch the evidence + approve', async () => {
    /* … */
  });
});
```

Keep the spec **short** (≤ ~60 s) — it is a focused happy-path drive, and the
clip is capped to a few MB per the ADR.

## Run + upload in CI (keyless — no secret)

If your repo is connected via the **Motir GitHub App**, publishing is **keyless**
— there is **no token to mint or store**. Grant the job `id-token: write` and the
uploader authenticates off the run's own GitHub **OIDC** identity:

```yaml
# In the acceptance E2E job, AFTER the app + acceptance E2E succeed:
jobs:
  acceptance:
    permissions:
      contents: read
      id-token: write # ← lets the uploader mint a keyless OIDC token
    steps:
      - name: Acceptance E2E (records the video)
        run: pnpm exec playwright test --config playwright.acceptance.config.ts

      - name: Publish the acceptance video (green only)
        if: success()
        uses: ./.github/actions/upload-acceptance-video
        with:
          # Resolve the target story from the PR instead of a hardcoded key
          # (MOTIR-1684): the PR's `MOTIR-<id>` → its parent story.
          pr-ref: ${{ github.head_ref }}
          pr-title: ${{ github.event.pull_request.title }}
          fallback-story-key: MOTIR-1627 # used on push-to-main / no PR id
          produced-by: MOTIR-1638
          # no `token:` — keyless OIDC. base-url defaults to https://app.motir.co
```

`if: success()` (plus the uploader's own no-video no-op) guarantees a **red run
publishes nothing**. The endpoint verifies the run's OIDC token, resolves the
repo → your Motir workspace (via the GitHub App connection), and attributes the
evidence to the **workspace owner** — subject to the same eligibility gate as the
in-app path (an org without the paid AI plan is rejected `402`).

### How the target story is resolved (MOTIR-1684)

The publish is **not** pinned to a hardcoded story. `resolveStoryKey` picks the
target in precedence: **(1)** an explicit `story-key` (override); **(2)** the
recording's **self-declared story** — the `acceptance-story.json` sidecar the
acceptance harness writes when a spec calls `acceptanceStory('MOTIR-<id>')`
(authoritative for what the clip depicts, so the self-test dogfood always pins
to MOTIR-1627 and is never mis-attributed to an unrelated PR); **(3)** the PR's
`MOTIR-<id>` from `pr-ref` / `pr-title` — a **subtask** key resolves UP to its
**parent story** server-side (acceptance is story-level, Principle #18);
**(4)** `fallback-story-key`. Acceptance E2Es published from CI should pass
`pr-ref` + `pr-title` + `fallback-story-key`, or self-declare via the harness —
not a hardcoded `story-key`.

## Fallback — the `MOTIR_UPLOAD_TOKEN` secret (unconnected repos)

If your repo is **not** connected via the Motir GitHub App, authenticate with a
token instead of OIDC:

1. In Motir, mint an **API token** scoped to **`integration`** (Settings → API
   tokens), bound to the workspace that owns the story.
2. Add it to your repo as the **`MOTIR_UPLOAD_TOKEN`** secret and pass it to the
   Action — you can then drop the `id-token: write` permission:

```yaml
- name: Publish the acceptance video (green only)
  if: success()
  uses: ./.github/actions/upload-acceptance-video
  with:
    story-key: MOTIR-1627
    produced-by: MOTIR-1638
    token: ${{ secrets.MOTIR_UPLOAD_TOKEN }}
```

Same endpoint (`POST /api/work-items/<storyKey>/acceptance-evidence`) and the
same eligibility gate — only the authentication differs.
