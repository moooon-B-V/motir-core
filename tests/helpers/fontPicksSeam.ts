// The ONE round trip story MOTIR-7736's two gate files describe (MOTIR-7900):
// the body the client's `setFontPick('ja', 'm-plus-rounded-1c')` sends, which is
// the same body `tests/integration/font-picks-story-gate.test.ts` PATCHes into
// the real route. Shared so the two halves of the seam cannot describe two
// different requests.
export const SEAM_LOCALE = 'ja' as const;
export const SEAM_MEMBER = 'm-plus-rounded-1c';
export const SEAM_BODY = { fontPicks: { [SEAM_LOCALE]: SEAM_MEMBER } } as const;
