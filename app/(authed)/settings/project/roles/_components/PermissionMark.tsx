import { Check, Eye, Minus } from 'lucide-react';

// The HELD / WITHHELD / LEVEL-GATED mark on a permission row (Subtask
// MOTIR-2263), built to `design/projects/roles-permissions.mock.html`.
//
// ⚠️ STATE IS NEVER CARRIED BY COLOUR OR GLYPH ALONE. Each mark is a
// `role="img"` with an `aria-label` naming the state, which is what makes the
// screen readable to somebody who cannot distinguish a green tick from a grey
// dash — the design notes make this explicit.
//
// ⚠️ A WITHHELD PERMISSION STAYS FULLY LEGIBLE — a dash, never a dimmed row.
// The screen's job is to show the whole model, so "not held" has to read as
// clearly as "held"; dimming would make the model look half-present.

export type PermissionMarkKind = 'held' | 'withheld' | 'level';

const GLYPH = { held: Check, withheld: Minus, level: Eye } as const;

// The mark's ink. `--el-success` for held; `--el-text-faint` for the two that
// are not a grant this role carries — quiet, but never invisible.
const INK = {
  held: 'text-(--el-success)',
  withheld: 'text-(--el-text-faint)',
  level: 'text-(--el-text-faint)',
} as const;

export function PermissionMark({ kind, label }: { kind: PermissionMarkKind; label: string }) {
  const Glyph = GLYPH[kind];
  return (
    <span
      role="img"
      aria-label={label}
      data-mark={kind}
      className={`flex items-center justify-center self-center ${INK[kind]}`}
    >
      <Glyph aria-hidden="true" className="h-[15px] w-[15px]" />
    </span>
  );
}
