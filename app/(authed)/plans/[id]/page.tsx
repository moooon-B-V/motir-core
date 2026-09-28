import { memberReaderPageContext } from '@/lib/pages/projectPageContext';
import PlanDetailView from './_view';

// A plan's detail for a MEMBER — the body is `PlanDetailView`, handed the member's
// reader context (MOTIR-6643). A plan names its own project, so this page is not
// tied to the active one.
export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await memberReaderPageContext();
  // Called, not mounted: the view IS this page's body, so a caller of the page
  // (a test included) runs it exactly as it ran before the move.
  return PlanDetailView({ ctx, params });
}
