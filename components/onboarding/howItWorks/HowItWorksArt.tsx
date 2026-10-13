import { Check } from 'lucide-react';
import { BrandMark } from '@/components/brand/BrandMark';
import { ArtBar, ArtPaper, SectionArt } from '@/components/onboarding/layout';

// The three how-it-works drawings (MOTIR-8253) — design-notes.md § "Revision 1
// (2026-10-12)", "What changed" item 1, drawn in Panels 4 and 5 of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`.
// motir.co's ModuleArt idiom (a tinted field holding a small example screen),
// WORDLESS by design: the screens are skeleton bars, so no string here needs a
// catalogue key, and the heading and body beside each field carry the meaning.
// Each field is `aria-hidden` (`SectionArt`), so nothing inside is announced.
// Three different tint slots, so the drawings read apart in every palette.
//
// Every colour is an existing `--el-*` token; every radius / padding / shadow is
// an element-semantic shape token (`SectionArt`, `ArtPaper` and `ArtBar` carry
// the field, paper and bar ones).

/** "Say what you want" — a few lines typed (with a caret), Motir asking back,
 *  three answer chips with one picked. `--el-tint-sky`. */
export function SayArt() {
  return (
    <SectionArt tint="sky" name="say">
      <ArtPaper className="grid gap-2 px-(--spacing-input-x) py-(--spacing-input-y)">
        <ArtBar width={88} />
        <span className="flex items-center gap-1">
          <ArtBar width={56} />
          <span className="block h-3.5 w-[2px] bg-(--el-accent-on-surface)" />
        </span>
      </ArtPaper>
      <div className="flex items-start gap-2.5">
        <span className="grid size-7 flex-none place-items-center rounded-full border border-(--el-border) bg-(--el-card)">
          <BrandMark variant="mark" size={14} />
        </span>
        <ArtPaper className="grid flex-1 gap-2 px-(--spacing-control-x) py-(--spacing-control-y)">
          <ArtBar width={72} />
          <ArtBar width={44} />
        </ArtPaper>
      </div>
      <div className="flex justify-end gap-2">
        <span className="block h-6 w-14 rounded-(--radius-badge) border border-(--el-border-strong) bg-(--el-card)" />
        <span className="block h-6 w-16 rounded-(--radius-badge) border border-(--el-accent) bg-(--el-accent)" />
        <span className="block h-6 w-12 rounded-(--radius-badge) border border-(--el-border-strong) bg-(--el-card)" />
      </div>
    </SectionArt>
  );
}

/** One plan-tree row: an owner square, a skeleton title, and a tick or an open ring. */
function PlanRow({
  indent,
  width,
  owner,
  done,
}: {
  indent: '' | 'pl-4' | 'pl-8';
  width: number;
  owner: 'motir' | 'person';
  done: boolean;
}) {
  return (
    <span className={['flex items-center gap-2', indent].filter(Boolean).join(' ')}>
      <span
        className={
          owner === 'motir'
            ? 'block size-2.5 flex-none bg-(--el-accent-on-surface)'
            : 'block size-2.5 flex-none bg-(--el-showcase-decision)'
        }
      />
      <ArtBar width={width} />
      {done ? (
        <span className="ml-auto inline-flex text-(--el-success)">
          <Check className="size-3.5" aria-hidden="true" />
        </span>
      ) : (
        <span className="ml-auto block size-3.5 flex-none rounded-full border-2 border-(--el-border-strong)" />
      )}
    </span>
  );
}

/** "Watch it take shape" — a plan tree filling in (Motir's rows accent squares,
 *  the person's row the decision colour), a design frame and a progress strip.
 *  `--el-tint-lavender`. */
export function WatchArt() {
  return (
    <SectionArt tint="lavender" name="watch">
      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-3">
        <ArtPaper className="grid content-start gap-2.5 p-(--spacing-control-x)">
          <PlanRow indent="" width={58} owner="motir" done />
          <PlanRow indent="pl-4" width={50} owner="motir" done />
          <PlanRow indent="pl-4" width={42} owner="person" done={false} />
          <PlanRow indent="pl-8" width={36} owner="motir" done={false} />
        </ArtPaper>
        <ArtPaper className="grid content-start gap-2 p-(--spacing-control-x)">
          <span className="block h-14 rounded-(--radius-control) bg-(--el-tint-sky)" />
          <ArtBar width={70} />
          <ArtBar width={46} />
        </ArtPaper>
      </div>
      <span className="block h-1.5 overflow-hidden rounded-(--radius-badge) bg-(--el-border)">
        <span className="block h-full w-[62%] bg-(--el-accent-on-surface)" />
      </span>
    </SectionArt>
  );
}

/** "You decide" — a finished piece back for review: title bar, preview, a
 *  secondary and an Approve shape, and the decision marker. `--el-tint-peach`. */
export function DecideArt() {
  return (
    <SectionArt tint="peach" name="decide">
      <ArtPaper className="grid gap-2.5 p-(--spacing-card-padding)">
        <span className="block h-3 w-[48%] rounded-(--radius-badge) bg-(--el-text-secondary)" />
        <span className="block h-16 rounded-(--radius-control) bg-(--el-surface)" />
        <ArtBar width={80} />
        <span className="flex items-center justify-end gap-2 pt-1">
          <span className="block h-7 w-16 rounded-(--radius-btn) border border-(--el-button-border) bg-(--el-card)" />
          <span className="relative inline-flex h-7 w-20 items-center justify-center rounded-(--radius-btn) bg-(--el-accent) text-(--el-accent-text)">
            <Check className="size-4" aria-hidden="true" />
            <span className="absolute -top-1.5 -right-1.5 block size-3 bg-(--el-showcase-decision)" />
          </span>
        </span>
      </ArtPaper>
    </SectionArt>
  );
}
