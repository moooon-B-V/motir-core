// The plan-history page sizes (design/work-items/design-notes.md § Plan history
// §6: the page reads the oldest 5, Show more appends pages of 20).
//
// ⚠️ A PLAIN MODULE, deliberately NOT `PlanHistorySection.tsx`. That file is
// `'use client'`, and across the client boundary every export of a client module
// is a client REFERENCE on the server — `page.tsx` importing the number from it
// received a stub, `clampPlanHistoryLimit` fell back to 20, and the section lost
// its bound (found by MOTIR-5549's acceptance run; guarded by
// `tests/components/item-detail-client-imports.test.ts`).
export const PLAN_HISTORY_FIRST_PAGE = 5;
export const PLAN_HISTORY_MORE_PAGE = 20;
