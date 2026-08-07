import { getTranslations } from 'next-intl/server';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { MCP_REFERENCE_URL, mcpCatalogue, mcpToolCount } from '@/lib/apiDocs/mcp';
import { CatalogueNav } from '../../_components/CatalogueNav';
import { DocBlock } from '../../_components/DocBlocks';

// GET /docs/mcp/tools — the MCP tool catalogue (Story MOTIR-2309 · Subtask
// MOTIR-2327 · design `design/mcp-server/` Panel 2 · ADR Amendment 13 Q1).
//
// ── This page is the SUB-AREA's resource index ──────────────────────────────
// The same thing `/docs/api` is for the REST API, at the same order of size: 39
// tools against 38 operations. That is why it is a page and not a section of the
// wiring guide (Amendment 13 Q1), and why it is the MCP sub-area's second-tier
// row in the rail.
//
// ── Grouped by SCOPE, and the grouping is DERIVED ───────────────────────────
// A tool's group is its own `TOOL_SCOPES` entry (Amendment 13 Q2), so no
// per-tool grouping fact is authored and a new tool lands in a group the moment
// it has a scope. It is also the axis the reader is on: the wiring page just
// explained that a token carries scopes and that a call is refused without the
// right one, so a catalogue on that axis answers "what do I lose if I leave this
// one off?" by construction.
//
// The page holds NO tool fact of its own — every row comes from
// `lib/apiDocs/mcp.ts`, and the count below is the length of what was derived
// rather than a literal that could disagree with the list under it.

export default async function McpToolsPage() {
  const t = await getTranslations('apiDocs');
  const groups = mcpCatalogue();
  const total = mcpToolCount();

  return (
    <>
      <CatalogueNav current="mcpTools" />

      <main className="min-w-0 flex-1 px-4 py-7 sm:px-9">
        <header className="mb-6">
          <h1 className="m-0 font-serif text-2xl font-semibold text-(--el-text)">
            {t('mcpToolsTitle')}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-[15px] leading-relaxed text-(--el-text-muted)">
            {t('mcpToolsLede')}
          </p>
          {total > 0 && (
            <p className="mt-2 font-mono text-[12px] text-(--el-text-faint)">
              {t('mcpToolsMeta', { tools: total, scopes: TOKEN_SCOPES.length })}
            </p>
          )}
        </header>

        {total === 0 ? (
          // The state a DERIVED page owes: say the list could not be built rather
          // than render a heading over a bare column (design Panel 5).
          <div
            className="flex flex-col items-center gap-3 px-6 py-16 text-center"
            data-testid="mcp-tools-empty"
          >
            <h2 className="m-0 font-serif text-xl text-(--el-text)">{t('mcpToolsEmptyTitle')}</h2>
            <p className="m-0 max-w-[60ch] text-sm leading-relaxed text-(--el-text-secondary)">
              {t('mcpToolsEmptyBody')}
            </p>
            <p className="m-0 text-sm">
              <a className="text-(--el-link) underline" href="/docs/mcp">
                {t('mcpBackToWiring')}
              </a>{' '}
              ·{' '}
              <a
                className="text-(--el-link) underline"
                href={MCP_REFERENCE_URL}
                rel="noreferrer noopener"
                target="_blank"
              >
                {t('mcpReadReference')}
              </a>
            </p>
          </div>
        ) : (
          <>
            <DocBlock block={{ kind: 'callout', tone: 'info', text: t('mcpToolsSummaryNote') }} />

            {groups.map((group) => (
              <section
                key={group.scope}
                id={group.scope.replace(':', '-')}
                className="mb-8 scroll-mt-6"
                data-testid={`mcp-group-${group.scope}`}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h2 className="m-0 font-sans text-sm font-semibold tracking-wide text-(--el-text) uppercase">
                    {group.label}
                  </h2>
                  <span
                    className={
                      group.grantedByDefault
                        ? 'rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-[11px] text-(--el-text-strong)'
                        : 'rounded-(--radius-badge) bg-(--el-tint-peach) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-[11px] text-(--el-text-strong)'
                    }
                  >
                    {group.scope}
                  </span>
                  {!group.grantedByDefault && (
                    <span className="text-[11.5px] text-(--el-text-faint)">
                      {t('mcpScopeDefaultOff')}
                    </span>
                  )}
                </div>
                <DocBlock
                  block={{
                    kind: 'table',
                    columns: [t('mcpThTool'), t('mcpThDoes')],
                    rows: group.tools.map((tool) => [`\`${tool.name}\``, tool.summary]),
                  }}
                />
              </section>
            ))}
          </>
        )}
      </main>
    </>
  );
}
