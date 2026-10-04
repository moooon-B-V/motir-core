import { Card } from '@/components/ui/Card';
import { PageSkeleton } from '@/components/ui/PageSkeleton';

/**
 * The console Planning lessons page's loading frame (design Panel 3a). The page
 * header is static copy and already painted above this frame; the card's head
 * paints at once and five skeleton rows wait. No count is guessed.
 */
export function PlatformLessonsSkeleton({ title }: { title: string }) {
  return (
    <PageSkeleton header={false}>
      <Card header={<h2 className="font-sans text-sm font-semibold text-(--el-text)">{title}</h2>}>
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Block key={i} className="h-(--height-control) w-36" />
            ))}
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Block className="h-4 w-72" />
              <Block className="h-4 w-24" />
              <Block className="h-4 w-40" />
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
