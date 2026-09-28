import ItemView from '@/app/(authed)/items/[key]/_view';
import { renderVisitorView } from '../../_render';

/**
 * `/p/<identifier>/items/<key>` — one work item, read by a Visitor (MOTIR-6648).
 * A private epic's descendant, a key of another project and a missing key are
 * the same not-found (the detail read refuses them alike, MOTIR-6652).
 */
export default async function VisitorItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string; key: string }>;
  searchParams: Promise<{ activity?: string }>;
}) {
  return renderVisitorView(params, (ctx) =>
    ItemView({ ctx, params: params.then(({ key }) => ({ key })), searchParams }),
  );
}
