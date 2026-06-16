import { Megaphone } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';

// BuildingInPublicBadge (Story 6.17 · Subtask 6.17.4) — the "Building in public"
// STATUS badge (design/public-projects Panel 12, the `pill-building` chip): a
// lavender build-tinted Pill (`--el-build-bg` + AA-safe `--el-build-text`) with
// the accent `--el-build-glyph` megaphone. It marks the project as building in
// public wherever the project is identified while access = `public` — the
// settings access manage row (authed) and the public visitor top bar — and it is
// the same chip the project-shell header shows once 6.17.3's header slot lands.
//
// Pure + presentational (no hooks) so it renders in BOTH the server tree (the
// public top bar) and the client tree (settings); the caller passes the already-
// translated label so neither namespace nor next-intl context is baked in here.
export function BuildingInPublicBadge({ label, className }: { label: string; className?: string }) {
  return (
    <Pill className={cn('border-transparent bg-(--el-build-bg) text-(--el-build-text)', className)}>
      <Megaphone className="size-3 text-(--el-build-glyph)" aria-hidden />
      {label}
    </Pill>
  );
}
