// The late stack's pending frame carries this attribute, so the item header's
// decision-waiting marker (MOTIR-5878) has somewhere to scroll when it is pressed
// before the section that holds the gate has streamed in. A plain module, so the
// server `LateSections` and the client header marker share one spelling.
export const LATE_FALLBACK_ATTR = 'data-late-stack-fallback';
