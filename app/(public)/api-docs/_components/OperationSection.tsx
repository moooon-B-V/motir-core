import { getTranslations } from 'next-intl/server';
import type { ReferenceOperation } from '@/lib/apiDocs/reference';
import { CodeBlock } from './CodeBlock';
import { MethodPill, ScopePill, StatusPill } from './MethodPill';

// One operation, as the reference renders it (Story 11.4 · Subtask 11.4.7 —
// MOTIR-2188; design Panels 1–2).
//
// ⚠️ THE SECTION ORDER IS FIXED — scope → request → body → example → responses.
// The design says so and the reason is the whole point of a reference: a reader
// who has read one operation must be able to SKIM the next, which only works if
// the next one is laid out identically.
//
// ── English, deliberately ───────────────────────────────────────────────────
// The operation's own text — summary, description, parameter descriptions,
// status conditions — comes from the SPEC and stays English (ADR Amendment 4
// Q4): the spec is one document, and a translated contract is a second one that
// can disagree with the first. Only the section HEADINGS around it are
// localized, and those come from the catalog.

export async function OperationSection({ operation }: { operation: ReferenceOperation }) {
  const t = await getTranslations('apiDocs');

  return (
    <section
      id={operation.id}
      data-operation-id={operation.id}
      // `scroll-mt` so an in-page jump does not land the heading under the
      // sticky chrome — the anchor is the catalogue's only navigation.
      className="min-w-0 scroll-mt-6 border-b border-(--el-border-soft) pt-8 pb-10 last:border-b-0"
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        <MethodPill method={operation.method} />
        <span className="font-mono text-[15px] font-semibold break-all text-(--el-text)">
          {operation.path}
        </span>
        <ScopePill scope={operation.scope} />
      </div>

      <h2 className="mb-1 font-sans text-base font-semibold text-(--el-text)">
        {operation.summary}
      </h2>
      <p className="mb-5 max-w-[68ch] text-sm leading-relaxed text-(--el-text-muted)">
        {operation.description}
      </p>

      {operation.parameters.length > 0 && (
        <>
          <h3 className="mt-5 mb-1.5 text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase">
            {t('sectionRequest')}
          </h3>
          {/* The table scrolls in its own container for the same reason the code
              blocks do — three columns of prose do not fit a phone. */}
          <div className="mb-4 min-w-0 overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="border-b border-(--el-border) px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
                    {t('thParameter')}
                  </th>
                  <th className="border-b border-(--el-border) px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
                    {t('thIn')}
                  </th>
                  <th className="border-b border-(--el-border) px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
                    {t('thDescription')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {operation.parameters.map((parameter) => (
                  <tr key={`${parameter.location}:${parameter.name}`}>
                    <td className="border-b border-(--el-border-soft) px-2.5 py-2 align-top">
                      <span className="font-mono text-xs text-(--el-text)">{parameter.name}</span>
                      <br />
                      <span className="font-mono text-[11.5px] text-(--el-text-faint)">
                        {parameter.type}
                        {parameter.required ? ` · ${t('required')}` : ` · ${t('optional')}`}
                      </span>
                    </td>
                    <td className="border-b border-(--el-border-soft) px-2.5 py-2 align-top font-mono text-[11.5px] text-(--el-text-secondary)">
                      {parameter.location}
                    </td>
                    <td className="border-b border-(--el-border-soft) px-2.5 py-2 align-top text-(--el-text-secondary)">
                      {parameter.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {operation.requestBody && (
        <>
          <h3 className="mt-5 mb-1.5 text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase">
            {t('sectionBody')}
          </h3>
          <div className="mb-4">
            <CodeBlock caption="application/json" code={operation.requestBody} />
          </div>
        </>
      )}

      <h3 className="mt-5 mb-1.5 text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase">
        {t('sectionExample')}
      </h3>
      <div className="mb-4">
        <CodeBlock caption="curl" code={operation.example} copyable />
      </div>

      <h3 className="mt-5 mb-1.5 text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase">
        {t('sectionResponses')}
      </h3>
      <div className="mb-4 min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="border-b border-(--el-border) px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
                {t('thStatus')}
              </th>
              <th className="border-b border-(--el-border) px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
                {t('thCondition')}
              </th>
            </tr>
          </thead>
          <tbody>
            {operation.responses.map((response) => (
              <tr key={response.status}>
                <td className="border-b border-(--el-border-soft) px-2.5 py-2 align-top">
                  <StatusPill status={response.status} />
                </td>
                <td className="border-b border-(--el-border-soft) px-2.5 py-2 align-top text-(--el-text-secondary)">
                  {response.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {operation.responseBody && (
        <>
          <h3 className="mt-5 mb-1.5 text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase">
            {operation.envelope === 'rankedPage'
              ? t('sectionRowSchemaRanked')
              : operation.envelope === 'page'
                ? t('sectionRowSchema')
                : t('sectionResponseSchema')}
          </h3>
          <CodeBlock
            caption={operation.envelope ? 'items[] · application/json' : 'application/json'}
            code={operation.responseBody}
          />
        </>
      )}
    </section>
  );
}
