// MOTIR-2674 — generate Panel G from the asset's OWN frames.
//
// The asset's convention is that every control in a frame is the REAL component's
// markup. So the marks-removed panel is not hand-typed: it is Panel B's frames,
// loaded in Chromium, mutated (org mark out, org name revealed, project chip
// replaced by an uploaded image or by nothing), and written back. Every class
// string in the output therefore still traces to a real render.
//
// Run: node scripts/build-context-row-panel.mjs   (rewrites design/shell/context-row.mock.html)
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const assetPath = path.join(root, 'design/shell/context-row.mock.html');

// A stand-in for an UPLOADED logo — a neutral rounded square with a mark on it.
// Deliberately not a palette colour: it represents a tenant's own artwork, which
// is exactly the thing the product does not choose. Inline so the asset stays
// self-contained.
const SAMPLE_LOGO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#2f6f5e"/><path d="M8 28l8-16 8 16z" fill="#ffffff"/><circle cx="29" cy="13" r="4" fill="#f2c14e"/></svg>`,
  );

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`file://${assetPath}`);

const frames = await page.evaluate(
  ({ logo }) => {
    // Panel B's band frames are the target bar; take one per width.
    const wanted = [320, 768, 1024, 1280];
    const out = [];
    const panelB = [...document.querySelectorAll('section.panel')].find((p) =>
      p.querySelector('.panel-h')?.textContent?.includes('Panel B'),
    );
    if (!panelB) return out;

    for (const vw of wanted) {
      const device = panelB.querySelector(`.device[data-vw="${vw}"]`);
      if (!device) continue;

      for (const withImage of [true, false]) {
        const clone = device.cloneNode(true);

        // 1. The ORG mark leaves.
        clone.querySelectorAll('span.bg-\\(--el-tint-lavender\\)').forEach((el) => el.remove());
        // 2. The org NAME is revealed from md (the resolved band).
        clone.querySelectorAll('span.hidden.xl\\:inline').forEach((el) => {
          el.classList.remove('hidden', 'xl:inline');
        });
        // 3. The project's preset chip becomes an uploaded image, or nothing.
        clone
          .querySelectorAll('[class*="bg-(--el-avatar-"], span.bg-\\(--el-avatar-fallback\\)')
          .forEach((chip) => {
            if (!withImage) {
              chip.remove();
              return;
            }
            const box = document.createElement('span');
            box.setAttribute('aria-hidden', 'true');
            box.className =
              'inline-flex h-5 w-5 flex-none items-center justify-center overflow-hidden rounded-(--radius-control)';
            const img = document.createElement('img');
            img.src = logo;
            img.alt = '';
            img.className = 'h-full w-full object-cover';
            box.appendChild(img);
            chip.replaceWith(box);
          });

        out.push({ vw, withImage, html: clone.outerHTML });
      }
    }
    return out;
  },
  { logo: SAMPLE_LOGO },
);

await browser.close();

const BAND_LABEL = {
  320: '320px — the project ALONE',
  768: '768px (md) — the org returns as its NAME',
  1024: '1024px (lg) — unchanged from md',
  1280: '1280px (xl) — the FULL path',
};

const figures = frames
  .map(
    (f) => `        <figure class="frame">
          <figcaption>
            ${BAND_LABEL[f.vw]} — project ${f.withImage ? '<b>WITH</b> an uploaded image' : '<b>with NO image</b>: nothing renders, the gap closes'}
          </figcaption>
${f.html
  .split('\n')
  .map((l) => `          ${l}`)
  .join('\n')}
        </figure>`,
  )
  .join('\n');

const panel = `      <section class="panel">
        <h2 class="panel-h">Panel G · Without the marks — the resolved row (MOTIR-2674)</h2>
        <p class="panel-p">
          <code>docs/decisions/entity-marks.md</code> deletes the organization's mark and makes the
          project's an optional uploaded image. Two things follow, and the first is the reason this
          panel exists: at <code>md</code>–<code>xl</code> the org tier rendered its MARK and nothing
          else, so removing it would leave <b>a ghost button holding a chevron</b>. The resolution is
          to reveal the org's NAME from <code>md</code> — measured at <b>+2px</b> against today's
          mark form at 768px and <b>+7px</b> at 1024px, with <b>zero overflow at every band</b>
          (<code>scripts/measure-context-row.mjs</code>, re-runnable). Every frame below is Panel B's
          real markup with those mutations applied, not a redraw.
        </p>
        <p class="panel-p">
          The second: each band is drawn TWICE — a project with an uploaded image and one without —
          because once images are optional the mixed case is the normal one. <b>Nothing renders where
          the mark would be</b>: no placeholder box, no dashed outline, no monogram. The gap closes
          and the name moves left.
        </p>
${figures}
      </section>
`;

let html = fs.readFileSync(assetPath, 'utf8');
const marker = '    </div>\n  </body>';
const at = html.lastIndexOf(marker);
if (at === -1) throw new Error('could not find the closing </main> to append Panel G before');
html = html.slice(0, at) + panel + html.slice(at);
fs.writeFileSync(assetPath, html);
console.log(`Panel G written with ${frames.length} frames`);
