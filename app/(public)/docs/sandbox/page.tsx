import { getTranslations } from 'next-intl/server';
import {
  SANDBOX_BASE_TAG,
  SANDBOX_IMAGE,
  SANDBOX_INTRO,
  SANDBOX_STEPS,
  SANDBOX_WHAT_NEXT,
  sandboxProfileRows,
  sandboxRunCommand,
} from '@/lib/apiDocs/sandbox';
import { CatalogueNav } from '../_components/CatalogueNav';
import { CodeBlock } from '../_components/CodeBlock';
import { DocBlock, DocBlocks } from '../_components/DocBlocks';

// GET /docs/sandbox — the agent sandbox setup guide (Story MOTIR-2268 ·
// Subtask MOTIR-2271 · design `design/agent-sandbox/`).
//
// ── It SETS THE CONTAINER UP, and ends there ────────────────────────────────
// The page is a PROCEDURE and is drawn as one: two sections of context, then
// numbered steps a reader works down, then a checked finish line. What runs
// INSIDE the container is the work loop — `motir auto` and friends — which
// behaves identically on a host and is documented with the CLI. Conflating the
// two produced two defects the design records: a `docker run` whose tail was an
// unattended work loop, and a reader who reasonably read `motir auto` as the
// thing that STARTS the sandbox.
//
// ── Two things are DERIVED, not written ─────────────────────────────────────
// The profile table and the `docker run` both come out of `AGENT_PROFILES` via
// `lib/apiDocs/sandbox.ts`. A profile added to the CLI appears here with no edit
// to this file — which is the property the whole story is buying, after this
// artifact shipped stale documentation twice (MOTIR-2010, MOTIR-2131).
//
// It mounts into 11.4.7's shell and reuses its catalogue rail unchanged.

/** The step's ordinal among the NUMBERED steps, which the intro sections skip. */
function StepHeading({ index, title }: { index: number; title: string }) {
  return (
    <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
      <span className="mr-2 font-mono text-(--el-text-faint)">{index}</span>
      {title}
    </h2>
  );
}

export default async function SandboxGuidePage() {
  const t = await getTranslations('apiDocs');
  const profiles = sandboxProfileRows();

  // ⚠️ This page passes NO operation groups, and does not build the spec to get
  // them (MOTIR-2312 / ADR Amendment 11 Q2). It is a guide about running a
  // container; the `/api/v1` operation index belongs to the API sub-area, and
  // the rail gates that index on the route prefix rather than on this call. It
  // used to build the reference here purely to hand it over, which is how ~28
  // REST operations came to frame a page that is not about them (MOTIR-2307).
  //
  // The rail still lists the API reference as a sibling SURFACE, so a reader
  // standing here is one click from it — that row is the access path the design
  // draws (`design/api-docs/` Panel 10, ①).

  // The worked example is the FIRST profile rather than a hardcoded `claude`:
  // the page must stay correct if the CLI's list is ever reordered or its head
  // removed, and this file is not allowed to know which profile is first.
  const example = profiles[0];

  return (
    <>
      <CatalogueNav current="sandbox" />

      <main className="min-w-0 flex-1 px-4 py-7 sm:px-9">
        <header className="mb-8">
          <h1 className="m-0 font-serif text-2xl font-semibold text-(--el-text)">
            {t('sandboxTitle')}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-[15px] leading-relaxed text-(--el-text-muted)">
            {t('sandboxLede')}
          </p>
        </header>

        {SANDBOX_INTRO.map((section) => (
          <section key={section.id} id={section.id} className="mb-10 scroll-mt-6">
            <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
              {section.title}
            </h2>
            <DocBlocks blocks={section.blocks} />
          </section>
        ))}

        {SANDBOX_STEPS.map((step, index) => (
          <section key={step.id} id={step.id} className="mb-10 scroll-mt-6">
            <StepHeading index={index + 1} title={step.title} />
            <DocBlocks blocks={step.blocks} />

            {step.rendersProfileTable ? (
              <>
                <DocBlock
                  block={{
                    kind: 'table',
                    columns: [
                      t('sandboxThProfile'),
                      t('sandboxThTier'),
                      t('sandboxThInstalled'),
                      t('sandboxThMount'),
                    ],
                    rows: profiles.map((profile) => [
                      `\`${profile.id}\` · \`${profile.binary}\``,
                      `Tier ${profile.tier}`,
                      profile.installSource,
                      // An empty mount says WHY rather than leaving a blank
                      // cell, which reads as an omission.
                      profile.mounts.length
                        ? profile.mounts.map((mount) => `\`${mount}\``).join(' · ')
                        : '—',
                    ]),
                  }}
                />
                <DocBlock
                  block={{
                    kind: 'callout',
                    tone: 'info',
                    text: `Using something else? \`${SANDBOX_IMAGE}:${SANDBOX_BASE_TAG}\` ships the sandbox with **no agent at all** — bring your own binary. Motir is agent-agnostic; the profiles make ${profiles.length} CLIs first-class, they do not make Motir depend on any of them.`,
                  }}
                />
              </>
            ) : null}

            {step.rendersRunCommand && example ? (
              <div className="mb-4">
                <CodeBlock
                  caption={t('sandboxRunCaption', { profile: example.id })}
                  code={sandboxRunCommand(example)}
                  copyable
                />
              </div>
            ) : null}
          </section>
        ))}

        <section id="what-next" className="mb-4 scroll-mt-6">
          <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
            {t('sandboxWhatNext')}
          </h2>
          <DocBlocks blocks={SANDBOX_WHAT_NEXT} />
        </section>

        <p className="mt-10 max-w-[68ch] border-t border-(--el-border-soft) pt-6 text-sm text-(--el-text-muted)">
          {t('guideNext')}{' '}
          <a className="text-(--el-link) underline" href="/docs/api">
            {t('navReference')}
          </a>
          {' · '}
          <a className="text-(--el-link) underline" href="/docs/api/getting-started">
            {t('navGettingStarted')}
          </a>
          {' · '}
          <a className="text-(--el-link) underline" href="/docs/api/stability">
            {t('navStability')}
          </a>
        </p>
      </main>
    </>
  );
}
