import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Eye } from 'lucide-react';

// THE VISITOR BANNER (Story MOTIR-6170 · MOTIR-6648; design MOTIR-6641 panel 4):
// the closing bar's grammar (`OrganizationClosingBanner`) — a `role="status"`
// strip in `AppLayout`'s banner slot, glyph + one sentence, no action. Sky tint
// with an `Eye` in the info hue: watching is information, not danger. It restates,
// every visit, what the reader agreed to on the consent screen, and names nobody.

const bold = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;

export async function VisitorBanner({ projectName }: { projectName: string }) {
  const t = await getTranslations('visitor.shell');
  return (
    <div
      role="status"
      data-testid="visitor-banner"
      className="flex flex-wrap items-center justify-center gap-3 border-b border-(--el-border) bg-(--el-tint-sky) px-4 py-2 text-center font-sans text-sm text-(--el-text-strong)"
    >
      <Eye aria-hidden className="h-4 w-4 shrink-0 text-(--el-info)" />
      <span className="min-w-0">{t.rich('banner', { project: projectName, b: bold })}</span>
    </div>
  );
}
