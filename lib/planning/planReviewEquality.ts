// THE EQUALITY A PLAN SNAPSHOT IS MERGED BY (Story MOTIR-8539 · Subtask MOTIR-8575).
//
// Structural, over the whole value — never a hash of chosen fields — so a field
// added to `PlanReviewItemDto` later is covered without anybody remembering to add
// it to a list. It is the one structural-equality helper the live surfaces share
// (`lib/utils/structurallyEqual.ts`), named here for the plan merge that uses it.

export { structurallyEqual as planReviewEqual } from '@/lib/utils/structurallyEqual';
