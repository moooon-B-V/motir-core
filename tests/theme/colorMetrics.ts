// MOTIR-2085 — the colour maths the palette suites measure with, in one place.
//
// Extracted verbatim from `statusHueSeparation.test.ts` (MOTIR-2073/2075), which
// was the only consumer until this card added a second one. Two suites now assert
// perceptual floors over the same token layer, and two copies of CIEDE2000 would
// be two things to keep in step — so the metric lives here and the suites import
// it. Nothing about the numbers changed in the move.

/** The three 0–255 channels of a `#rgb` / `#rrggbb` value. */
export function channels(hex: string): [number, number, number] {
  const value = hex.trim().replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`expected a 6-digit hex, got "${hex}"`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => linear(c / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, order-independent. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIELAB under D65, the space CIEDE2000 is defined in. */
export function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((c) => linear(c / 255)) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** CIEDE2000 colour difference — the perceptual metric, not a naive RGB distance. */
export function deltaE2000(hexA: string, hexB: string): number {
  const [l1, a1, b1] = lab(hexA);
  const [l2, a2, b2] = lab(hexB);
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const [ap1, ap2] = [(1 + g) * a1, (1 + g) * a2];
  const [cp1, cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
  const hp = (b: number, ap: number) =>
    (cp1 === 0 && cp2 === 0 ? 0 : (Math.atan2(b, ap) * 180) / Math.PI + 360) % 360;
  const [hp1, hp2] = [hp(b1, ap1), hp(b2, ap2)];

  const dLp = l2 - l1;
  const dCp = cp2 - cp1;
  let dhp = 0;
  if (cp1 * cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(cp1 * cp2) * Math.sin(rad(dhp) / 2);

  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hBar = (hp1 + hp2) / 2;
    else hBar = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(rad(hBar - 30)) +
    0.24 * Math.cos(rad(2 * hBar)) +
    0.32 * Math.cos(rad(3 * hBar + 6)) -
    0.2 * Math.cos(rad(4 * hBar - 63));
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cpBar;
  const sH = 1 + 0.015 * cpBar * t;
  const rT =
    -2 *
    Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7)) *
    Math.sin(rad(60 * Math.exp(-(((hBar - 275) / 25) ** 2))));

  return Math.sqrt(
    (dLp / sL) ** 2 + (dCp / sC) ** 2 + (dHp / sH) ** 2 + rT * (dCp / sC) * (dHp / sH),
  );
}
