import { getLocale } from 'next-intl/server';
import type { AutoTranslateContextDTO } from '@/lib/dto/autoTranslate';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { Locale } from '@/lib/i18n/locales';
import { readerTranslationContextService } from '@/lib/services/readerTranslationContextService';
import type { TranslationReader } from '@/lib/services/readerTranslationContextService';

// The reader's title-translation context for a BROWSING surface (Story MOTIR-7738
// · Subtask MOTIR-8833): resolved once, upstream, from the project the page
// already holds — no second project read — and handed to the surface's client
// provider. `null` means "mount nothing": a Visitor, or a project whose
// auto-translate switch is off. The provider also treats an off switch as nothing,
// so the answer is safe to pass straight through.

export async function resolveSurfaceTranslation(
  project: Pick<ProjectDTO, 'autoTranslateWorkContent'>,
  reader: TranslationReader,
): Promise<AutoTranslateContextDTO | null> {
  if (!project.autoTranslateWorkContent) return null;
  const readerLocale = (await getLocale()) as Locale;
  return readerTranslationContextService.resolveContext({ project, reader, readerLocale });
}
