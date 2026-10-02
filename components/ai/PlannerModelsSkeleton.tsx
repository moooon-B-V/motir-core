import { Card } from '@/components/ui/Card';
import { PageSkeleton } from '@/components/ui/PageSkeleton';

/**
 * The console AI planning page's loading frame (design panel 3). It lives under
 * `components/`, like `SettingsPaneFrame`, because a page under `app/` does not
 * consume `PageSkeleton` directly (tests/components/page-skeleton.test.tsx).
 *
 * The page header and its two lines are static copy and already painted above
 * this frame; only the card's three rows wait, drawn as a name, a trigger-sized
 * block and a last-changed line. No model id is guessed while motir-ai answers.
 */
export function PlannerModelsSkeleton({ title }: { title: string }) {
  return (
    <PageSkeleton header={false}>
      <Card header={<h2 className="font-sans text-sm font-semibold text-(--el-text)">{title}</h2>}>
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Block className="h-4 w-48" />
              <Block className="h-(--height-control) w-72" />
              <Block className="h-3 w-40" />
            </div>
          ))}
        </div>
      </Card>
    </PageSkeleton>
  );
}

function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}
