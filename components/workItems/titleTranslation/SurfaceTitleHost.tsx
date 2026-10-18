import type { ReactNode } from 'react';
import type { AutoTranslateContextDTO } from '@/lib/dto/autoTranslate';
import { SurfaceTitleTranslationProvider } from './SurfaceTitleTranslation';

// The server-side mount of a surface's title translation (Story MOTIR-7738 ·
// MOTIR-8834): a page starts the context read beside its own reads
// (`startSurfaceTranslation`) and hands the promise here, so the answer is awaited
// where it is needed rather than ahead of the page's data. With the switch off the
// answer is already `null` and the provider mounts nothing.

export async function SurfaceTitleHost({
  projectKey,
  contextRead,
  children,
}: {
  projectKey: string;
  contextRead: Promise<AutoTranslateContextDTO | null>;
  children: ReactNode;
}) {
  const context = await contextRead;
  return (
    <SurfaceTitleTranslationProvider projectKey={projectKey} context={context}>
      {children}
    </SurfaceTitleTranslationProvider>
  );
}
