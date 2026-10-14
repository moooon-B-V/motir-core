import type { FieldTranslationDTO, TranslateResponseDTO } from '@/lib/dto/workItemTranslation';
import type { Locale } from '@/lib/i18n/locales';
import type { FieldTranslationResult } from '@/lib/services/workItemTranslationService';

// The translation door's results → the route's response (Story MOTIR-7735 ·
// Subtask MOTIR-8121). The door's machine `reason` (`job_failed`, `unavailable`,
// …) stays server-side: the page renders one failed state whatever the cause,
// and the DTO carries status and text only.

export function toFieldTranslationDTO(result: FieldTranslationResult): FieldTranslationDTO {
  if (result.status === 'ready') {
    return { fieldRef: result.fieldRef, status: 'ready', text: result.text };
  }
  return { fieldRef: result.fieldRef, status: result.status };
}

export function toTranslateResponseDTO(
  targetLanguage: Locale,
  results: readonly FieldTranslationResult[],
): TranslateResponseDTO {
  return { targetLanguage, fields: results.map(toFieldTranslationDTO) };
}
