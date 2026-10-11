import { MarkdownView } from '@/components/ui/MarkdownView';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// The plan's BRIEFING (MOTIR-8149 wrote it, MOTIR-8172 draws it): the six-section
// Markdown a planner stores in `plan.summary`. Sections 1, 2 and 6 (what was
// asked, the premise, the counts) stay open; 3–5 sit behind their headings so a
// long briefing never pushes the Approve / Decline gate out of reach — the rail
// must not depend on the briefing being short (MOTIR-8168 fixes that at source).
//
// Splits on the `## <n>.` headings only. A summary with no numbered headings (a
// plan written before the briefing existed, or a planner that drifted) renders as
// ONE Markdown block: nothing is hidden that we cannot name.

const COLLAPSED_SECTIONS = new Set([3, 4, 5]);
const NUMBERED_HEADING = /^##\s+(\d+)\.\s*(.*)$/;

interface BriefingSection {
  number: number | null;
  heading: string;
  body: string;
}

export function splitBriefing(markdown: string): BriefingSection[] {
  const sections: BriefingSection[] = [];
  let current: { number: number | null; heading: string; lines: string[] } | null = null;
  let fence = false;
  const flush = () => {
    if (current) {
      sections.push({
        number: current.number,
        heading: current.heading,
        body: current.lines.join('\n').trim(),
      });
    }
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : NUMBERED_HEADING.exec(line);
    if (m) {
      flush();
      current = { number: Number(m[1]), heading: `${m[1]}. ${m[2]}`.trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      current = { number: null, heading: '', lines: [line] };
    }
  }
  flush();
  return sections.filter((s) => s.heading !== '' || s.body !== '');
}

export function PlanBriefing({
  summary,
  workItemRefs,
}: {
  summary: string;
  workItemRefs?: WorkItemRefMap;
}) {
  const sections = splitBriefing(summary);
  const refs = workItemRefs ? { workItemRefs } : {};
  return (
    <div className="flex min-w-0 flex-col gap-2 wrap-anywhere" data-testid="plan-briefing">
      {sections.map((s, i) => {
        if (s.number === null) {
          return <MarkdownView key={i} value={s.body} {...refs} />;
        }
        if (COLLAPSED_SECTIONS.has(s.number)) {
          return (
            <details
              key={i}
              data-testid={`plan-briefing-section-${s.number}`}
              className="rounded-(--radius-control) border border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y)"
            >
              <summary className="cursor-pointer text-sm font-semibold text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none">
                {s.heading}
              </summary>
              <MarkdownView value={s.body} {...refs} />
            </details>
          );
        }
        return (
          <section key={i} data-testid={`plan-briefing-section-${s.number}`}>
            <h3 className="text-sm font-semibold text-(--el-text)">{s.heading}</h3>
            <MarkdownView value={s.body} {...refs} />
          </section>
        );
      })}
    </div>
  );
}
