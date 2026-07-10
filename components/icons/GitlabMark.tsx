import type { SVGProps } from 'react';

// The GitLab "mark" (tanuki) logo, rendered MONOCHROME. lucide-react (1.16)
// dropped brand icons, and the GitLab-integration design (MOTIR-1472) puts the
// provider mark on the Connect button + the shared "Git" surface's provider
// picker. Per the design's colour row it is `fill="currentColor"` — the same
// treatment as `GithubMark` — so NO invented brand hue enters the app: the mark
// takes the surrounding text/icon colour and swaps with `data-palette`. The
// standard 24×24 viewBox makes it size + colour exactly like a lucide icon (drive
// size/colour from the parent via `h-*`/`w-*`/`text-(--el-*)`).
export function GitlabMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 0 0-.867 0L1.386 9.452.044 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.625-8.443a.924.924 0 0 0 .33-1.024" />
    </svg>
  );
}
