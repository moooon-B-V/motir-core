// Setup for the page editor's component suites (MOTIR-7275), self-scoped to the
// jsdom files by the `window` guard so the node suites are untouched.
//
//  • The act environment, as the root's `tests/helpers/actEnvironment.ts` turns
//    it on (MOTIR-1738): React flushes passive effects at the end of every act
//    scope, so an assertion after an interaction sees the effects it queued,
//    and a "not wrapped in act(...)" warning is a real finding.
//  • The layout APIs ProseMirror calls when it scrolls a selection into view.
//    jsdom implements no layout; these return empty boxes, which is all a
//    headless test needs.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

if (typeof window !== 'undefined') {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const emptyRect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON() {},
    }) as DOMRect;
  const emptyRects = (): DOMRectList =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;

  Range.prototype.getBoundingClientRect = emptyRect;
  Range.prototype.getClientRects = emptyRects;
  Element.prototype.getClientRects = emptyRects;
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
}

export {};
