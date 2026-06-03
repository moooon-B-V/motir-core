// Client helper (Subtask 2.3.7): POST a File to the upload endpoint and resolve
// to its public URL. This is the default `onFileUpload` the create modal (2.3.3)
// and edit form (2.3.6) hand to the MarkdownEditor. Kept OUT of the editor
// primitive itself so the generic `components/ui/MarkdownEditor` never hardcodes
// an app route (layering — rung 2 over the card's "the editor gains a default").
// The editor decides `![]` vs `[]` from the File's own MIME; this just returns
// the URL. A typed server error (413/415/429) surfaces as the thrown message,
// which the editor turns into its polite inline notice.

export async function uploadIssueAttachment(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch('/api/upload/issue-attachment', { method: 'POST', body: form });
  if (!res.ok) {
    let message = 'Upload failed — please try again.';
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }

  const body = (await res.json()) as { url: string };
  return body.url;
}
