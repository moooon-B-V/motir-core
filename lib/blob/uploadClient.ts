// Client helper (Subtask 2.3.7): POST a File to the upload endpoint and resolve
// to its public URL. This is the default `onFileUpload` the create modal (2.3.3)
// and edit form (2.3.6) hand to the MarkdownEditor. Kept OUT of the editor
// primitive itself so the generic `components/ui/MarkdownEditor` never hardcodes
// an app route (layering — rung 2 over the card's "the editor gains a default").
// The editor decides `![]` vs `[]` from the File's own MIME; this just returns
// the URL. A typed server error (413/415/429) surfaces as the thrown message,
// which the editor turns into its polite inline notice.
//
// i18n: the route returns a stable `code`; this maps it to a TRANSLATED message
// via the `errors`-scoped translator the caller passes in (a client component's
// useTranslations('errors')) — so the editor notice is localized, not the
// server's English string. A §4 cap refusal (402 `ENTITLEMENT_EXCEEDED`) carries
// no per-code sentence: its words depend on WHICH cap, so it is selected by the
// body's `entitlement` kind instead (MOTIR-5133). Before that, the code arm
// looked up `upload.ENTITLEMENT_EXCEEDED`, a key no catalogue has.

import { isEntitlementKind, type EntitlementKind } from '@/lib/billing/entitlements';
import type { AttachmentDTO } from '@/lib/dto/attachments';
import { entitlementExceededMessage } from '@/lib/billing/entitlementCopy';

// A minimal translator shape (satisfied by next-intl's useTranslations('errors')).
type UploadTranslator = (key: string) => string;

export async function uploadIssueAttachment(file: File, t: UploadTranslator): Promise<string> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch('/api/upload/issue-attachment', { method: 'POST', body: form });
  if (!res.ok) {
    let body: { code?: string; entitlement?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON error body — fall through to the generic message
    }
    if (isEntitlementKind(body.entitlement)) {
      throw new Error(entitlementExceededMessage(t, body.entitlement));
    }
    throw new Error(body.code ? t(`upload.${body.code}`) : t('upload.failed'));
  }

  const body = (await res.json()) as { url: string };
  return body.url;
}

// ── The work-item attachment upload (Story 5.2 · Subtask 5.2.5) ───────────────
// Moved here from the item page's `AttachmentsPanel` when the guide composer
// became its second caller (Story MOTIR-7471 · MOTIR-7486): one XHR upload, one
// typed failure and one message mapping, so the two surfaces cannot drift on
// what a refusal says.

/**
 * Rejection carrying the route's typed error code (e.g. FILE_TOO_LARGE) and, for
 * a §4 cap refusal (402), the refused `entitlement` kind that selects its words.
 */
export class UploadFailure extends Error {
  constructor(
    readonly code?: string,
    readonly entitlement?: EntitlementKind,
  ) {
    super(code ?? 'UPLOAD_FAILED');
  }
}

/** The code an ABORTED upload rejects with — a cancel, not a failure. */
export const UPLOAD_ABORTED = 'ABORTED';

/** The codes `messages/*.json` localizes under `errors.upload.*` (2.3.7). */
export const LOCALIZED_UPLOAD_CODES: ReadonlySet<string> = new Set([
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FILE_TYPE',
  'RATE_LIMITED',
]);

/**
 * The words for a failed upload, from an `errors`-scoped translator. A cap
 * refusal is not transient — "please try again" would be false — and its words
 * depend on WHICH cap, so the body's `entitlement` selects the catalogue
 * sentence; the server's English `error` is never shown (MOTIR-5133 / MOTIR-5444).
 */
export function uploadFailureMessage(
  t: UploadTranslator,
  failure: { code?: string; entitlement?: EntitlementKind },
): string {
  if (failure.entitlement) return entitlementExceededMessage(t, failure.entitlement);
  if (failure.code && LOCALIZED_UPLOAD_CODES.has(failure.code)) return t(`upload.${failure.code}`);
  return t('upload.failed');
}

/** POST one file to a work item's attachments with upload progress (XHR — fetch
 *  can't report it). Resolves to the new attachment on 201. */
export function postWorkItemAttachment(
  workItemId: string,
  file: File,
  onProgress: (pct: number | null) => void,
  register: (xhr: XMLHttpRequest) => void,
): Promise<AttachmentDTO> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    xhr.open('POST', `/api/work-items/${workItemId}/attachments`);
    xhr.upload.onprogress = (event) => {
      onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    };
    xhr.onload = () => {
      if (xhr.status === 201) {
        try {
          resolve(JSON.parse(xhr.responseText) as AttachmentDTO);
          return;
        } catch {
          reject(new UploadFailure());
          return;
        }
      }
      let body: { code?: string; entitlement?: unknown } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // non-JSON error body — fall through to the generic message
      }
      reject(
        new UploadFailure(
          body.code,
          isEntitlementKind(body.entitlement) ? body.entitlement : undefined,
        ),
      );
    };
    xhr.onerror = () => reject(new UploadFailure());
    xhr.onabort = () => reject(new UploadFailure(UPLOAD_ABORTED));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
