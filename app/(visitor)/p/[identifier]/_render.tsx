import type { ReactNode } from 'react';
import type { ProjectPageContext } from '@/lib/pages/projectPageContext';
import { visitorPage } from '@/lib/visitor/pageGate';
import { VisitorRateLimited } from './_components/VisitorRateLimited';

// Every Visitor page is this, around its view (Story MOTIR-6170 · MOTIR-6648):
// the gate (`visitorPage` — the verdict in its order, then the reader's read
// budget), then the SHARED page body (MOTIR-6643's `_view.tsx`) handed a context
// whose reader is the Visitor's. Past the budget the body is replaced by the
// rate-limited state, inside the chrome (design MOTIR-6641 panel 9b).

export async function renderVisitorView(
  params: Promise<{ identifier: string }>,
  view: (ctx: ProjectPageContext) => Promise<ReactNode>,
): Promise<ReactNode> {
  const { identifier } = await params;
  const gate = await visitorPage(decodeURIComponent(identifier));
  if (gate.kind === 'limited') {
    return <VisitorRateLimited retryAfterSeconds={gate.retryAfterSeconds} />;
  }
  return view(gate.ctx);
}
