import { Card } from '@/components/ui/Card';
import { PageSkeleton } from '@/components/ui/PageSkeleton';

/**
 * The Ideas list's loading frame — design § Ideas Panel 3a. The page header is
 * static copy and already painted above this frame; the card's title paints at
 * once, five skeleton rows wait, and no count is guessed.
 */
export function IdeasSkeleton({ title }: { title: string }) {
  return (
    <PageSkeleton header={false}>
      <Card header={<h2 className="font-sans text-sm font-semibold text-(--el-text)">{title}</h2>}>
        <div aria-busy="true" data-testid="ideas-loading" className="flex flex-col gap-4">
          <div className="flex gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Block key={i} className="h-(--height-control) w-36" />
            ))}
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Block className="h-4 w-72" />
              <Block className="h-4 w-24" />
              <Block className="h-4 w-32" />
              <Block className="h-4 w-20" />
              <Block className="h-3 w-24" />
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
