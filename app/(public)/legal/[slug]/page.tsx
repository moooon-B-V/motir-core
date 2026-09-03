import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getLegalDocument } from '@/lib/legal/documents';

// One published legal document (Story 8.4 · MOTIR-1134) — now a REDIRECT to it
// (MOTIR-4007).
//
// ── ⚠️ WHY THIS PAGE STOPPED RENDERING A DOCUMENT ──────────────────────────
// It rendered `doc.body`, and `lib/legal/documents.ts` no longer has one: the
// documents are moooon B.V.'s contract text and have left this GPL-3.0
// repository (MOTIR-3909), so the loader reads a configured MANIFEST whose
// entries carry a `url` instead. This route therefore has nothing of its own to
// serve, and there are exactly two honest things it can do with a slug it
// recognises: 404 it, or send the reader to where the document actually is.
//
// It sends them. A reader holding a `/legal/terms` link — from an email, a
// bookmark, an old sign-up notice — asked for the Terms, and the Terms exist;
// answering 404 because the bytes moved would lose them for no reason. The
// redirect is PERMANENT because the document's home has genuinely changed.
//
// ── ⚠️ THIS IS A WINDOW, NOT AN ARRANGEMENT ────────────────────────────────
// The route itself is deleted with the rest of `app/(public)/legal/` by
// MOTIR-4103, which runs in the story AFTER the deploy boundary. Until then it
// stays reachable on a build whose `MOTIR_PUBLIC_SITE_URL` is unset — with it
// set, `proxy.ts`'s `PUBLIC_REDIRECT_SEGMENTS` 308s `/legal/*` to the public
// site before this file is ever reached (MOTIR-3884). So this redirect covers
// exactly the un-cut-over case, which is the only one that gets here. It must
// stay dynamically rendered: the manifest is runtime configuration and is not
// available to a build-time `generateStaticParams` pass.
//
// ── The unconfigured build ─────────────────────────────────────────────────
// No manifest ⇒ no entries ⇒ `getLegalDocument` returns `null` ⇒ 404, which is
// correct and is the self-hoster's state: they have published no documents, so
// there is nothing here and nowhere to send anybody. Nothing renders an empty
// page, which is the failure this shape exists to avoid.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = getLegalDocument(slug);
  if (!doc) return {};
  // The canonical is the document's real home, so a crawler that reaches this
  // route indexes the published page rather than a redirect stub.
  return { title: doc.title, alternates: { canonical: doc.url } };
}

export default async function LegalDocumentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getLegalDocument(slug);

  // An unknown slug is a genuine 404, and it stays one: nothing in this tree
  // renders a `loading.tsx` above this call, so the status code survives.
  if (!doc) notFound();

  permanentRedirect(doc.url);
}
