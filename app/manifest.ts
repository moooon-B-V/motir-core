import type { MetadataRoute } from 'next';
import { BRAND_ACCENT_HEX, BRAND_PAGE_BG_HEX } from '@/components/brand/waveBand';

// The web app manifest (MOTIR-1150 · design/brand/design-notes.md §5). Next.js
// only auto-wires the icon files it FINDS, and until this card the app had
// exactly one — `app/favicon.ico` — and no manifest at all, which is why an iOS
// "Add to Home Screen" got a screenshot of the page instead of a mark.
//
// ⚠️ A manifest is static JSON: it cannot read a CSS variable, so `theme_color`
// and `background_color` are hex LITERALS. They come from the shared brand
// module, which records that they are the light-theme values of `--el-accent`
// and `--el-page-bg` — that provenance is the thing to keep in sync when the
// palette moves.
//
// ⚠️ THE MASKABLE PAIR IS DELIBERATELY THE SEPARATE `icon-192/512.png`, not
// `app/icon.svg`. A maskable icon is cropped to an arbitrary OS shape, so it is
// full-bleed with square corners and the glyph shrunk into the 0.8 safe circle;
// a browser-tab icon is not cropped and wants the mark as large as the tile
// allows. They are different renders of the same path, and declaring one file
// for both purposes would ship the wrong one twice.
//
// ⚠️ AND THEY LIVE IN `public/`, NOT `app/` — a correction to §5's file table,
// forced by shipped reality. Next's static-metadata matcher accepts exactly one
// optional DIGIT after `icon` (`variantsMatcher = '\d?'` in
// `next/dist/lib/metadata/is-metadata-route.js`), so `app/icon-192.png` matches
// nothing, is served at no URL, and the manifest entry below would 404. The
// alternative — naming them `app/icon1.png` / `icon2.png` — is worse twice over:
// Next would inject the full-bleed maskable renders as browser favicons, and it
// serves them from a content-hashed URL a static manifest cannot name. `public/`
// gives them the stable root path the manifest promises. `app/icon.svg` and
// `app/apple-icon.png` DO match the convention and stay where §5 puts them.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Motir',
    short_name: 'Motir',
    start_url: '/',
    display: 'standalone',
    theme_color: BRAND_ACCENT_HEX,
    background_color: BRAND_PAGE_BG_HEX,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
