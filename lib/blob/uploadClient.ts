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
// server's English string.

// A minimal translator shape (satisfied by next-intl's useTranslations('errors')).
type UploadTranslator = (key: string) => string;

export async function uploadIssueAttachment(file: File, t: UploadTranslator): Promise<string> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch('/api/upload/issue-attachment', { method: 'POST', body: form });
  if (!res.ok) {
    let code: string | undefined;
    try {
      code = ((await res.json()) as { code?: string }).code;
    } catch {
      // non-JSON error body — fall through to the generic message
    }
    throw new Error(code ? t(`upload.${code}`) : t('upload.failed'));
  }

  const body = (await res.json()) as { url: string };
  return body.url;
}
