import { test, expect, type Locator, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedOverlayVideo, type OverlayVideoSeed } from './_helpers/overlay-video-seed';
import en from '@/messages/en.json';

// THE RECORDING FITS THE APPROVAL OVERLAY (Bug MOTIR-6042).
//
// The overlay is full screen and its port is the height between band 1 and the verbs,
// with its own scroll. The receipt player was built for the item page's column and drew
// the `<video>` at the FULL WIDTH of whatever held it, 16:9 — so in the overlay its
// height followed the SCREEN'S WIDTH, and at every common desktop size the bottom of
// the recording, where the native controls live, sat below the fold (1440×900: a 792px
// video in a 660px port). A reviewer had to scroll inside the port to press play, and
// scrolling hid the top of what they were judging.
//
// The claim is geometric, so the assertion is too: at each viewport, with the port
// scrolled to its top, the whole `<video>` box lies inside the port's box. Both shapes
// the overlay draws a recording in are walked — the acceptance port, and the story run
// whose Development block the recording leads.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is on the dialog's named role
// or the `<video>` element being attached; the boxes are read after both.

test.describe.configure({ timeout: 180_000 });

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'the element has a box').not.toBeNull();
  return b!;
}

async function openOverlay(page: Page, key: string): Promise<Locator> {
  await page.goto(`/items/${key}?approval=${key}&approvalKind=acceptance_result`);
  const dialog = page.getByRole('dialog', { name: new RegExp(key) });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  return dialog;
}

/** The whole `<video>` inside the port, with the port at its top. */
async function expectVideoInsidePort(dialog: Locator, label: string) {
  const port = dialog.getByRole('group', { name: en.approvalGate.port.label, exact: true });
  const video = port.locator('video');
  await expect(video).toHaveCount(1, { timeout: 60_000 });
  await port.evaluate((el) => (el.scrollTop = 0));
  const p = await box(port);
  const v = await box(video);
  expect(v.y, `${label}: the video starts inside the port`).toBeGreaterThanOrEqual(p.y - 0.5);
  expect(v.y + v.height, `${label}: the video ends inside the port`).toBeLessThanOrEqual(
    p.y + p.height + 0.5,
  );
  expect(v.x + v.width, `${label}: the video is not wider than the port`).toBeLessThanOrEqual(
    p.x + p.width + 0.5,
  );
  // Still a real player, not a thumbnail: a 16:9 box at least 360px wide.
  expect(v.width, `${label}: the video keeps a watchable width`).toBeGreaterThanOrEqual(360);
  return { port, video };
}

test.describe('the acceptance recording fits the approval overlay', () => {
  let seed: OverlayVideoSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedOverlayVideo(Date.now().toString(36));
    await signIn(page, seed.reviewerEmail, seed.password);
  });

  test('the acceptance port: the whole video and its speed row, without scrolling', async ({
    page,
  }) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      const dialog = await openOverlay(page, seed.portKey);
      const label = `${viewport.width}×${viewport.height}`;
      const { port } = await expectVideoInsidePort(dialog, label);
      // The speed row sits directly under the video, so it is reachable without scrolling too.
      const speed = port.getByRole('button', { name: '1×', exact: true });
      const s = await box(speed);
      const p = await box(port);
      expect(s.y + s.height, `${label}: the speed row is inside the port`).toBeLessThanOrEqual(
        p.y + p.height + 0.5,
      );
    }
  });

  test('the story run: the recording leading the Development block fits too', async ({ page }) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      const dialog = await openOverlay(page, seed.runKey);
      await expect(dialog.getByTestId('acceptance-development-slot')).toHaveCount(1, {
        timeout: 60_000,
      });
      await expectVideoInsidePort(dialog, `${viewport.width}×${viewport.height}`);
    }
  });
});
