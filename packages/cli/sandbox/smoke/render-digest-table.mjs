#!/usr/bin/env node
//
// THE RELEASE WRITES ITS OWN DIGEST TABLE (MOTIR-2699)
//
// `sandbox-images.yml` has always resolved every published digest, formatted it
// into exactly the markdown `packages/cli/sandbox/README.md` § Published images
// wants, and written it to `$GITHUB_STEP_SUMMARY` — a page a human opens, reads,
// and retypes into a file. Four releases in, that last four inches had been
// crossed by hand every time and had lapsed once (`cli-v0.3.0`, PR #2043), which
// is a handoff problem rather than a carelessness problem: nothing in the lane
// could reach the repository, so the only mechanism available was a person.
//
// This script is that mechanism. It resolves the digests, checks the two things
// the section CLAIMS, renders the section, and edits the file.
//
// ── Where the digests come from, and why it matters ────────────────────────
//
// From the REGISTRY, over an anonymous pull — never from the values the push
// step carried forward. `assert-public.mjs`'s `probeAnonymousPull` does the
// resolving, so this script inherits its two hard-won properties: it sends no
// `Authorization` header of its own (the answer a stranger gets, which is the
// answer the README promises), and it probes a known-public control FIRST, so a
// broken probe reports "could not tell" instead of writing nine wrong rows.
// MOTIR-2220 is on record that the run's job summary is not the authority here;
// automating the transcription off the summary would have preserved the bug and
// removed the human who might have noticed it.
//
// ── The two invariants stay CHECKED, not asserted in prose ─────────────────
//
// The section makes two claims, both verified by hand until now:
//
//   1. each moving `:<profile>` resolves to the same manifest as its
//      `:<profile>-<version>` twin — otherwise the moving tag a reader copies
//      and the digest they pin are different bytes;
//   2. every digest differs from the previous release's row — an unchanged
//      digest across a version bump means a variant did not actually rebuild.
//
// Both are FATAL here. Automating the table without automating its checks would
// replace a slow honest process with a fast one that cannot fail, and a section
// whose invariants are prose nobody re-derives is worse than no section.
//
// A third check runs whenever the lane hands over `--digests`: the digest the
// PUSH recorded must equal the one the registry now serves. That is the arm that
// makes a wrong digest fail the lane rather than get written.
//
// ── Exit codes ─────────────────────────────────────────────────────────────
//
//   0  the README is up to date — either it was just updated, or (a re-run, a
//      no-op release) there was nothing to change and NOTHING WAS WRITTEN
//   1  a DEFINITE failure: an invariant is violated, a recorded digest
//      disagrees with the registry, or the file cannot be edited safely
//   2  could not tell — the registry, or the control, did not answer. Never a
//      statement about the images, and never a reason to write a file.
//
// The same three-valued split `assert-public.mjs` makes, for the same reason.
//
// Usage:
//   render-digest-table.mjs --image <registry/repo> --version <x.y.z> \
//     [--names a,b,c | --profiles <profiles.json>] [--digests <dir>] \
//     [--readme <path>] [--run-url <url>] [--write]
//
// Without `--write` it PRINTS the section it would insert and touches nothing —
// which is how a human inspects a release, and how the dry-run lane behaves.

import { CONTROL_REFERENCE, parseReference, probeAnonymousPull } from './assert-public.mjs';

/** The heading every release section carries, and the anchor the file links to. */
const RELEASE_HEADING = (version) => `### Release \`cli-v${version}\``;

/**
 * The machine-readable frame around one release section.
 *
 * The file was hand-maintained for four releases, so the sections are prose
 * first — and prose is exactly what a demotion cannot key on. (The outgoing
 * section's "this is the current release" clause has to become "it **was** the
 * current release until …", which is a sentence rewrite, not an append.) These
 * comments make that edit a bounded replacement rather than a regex over
 * English: the section boundary, and the one paragraph whose tense changes.
 *
 * They are HTML comments, so they render as nothing on GitHub and on
 * `motir.co/docs` alike, and Prettier leaves them verbatim.
 */
const MARKERS = {
  release: (version) => `<!-- sandbox-digests:release cli-v${version} -->`,
  releasePattern: /^<!-- sandbox-digests:release cli-v(\d+\.\d+\.\d+) -->$/,
  currencyStart: '<!-- sandbox-digests:currency start -->',
  currencyEnd: '<!-- sandbox-digests:currency end -->',
};

// ── Resolving the digests ───────────────────────────────────────────────────

/**
 * Resolve one name's moving tag and its immutable twin, anonymously.
 *
 * Both, always — the twin invariant is not checkable from one of them, and the
 * moving tag is the reference the table's Tag column names, so it is the one
 * whose bytes the row is a promise about.
 */
async function resolvePair(image, name, version, options) {
  const moving = `${image}:${name}`;
  const twin = `${image}:${name}-${version}`;
  return {
    name,
    moving: { reference: moving, verdict: await probeAnonymousPull(moving, options) },
    twin: { reference: twin, verdict: await probeAnonymousPull(twin, options) },
  };
}

/**
 * The digest rows for a release, or the reason there are none.
 *
 * The control runs first and its failure short-circuits the whole thing: a probe
 * that has quietly broken resolves nothing, and "nothing resolved" would
 * otherwise be indistinguishable from a release that published nothing. Same
 * discipline as `assertPublic`, and it must stay first — every check below is
 * only as good as the probe's answers.
 */
export async function resolveDigestRows(image, names, version, options = {}) {
  const control = options.control ?? CONTROL_REFERENCE;
  const controlVerdict = await probeAnonymousPull(control, options);
  if (controlVerdict.pullable !== true) {
    return {
      exitCode: 2,
      rows: [],
      problems: [],
      summary:
        `the positive control ${control} did not resolve anonymously ` +
        `(${controlVerdict.reason ?? 'no reason'}) — this run proves NOTHING about the ` +
        `published digests, and nothing has been written`,
    };
  }

  const rows = [];
  const problems = [];
  let unknown = 0;

  for (const name of names) {
    const pair = await resolvePair(image, name, version, options);
    const movingDigest = pair.moving.verdict.digest ?? null;
    const twinDigest = pair.twin.verdict.digest ?? null;

    if (pair.moving.verdict.pullable !== true || pair.twin.verdict.pullable !== true) {
      const failed = pair.moving.verdict.pullable !== true ? pair.moving : pair.twin;
      // `pullable: false` is a real refusal (private, or the tag is not there);
      // `null` is the probe saying it could not tell. They are different exit
      // codes, because the second one must never be reported as a fact.
      if (failed.verdict.pullable === null) unknown += 1;
      problems.push(
        `${failed.reference} did not resolve anonymously ` +
          `(${failed.verdict.reason ?? 'no reason'}${
            failed.verdict.detail ? `: ${failed.verdict.detail}` : ''
          })`,
      );
      continue;
    }

    // INVARIANT 1 — the moving tag and its immutable twin are the same bytes.
    if (movingDigest !== twinDigest) {
      problems.push(
        `${image}:${name} resolves to ${movingDigest} but its immutable twin ` +
          `${image}:${name}-${version} resolves to ${twinDigest} — the moving tag a reader ` +
          `copies and the digest they pin are DIFFERENT bytes`,
      );
      continue;
    }

    rows.push({ name, tag: `${image}:${name}`, digest: movingDigest });
  }

  if (problems.length > 0) {
    return {
      // A refusal is a fact about the release (1); a probe that could not tell
      // is not (2). If any name is merely unknown, the whole run is unknown —
      // writing a table with a row missing would silently publish a short one.
      exitCode: unknown > 0 ? 2 : 1,
      rows,
      problems,
      summary: `${problems.length} of ${names.length} published names could not be recorded`,
    };
  }

  return {
    exitCode: 0,
    rows,
    problems,
    summary: `all ${rows.length} published tags resolved anonymously, each matching its immutable twin`,
  };
}

/**
 * INVARIANT 2 — every digest differs from the previous release's row.
 *
 * Vacuous for the first release ever recorded, and said so rather than passed
 * silently: "0 of 0 differ" is the shape that makes an empty check look green.
 */
export function checkNovelty(rows, previous) {
  if (!previous) return { checked: false, problems: [] };
  const problems = [];
  for (const row of rows) {
    const before = previous.rows.find((r) => r.name === row.name);
    if (before && before.digest === row.digest) {
      problems.push(
        `${row.tag} still resolves to ${row.digest}, the same manifest as its ` +
          `cli-v${previous.version} row — a variant did not rebuild for this release`,
      );
    }
  }
  return { checked: true, problems, against: previous.version };
}

/**
 * INVARIANT 3 — what the push RECORDED matches what the registry now serves.
 *
 * The arm that makes a wrong digest fail rather than get written. The push
 * step's value and the registry's answer are two independent readings of the
 * same fact, and the README's whole contract is that the second one is what
 * lands.
 */
export function checkRecorded(rows, recorded) {
  if (!recorded) return { checked: false, problems: [] };
  const problems = [];
  for (const row of rows) {
    const pushed = recorded[row.name];
    if (pushed === undefined) {
      problems.push(
        `no digest was recorded for '${row.name}' by the push jobs — the release is incomplete`,
      );
      continue;
    }
    if (pushed !== row.digest) {
      problems.push(
        `the push recorded ${pushed} for '${row.name}' but the registry serves ${row.digest} ` +
          `to an anonymous pull — one of the two is wrong, so NEITHER is written`,
      );
    }
  }
  for (const name of Object.keys(recorded)) {
    if (!rows.some((row) => row.name === name)) {
      problems.push(`the push recorded a digest for '${name}', which this run did not resolve`);
    }
  }
  return { checked: true, problems };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * A GitHub-flavoured table, padded the way Prettier pads one.
 *
 * The README is formatted by `prettier --check .` in CI, and markdown tables are
 * one of the few things Prettier rewrites structurally: every cell in a column
 * is padded to the column's widest, and the separator row is that same width in
 * dashes. Emitting it already-aligned is what keeps the generated section from
 * failing the format gate on a file no human touched.
 */
export function renderTable(rows) {
  const header = ['Tag', 'Digest'];
  const cells = rows.map((row) => [`\`${row.tag}\``, `\`${row.digest}\``]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((row) => row[column].length)),
  );
  const line = (values) =>
    `| ${values.map((value, column) => value.padEnd(widths[column])).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...cells.map(line),
  ].join('\n');
}

/** The paragraph whose TENSE changes when the next release supersedes this one. */
function renderCurrency(version, supersededBy) {
  return supersededBy
    ? [
        `Each row's immutable twin — \`:<profile>-${version}\` — points at the same manifest. It`,
        `**was** the current release until \`cli-v${supersededBy}\`; the moving \`:<profile>\` tags`,
        `have since moved on and no longer point here, which is exactly what a moving tag is for`,
        'and why the immutable twin exists.',
      ].join('\n')
    : [
        `Each row's immutable twin — \`:<profile>-${version}\` — points at the same manifest, and`,
        'the moving `:<profile>` tags point here too: this is the current release.',
      ].join('\n');
}

/**
 * The whole section for one release.
 *
 * Deliberately NOT editorial. A human writing this section says what the release
 * *is* ("the release whose 403 hint names a permission rather than a scope"), and
 * no lane can write that sentence. What a lane can write is every fact the table
 * rests on — the version, the run that produced it, where the digests were read
 * from, and the two invariants with their counts — so that is what it writes, and
 * a later commit is free to add the sentence above it.
 */
export function renderSection({ image, version, runUrl, rows, novelty }) {
  const parsed = parseReference(`${image}:base`);
  const registry = parsed?.registry ?? 'ghcr.io';
  const repository = parsed?.repository ?? image;
  const exampleTag = `${rows.find((row) => row.name !== 'base')?.name ?? 'base'}-${version}`;
  const count = `${rows.length} of ${rows.length}`;

  // Wrapped at the ~80 columns the rest of the file uses. Prettier does not
  // reflow prose (`proseWrap` is left at its default), so these line breaks are
  // the ones that ship — a paragraph emitted as one long line would pass the
  // format gate and still read as machine-written beside its neighbours.
  const invariants = [
    'Two things CHECKED rather than assumed, by the release lane that wrote this',
    'section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**',
    `manifest as its \`:<profile>-${version}\` twin (${count}), and`,
    ...(novelty.checked
      ? [
          `**every digest below differs from its \`cli-v${novelty.against}\` row** (${count}) — an`,
          'unchanged digest across a version bump would mean a variant did not',
          'actually rebuild, which is a finding, not a formatting detail.',
        ]
      : [
          'the novelty invariant is vacuous here rather than passed: there is no',
          'earlier release to compare these digests against.',
        ]),
  ].join('\n');

  return [
    MARKERS.release(version),
    '',
    RELEASE_HEADING(version),
    '',
    `([run ${runUrl.split('/').pop()}](${runUrl})).`,
    'The `motir` inside each image is',
    `[\`@motir/cli@${version}\`](https://www.npmjs.com/package/@motir/cli/v/${version}), the same`,
    'build npm serves.',
    '',
    MARKERS.currencyStart,
    '',
    renderCurrency(version, null),
    '',
    MARKERS.currencyEnd,
    '',
    "**Read from the registry, not from the run's job summary** (MOTIR-2220). Every",
    'digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched',
    'with a token minted from the anonymous endpoint — no `Authorization` on the token',
    "request, so it is the answer a stranger gets, not the publisher's:",
    '',
    '```sh',
    `TOKEN=$(curl -s "https://${registry}/token?scope=repository:${repository}:pull&service=${registry}" | jq -r .token)`,
    'curl -sI -H "Authorization: Bearer $TOKEN" \\',
    "  -H 'Accept: application/vnd.oci.image.index.v1+json' \\",
    `  https://${registry}/v2/${repository}/manifests/${exampleTag} | grep -i docker-content-digest`,
    '```',
    '',
    invariants,
    '',
    renderTable(rows),
    '',
  ].join('\n');
}

// ── Editing the file ────────────────────────────────────────────────────────

/**
 * Every release section already in the file, newest first — the marked ones with
 * their frame, and the older hand-written ones by their heading alone.
 *
 * The unmarked ones are read but never edited: the file's own rule is that a
 * past release's rows are never touched, and only the OUTGOING section needs the
 * frame (its tense changes exactly once, when the next release lands).
 */
export function parseSections(readme) {
  const lines = readme.split('\n');
  const starts = [];
  lines.forEach((line, at) => {
    const marked = MARKERS.releasePattern.exec(line);
    if (marked) {
      starts.push({ at, version: marked[1], marked: true });
      return;
    }
    const heading = /^### Release `cli-v(\d+\.\d+\.\d+)`$/.exec(line);
    if (!heading) return;
    // A marked section's own heading sits just below its marker — the same
    // section, not a second one.
    const previous = starts[starts.length - 1];
    if (previous?.marked && previous.version === heading[1]) return;
    starts.push({ at, version: heading[1], marked: false });
  });

  return starts.map((start, index) => {
    const next = starts[index + 1]?.at ?? lines.length;
    // A section also ends at the next heading of ANY kind: § Published images is
    // followed by further `###` subsections that are not releases, and a table
    // that swallowed one of them would be edited by every insert from then on.
    let end = next;
    for (let j = start.at + 1; j < next; j += 1) {
      const line = lines[j] ?? '';
      if (line === RELEASE_HEADING(start.version)) continue;
      if (/^#{2,3} /.test(line)) {
        end = j;
        break;
      }
    }
    return { version: start.version, start: start.at, end, marked: start.marked };
  });
}

/** The digest rows recorded in one section's table. */
export function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\|\s*`(\S+?):([\w.-]+)`\s*\|\s*`(sha256:[0-9a-f]{64})`\s*\|$/.exec(line.trim());
    if (match) rows.push({ name: match[2], tag: `${match[1]}:${match[2]}`, digest: match[3] });
  }
  return rows;
}

/**
 * Rewrite the outgoing section's currency paragraph into its historical tense.
 *
 * Bounded to the marked paragraph on purpose. The alternative — matching the
 * sentence in English — is how a formatter reflow or a copy-edit turns a
 * demotion into a silent no-op, and a section that still calls itself current is
 * the exact defect this whole lane exists to remove.
 */
export function demoteSection(sectionText, version, supersededBy) {
  const start = sectionText.indexOf(MARKERS.currencyStart);
  const end = sectionText.indexOf(MARKERS.currencyEnd);
  if (start === -1 || end === -1 || end < start) return null;
  return (
    sectionText.slice(0, start + MARKERS.currencyStart.length) +
    `\n\n${renderCurrency(version, supersededBy)}\n\n` +
    sectionText.slice(end)
  );
}

/**
 * Put the section in the file: replace the one for this version if it is already
 * there (a re-run, or a moved tag — which republishes the images, so the digests
 * really can change), otherwise insert it at the top of the release list and
 * demote the section it displaces.
 *
 * Returns `changed: false` when the result is byte-identical to what is already
 * on disk. That is the whole of criterion 5: a no-op release must not leave an
 * empty pull request behind, and the cheapest way to guarantee that is for the
 * writer to know it changed nothing.
 */
export function updateReadme(readme, { version, section }) {
  const lines = readme.split('\n');
  const sections = parseSections(readme);
  const existing = sections.find((s) => s.version === version);
  const sectionLines = section.replace(/\n$/, '').split('\n');

  let next;
  let action;
  if (existing) {
    next = [...lines.slice(0, existing.start), ...sectionLines, '', ...lines.slice(existing.end)];
    action = 'replaced';
  } else {
    const displaced = sections[0];
    if (!displaced) {
      return {
        error:
          'the README has no `### Release `cli-v…`` section to insert above — § Published ' +
          'images has changed shape, so this lane refuses to guess where the table goes',
      };
    }
    if (!displaced.marked) {
      return {
        error:
          `the newest release section (cli-v${displaced.version}) carries no ` +
          `\`${MARKERS.currencyStart}\` frame, so its "this is the current release" paragraph ` +
          'cannot be demoted without rewriting prose. FIX: add the currency markers around ' +
          "that section's immutable-twin paragraph, as MOTIR-2699 did for cli-v0.3.0.",
      };
    }
    const displacedText = lines.slice(displaced.start, displaced.end).join('\n');
    const demoted = demoteSection(displacedText, displaced.version, version);
    if (demoted === null) {
      // The frame is half there — one marker without its partner. Same fix as a
      // missing frame, and the same refusal to guess at the sentence instead.
      return {
        error:
          `the cli-v${displaced.version} section's currency frame is incomplete, so its ` +
          '"this is the current release" paragraph cannot be demoted without rewriting ' +
          `prose. FIX: add the currency markers (\`${MARKERS.currencyStart}\` … ` +
          `\`${MARKERS.currencyEnd}\`) around that section's immutable-twin paragraph, as ` +
          'MOTIR-2699 did for cli-v0.3.0.',
      };
    }
    next = [
      ...lines.slice(0, displaced.start),
      ...sectionLines,
      '',
      ...demoted.split('\n'),
      ...lines.slice(displaced.end),
    ];
    action = 'inserted';
  }

  const content = next.join('\n');
  return { content, changed: content !== readme, action, displaced: sections[0]?.version ?? null };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

/**
 * The published names, in the order the table lists them: the agent-less base
 * first, then every profile in `profiles.json` order.
 *
 * Read from the profile table rather than restated, exactly as the workflow
 * matrix is — adding an agent extends the table on its own, and there is no
 * second list to drift.
 */
export async function resolveNames(argv, io) {
  const explicit = argOf(argv, 'names');
  if (explicit) return explicit.split(',').filter(Boolean);
  const profiles = argOf(argv, 'profiles');
  if (!profiles) throw new Error('one of --names or --profiles is required');
  const { profiles: entries } = JSON.parse(await io.readFile(profiles));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${profiles} lists no profiles — the table would be written with only a base`);
  }
  return ['base', ...entries.map((entry) => entry.id)];
}

/** What the push jobs recorded, one file per name, or null when not handed over. */
export async function resolveRecorded(argv, io) {
  const dir = argOf(argv, 'digests');
  if (!dir) return null;
  const names = await io.readdir(dir);
  if (names.length === 0) {
    throw new Error(`no published digests found in ${dir} — the release is incomplete`);
  }
  const recorded = {};
  for (const name of names) {
    recorded[name] = (await io.readFile(`${dir}/${name}`)).trim();
  }
  return recorded;
}

export async function main(argv, io) {
  const image = argOf(argv, 'image');
  const version = argOf(argv, 'version');
  const readmePath = argOf(argv, 'readme', 'packages/cli/sandbox/README.md');
  const runUrl = argOf(argv, 'run-url', '');
  const write = argv.includes('--write');
  if (!image || !version) {
    throw new Error(
      'usage: render-digest-table.mjs --image <registry/repo> --version <x.y.z> ' +
        '[--profiles <profiles.json> | --names a,b,c] [--digests <dir>] [--readme <path>] [--write]',
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`--version must be a bare x.y.z, not '${version}'`);
  }

  const names = await resolveNames(argv, io);
  const recorded = await resolveRecorded(argv, io);
  const readme = await io.readFile(readmePath);

  // The previous release the novelty invariant compares against: the newest
  // section that is NOT this version (a re-run of the same tag must compare
  // against its predecessor, not against the row it is about to overwrite).
  const sections = parseSections(readme);
  const readmeLines = readme.split('\n');
  const previousSection = sections.find((section) => section.version !== version);
  const previous = previousSection
    ? {
        version: previousSection.version,
        rows: parseRows(readmeLines.slice(previousSection.start, previousSection.end).join('\n')),
      }
    : null;

  const resolved = await resolveDigestRows(image, names, version, {
    control: argOf(argv, 'control'),
    fetch: io.fetch,
  });
  for (const problem of resolved.problems) io.error(`::error::${problem}`);
  if (resolved.exitCode !== 0) {
    io.error(`::error::${resolved.summary} — the README was NOT edited.`);
    return resolved.exitCode;
  }
  io.log(resolved.summary);

  const novelty = checkNovelty(resolved.rows, previous);
  const recordedCheck = checkRecorded(resolved.rows, recorded);
  const violations = [...novelty.problems, ...recordedCheck.problems];
  if (violations.length > 0) {
    for (const problem of violations) io.error(`::error::${problem}`);
    io.error(
      '::error::an invariant the § Published images section CLAIMS does not hold — the ' +
        'README was NOT edited. This is a release finding, not a formatting detail.',
    );
    return 1;
  }
  io.log(
    novelty.checked
      ? `every digest differs from its cli-v${novelty.against} row (${resolved.rows.length} of ${resolved.rows.length})`
      : 'no earlier release to compare against — the novelty invariant is vacuous',
  );
  if (recordedCheck.checked) {
    io.log(
      `every digest matches what the push jobs recorded (${resolved.rows.length} of ${resolved.rows.length})`,
    );
  }

  const section = renderSection({ image, version, runUrl, rows: resolved.rows, novelty });
  const update = updateReadme(readme, { version, section });
  if (update.error) {
    io.error(`::error::${update.error}`);
    return 1;
  }

  if (!update.changed) {
    // Not a failure, and deliberately not a pull request either.
    io.log(`${readmePath} already records cli-v${version} exactly — nothing to change`);
    io.setOutput('changed', 'false');
    return 0;
  }

  if (!write) {
    io.log(`--- the section cli-v${version} would ${update.action} ---`);
    io.log(section);
    io.setOutput('changed', 'true');
    return 0;
  }

  await io.writeFile(readmePath, update.content);
  io.log(
    `${readmePath}: ${update.action} the cli-v${version} section` +
      (update.action === 'inserted' && update.displaced
        ? `, demoting cli-v${update.displaced} to history`
        : ''),
  );
  io.setOutput('changed', 'true');
  return 0;
}

// Only when executed, never when imported by the unit tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { readdir, readFile, writeFile, appendFile } = await import('node:fs/promises');
  const io = {
    readdir: (dir) => readdir(dir),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, content) => writeFile(path, content, 'utf8'),
    // `process.stdout.write` rather than `console.log`: the repo's `no-console`
    // rule allows only `warn`/`error`, and a disable comment here would suppress
    // the rule rather than respect it.
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => console.error(line),
    setOutput: (name, value) => {
      // The workflow needs ONE bit out of this script — did anything change —
      // and reads it the way every other step does. Absent outside Actions, so a
      // developer running this in a shell is unaffected.
      if (process.env.GITHUB_OUTPUT) {
        void appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
      }
    },
  };
  main(process.argv.slice(2), io).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
