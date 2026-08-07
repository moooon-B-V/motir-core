import { getTranslations } from 'next-intl/server';
import {
  CLI_FILES,
  CLI_INTRO,
  CLI_STEPS,
  CLI_WHAT_NEXT,
  cliCommandGroups,
} from '@/lib/apiDocs/cli';
import { CatalogueNav } from '../_components/CatalogueNav';
import { DocBlock, DocBlocks } from '../_components/DocBlocks';

// GET /docs/cli — the Motir CLI guide (Story MOTIR-2308 · Subtask MOTIR-2329 ·
// design `design/cli-guide/`).
//
// ── It is a PROCEDURE, and it stops at the first dispatched item ────────────
// A lede, one precondition line, six numbered steps a reader works straight
// down, where the two files live, the derived command table, and a finish line
// that hands off. `docs/cli.md` stays the 1,147-line reference — ADR
// `public-api-conventions.md` Amendment 9 Q2 draws the boundary and Amendment 12
// Q3 applies it fact by fact.
//
// ── ONE page, and NO second-tier rail ──────────────────────────────────────
// Amendment 12 Q1. The CLI surface has one page, so it is one row in the rail's
// surface tier and gets no sub-area tier — a second tier lists a surface's
// PAGES, and listing this page's headings there would make the rail mean two
// different things. `CatalogueNav` gates tier 2 on the `/docs/api` route prefix
// (Amendment 11 Q2), so this page acquires neither that tier nor the operation
// index by simply existing, which is the property that gate was built for.
//
// ── The table is DERIVED, and this page does not know what is in it ────────
// Every row comes out of `packages/cli/src/commandCatalog.ts` through
// `lib/apiDocs/cli.ts`. A command added to the CLI appears here with no edit to
// any file this card created.
//
// It mounts into 11.4.7's shell and reuses its catalogue rail unchanged.

/** The step's ordinal among the NUMBERED steps, which the intro section skips. */
function StepHeading({ index, title }: { index: number; title: string }) {
  return (
    <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
      <span className="mr-2 font-mono text-(--el-text-faint)">{index}</span>
      {title}
    </h2>
  );
}

export default async function CliGuidePage() {
  const t = await getTranslations('apiDocs');
  const groups = cliCommandGroups();

  // ⚠️ This page passes NO operation groups and does not build the spec to get
  // them — the same reason the sandbox guide does not (Amendment 11 Q2). It is a
  // guide about a terminal tool; the `/api/v1` operation index belongs to the API
  // sub-area, and the rail gates that index on the route prefix.

  return (
    <>
      <CatalogueNav current="cli" />

      <main className="min-w-0 flex-1 px-4 py-7 sm:px-9">
        <header className="mb-8">
          <h1 className="m-0 font-serif text-2xl font-semibold text-(--el-text)">
            {t('cliTitle')}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-[15px] leading-relaxed text-(--el-text-muted)">
            {t('cliLede')}
          </p>
        </header>

        {CLI_INTRO.map((section) => (
          <section key={section.id} id={section.id} className="mb-10 scroll-mt-6">
            <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
              {section.title}
            </h2>
            <DocBlocks blocks={section.blocks} />
          </section>
        ))}

        {CLI_STEPS.map((step, index) => (
          <section key={step.id} id={step.id} className="mb-10 scroll-mt-6">
            <StepHeading index={index + 1} title={step.title} />
            <DocBlocks blocks={step.blocks} />
          </section>
        ))}

        <section id="files" className="mb-10 scroll-mt-6">
          <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
            {t('cliFilesHeading')}
          </h2>
          <DocBlocks blocks={CLI_FILES} />
        </section>

        <section id="every-command" className="mb-10 scroll-mt-6">
          <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
            {t('cliCommandsHeading')}
          </h2>
          <DocBlock block={{ kind: 'prose', text: t('cliCommandsLede') }} />
          {/* FOUR tables, one per help group — the shape `motir help` itself
              prints. The first column is pinned so they align down the page
              (design § "The command table"). */}
          {groups.map((group) => (
            <DocBlock
              key={group.group}
              block={{
                kind: 'table',
                caption: group.caption,
                columns: [t('cliThCommand'), t('cliThDoes')],
                columnWidths: ['w-[34%]', null],
                rows: group.rows.map((row) => [`\`${row.invocation}\``, row.description]),
              }}
            />
          ))}
        </section>

        <section id="what-next" className="mb-4 scroll-mt-6">
          <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
            {t('cliWhatNext')}
          </h2>
          <DocBlocks blocks={CLI_WHAT_NEXT} />
        </section>

        <p className="mt-10 max-w-[68ch] border-t border-(--el-border-soft) pt-6 text-sm text-(--el-text-muted)">
          {t('guideNext')}{' '}
          <a className="text-(--el-link) underline" href="/docs/sandbox">
            {t('navSandbox')}
          </a>
          {' · '}
          <a className="text-(--el-link) underline" href="/docs/api">
            {t('navReference')}
          </a>
          {' · '}
          <a className="text-(--el-link) underline" href="/docs/api/getting-started">
            {t('navGettingStarted')}
          </a>
        </p>
      </main>
    </>
  );
}
