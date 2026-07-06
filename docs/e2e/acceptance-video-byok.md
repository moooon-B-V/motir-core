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

## Run + upload in CI

```yaml
# In the acceptance E2E job, AFTER the app + acceptance E2E succeed:
- name: Acceptance E2E (records the video)
  run: pnpm exec playwright test --config playwright.acceptance.config.ts

- name: Publish the acceptance video (green only)
  if: success()
  uses: ./.github/actions/upload-acceptance-video
  with:
    story-key: MOTIR-1627
    produced-by: MOTIR-1638
    token: ${{ secrets.MOTIR_UPLOAD_TOKEN }}
    # base-url defaults to https://app.motir.co
```

`if: success()` (plus the uploader's own no-video no-op) guarantees a **red run
publishes nothing**.

## The `MOTIR_UPLOAD_TOKEN` secret

1. In Motir, mint an **API token** scoped to **`integration`** (Settings →
   API tokens), bound to the workspace that owns the story.
2. Add it to your repo as the **`MOTIR_UPLOAD_TOKEN`** secret.

The token authorizes the publish endpoint
(`POST /api/work-items/<storyKey>/acceptance-evidence`); it is subject to the
same eligibility gate as the in-app path (a token for an org without the paid AI
plan is rejected `402`).
