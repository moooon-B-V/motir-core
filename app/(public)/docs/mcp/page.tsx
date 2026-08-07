import { getTranslations } from 'next-intl/server';
import {
  MCP_FORK_STEER,
  MCP_REFERENCE_URL,
  mcpClients,
  mcpForkRows,
  mcpScopeLegend,
  mcpToolCount,
  mcpTransportFactRows,
} from '@/lib/apiDocs/mcp';
import { CatalogueNav } from '../_components/CatalogueNav';
import { CodeBlock } from '../_components/CodeBlock';
import { DocBlock, DocInline } from '../_components/DocBlocks';

// GET /docs/mcp — wiring an agent to the Motir MCP server (Story MOTIR-2309 ·
// Subtask MOTIR-2327 · design `design/mcp-server/` Panel 1 · ADR Amendment 13).
//
// ── This page is the SUB-AREA's index, and it is a PROCEDURE ────────────────
// Amendment 13 Q1 made the MCP a sub-area: this page is the wiring guide AND the
// index, and the tool catalogue is its own page at `/docs/mcp/tools`. So the
// rhythm here is the sandbox guide's — the fork a reader has to settle first,
// then numbered steps ending in a call that comes back — and the 39-row index
// lives one click away rather than below the fold of the thing you are following
// with your hands on a keyboard.
//
// ── Every FACT comes from `lib/apiDocs/mcp.ts` ──────────────────────────────
// This file contains no fact a reader learns something from: the endpoint, the
// header, the token shape and every client block are interpolated from the
// content module's single source (Amendment 13 Q3a), and the scope legend is
// derived from `TOOL_SCOPES`. What is here is layout and chrome, so this page
// can be wrong about arrangement and never about the MCP.
//
// ⚠️ It passes NO operation groups and does not build the spec to get them
// (Amendment 11 Q2). It is outside `/docs/api`, so the rail's prefix gate is what
// decides it renders no `/api/v1` index — not a prop this page could get wrong.

export default async function McpGuidePage() {
  const t = await getTranslations('apiDocs');
  const facts = mcpTransportFactRows();
  const clients = mcpClients();
  const legend = mcpScopeLegend();

  return (
    <>
      <CatalogueNav current="mcp" />

      <main className="min-w-0 flex-1 px-4 py-7 sm:px-9">
        <header className="mb-8">
          <h1 className="m-0 font-serif text-2xl font-semibold text-(--el-text)">
            {t('mcpTitle')}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-[15px] leading-relaxed text-(--el-text-muted)">
            {t('mcpLede')}
          </p>
        </header>

        {/* The reader's fork — the first thing, because it is the first choice. */}
        <section id="fork" className="mb-10 scroll-mt-6">
          <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
            {t('mcpForkHeading')}
          </h2>
          <DocBlock block={{ kind: 'prose', text: t('mcpForkIntro') }} />
          <DocBlock
            block={{
              kind: 'table',
              columns: ['', t('mcpThMcp'), t('mcpThRest')],
              rows: mcpForkRows().map((row) => [`**${row.axis}**`, row.mcp, row.rest]),
            }}
          />
          <DocBlock block={MCP_FORK_STEER} />
          {/* The other half, as a real link. The callout STATES the choice; a
              reader who has just made it needs somewhere to click. */}
          <p className="mb-3 max-w-[68ch] text-sm leading-relaxed text-(--el-text-secondary)">
            <a className="text-(--el-link) underline" href="/docs/api">
              {t('mcpForkApiLink')}
            </a>
          </p>
        </section>

        <section id="token" className="mb-10 scroll-mt-6">
          <StepHeading index={1} title={t('mcpStepToken')} />
          <DocBlock block={{ kind: 'prose', text: t('mcpStepTokenBody') }} />
        </section>

        <section id="wire" className="mb-10 scroll-mt-6">
          <StepHeading index={2} title={t('mcpStepWire')} />
          <DocBlock block={{ kind: 'prose', text: t('mcpStepWireBody') }} />
          <DocBlock
            block={{
              kind: 'table',
              columns: ['', ''],
              rows: facts.map((row) => [`**${row.label}**`, row.value]),
            }}
          />
          <DocBlock block={{ kind: 'callout', tone: 'info', text: t('mcpSecretCallout') }} />

          {clients.map((client) => (
            <div key={client.id} className="mb-5">
              <h3 className="mt-5 mb-1.5 font-sans text-[13px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                {client.label}
              </h3>
              <CodeBlock caption={client.file} code={client.config} copyable />
              <p className="mt-1.5 max-w-[68ch] text-[12px] leading-relaxed text-(--el-text-faint)">
                <DocInline text={client.note} /> ·{' '}
                <a
                  className="text-(--el-link) underline"
                  href={client.docsUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {client.label} {t('mcpClientDocs')}
                </a>{' '}
                · {t('mcpClientChecked', { date: client.checkedOn })}
              </p>
            </div>
          ))}
        </section>

        <section id="check" className="mb-10 scroll-mt-6">
          <StepHeading index={3} title={t('mcpStepCheck')} />
          <DocBlock block={{ kind: 'prose', text: t('mcpStepCheckBody') }} />
          <DocBlock block={{ kind: 'callout', tone: 'warning', text: t('mcpUnauthorized') }} />
        </section>

        {/* The scope legend — what a minted token can actually call, derived. */}
        <section id="scopes" className="mb-10 scroll-mt-6">
          <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
            {t('mcpScopeHeading')}
          </h2>
          <DocBlock
            block={{
              kind: 'table',
              columns: [t('mcpThScope'), t('mcpThGates'), ''],
              rows: legend.map((row) => [
                `\`${row.scope}\``,
                row.gates,
                row.grantedByDefault ? '' : `**${t('mcpScopeDefaultOff')}**`,
              ]),
            }}
          />
        </section>

        <section id="what-next" className="mb-10 scroll-mt-6">
          <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
            {t('mcpWhatNext')}
          </h2>
          <p className="mb-3 max-w-[68ch] text-sm leading-relaxed text-(--el-text-secondary)">
            <a className="text-(--el-link) underline" href="/docs/mcp/tools">
              {t('mcpToolsTitle')}
            </a>{' '}
            — <DocInline text={t('mcpWhatNextBody', { count: mcpToolCount() })} />{' '}
            <a
              className="text-(--el-link) underline"
              href={MCP_REFERENCE_URL}
              rel="noreferrer noopener"
              target="_blank"
            >
              {t('mcpReadReference')}
            </a>
          </p>
        </section>
      </main>
    </>
  );
}

/** The step's ordinal — the shipped sandbox guide's treatment, reused. */
function StepHeading({ index, title }: { index: number; title: string }) {
  return (
    <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
      <span className="mr-2 font-mono text-(--el-text-faint)">{index}</span>
      {title}
    </h2>
  );
}
