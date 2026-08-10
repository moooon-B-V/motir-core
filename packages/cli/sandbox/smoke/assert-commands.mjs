#!/usr/bin/env node
//
// DOES THE COMMAND ON THE PAGE EXIST IN THE IMAGE? (MOTIR-2612)
//
// `/docs/sandbox` tells a stranger to pull one container and then type three
// commands inside it. Between those two acts sat a gap nothing in this
// repository looked into. Three checks stop just short of it:
//
//   - `sandbox-published` pulls every published digest and runs the CLI — after
//     `docker/login-action`, so it asks the PUBLISHER's question, for whom
//     everything always works, and asks it of `--version`, which is a number
//     rather than a command set.
//   - `sandbox-public` (`assert-public.mjs`) asks the CONSUMER's question with
//     no credential at all — but only whether the pull succeeds, and a pull that
//     succeeds says nothing about what was pulled.
//   - `sandbox-staleness` (`assert-current.mjs`) watches how far `main` has
//     drifted from the newest tag — reading git, never the registry.
//
// So "does the command the docs tell a reader to run exist in the image they are
// told to pull?" was asked by nothing. It has since been asked in anger twice,
// and the second time is why this script's verdict is three-valued rather than
// two:
//
//   - MOTIR-2131: TRUE. `cli-v0.1.0`'s image predated `motir login` while the
//     guide's step 4 told every new reader to run it. Green for five days.
//   - MOTIR-2611: FALSE, and not cheaper. A whole card was written, prioritised
//     and dispatched on the belief that the published image lacked a command it
//     had shipped with all along — because confirming it meant reading the
//     artifact and nobody had a way to do that (`notes.html` #253).
//
// ── The expected set is DERIVED from the page, never restated here ──────────
//
// `lib/apiDocs/sandbox.ts` annotates each guide step with the commands that step
// instructs the reader to run (`cliCommands: ['login']`, …) — as data, because
// the page renders them. That array IS the expectation, so a step that names a
// new command is covered the day it is written. A second hand-kept list would
// eventually disagree with the page, and a check that confidently asserts the
// wrong thing is worse than no check.
//
// The derivation therefore FAILS LOUD rather than empty. A parser that matched
// nothing would report "0 expected, 0 missing, PASS" — which is `notes.html`
// #231 exactly: a guard whose pattern silently stops recognising its targets and
// keeps answering reassuringly. So the count of `cliCommands:` keys must equal
// the count of arrays actually read, an array holding anything but string
// literals is a refusal, and an empty expectation is exit 2, never exit 0.
//
// ── Why it holds no credential, and why that is structural ──────────────────
//
// Every header this script sends is listed in `anonymousRegistry` below. It
// reads no docker config, no `~/.docker/config.json`, no `GITHUB_TOKEN`, and no
// keychain, so it returns the same verdict from a developer's already-logged-in
// shell as it does from a job that never logged in. The one `authorization`
// header it ever sets carries a token the registry hands to a NOBODY on request
// — the standard v2 challenge dance, identical to `assert-public.mjs`, and the
// thing being measured is precisely that an anonymous caller gets one.
//
// ── Why no Docker daemon: the diagnostician had none ────────────────────────
//
// The obvious implementation is `docker run <ref> motir help`. This script does
// not, for three reasons, in ascending order of weight:
//
//   1. It runs anywhere `node` does — no daemon, no root, no 4 GB pull — which
//      is the same property that lets `assert-public.mjs` and
//      `assert-current.mjs` be run by a human mid-investigation. The failure
//      MOTIR-2611 records is a question left unanswered because answering it
//      needed a tool the person asking did not have.
//   2. `docker run` tests ONE architecture — the runner's. The index publishes
//      linux/amd64 AND linux/arm64, and every reader on an M-series Mac gets the
//      second one. This checks every platform in the index.
//   3. The bytes are verified before they are trusted: each blob's sha256 is
//      recomputed and compared with the digest the manifest named, so "pinned by
//      digest" is something this script establishes rather than asserts.
//
// What it gives up is the container's own entrypoint and PATH — `motir` resolving
// to the installed bin inside the image. That claim is already made, credential-
// free, by `sandbox-public`'s `docker run … motir --version` step next door; the
// two jobs answer adjacent questions and neither subsumes the other.
//
// ⚠️ It EXECUTES code pulled from a registry — the image's own CLI bundle, run
// with the host's `node`. That is the same trust the reader extends when they
// `docker run` it, narrowed twice: the blob is digest-verified before extraction,
// and the child process gets a minimal environment and a temp cwd (`runHelp`).
//
// ── The control, without which a green verdict proves nothing ───────────────
//
// This probe's dangerous direction is the opposite of `assert-public.mjs`'s. A
// broken matcher there reports "private" — the answer being hunted. A broken
// matcher HERE reports "present" for everything, because a loose match (a
// substring scan over the whole help text, say — `login` appears in prose) finds
// whatever it is asked for. So every run first asks for a command name that
// cannot exist, and requires the answer to be NO. A control that comes back
// present is reported as INDETERMINATE, never as a verdict about the image.
//
// The other direction is covered by the shape of the parse rather than a control:
// help output that yields no command groups, or no commands, is `unreadable`
// (exit 2) rather than "every expected command is missing" (exit 1).
//
// The end-to-end pipeline has a HISTORICAL control too, and it is the strongest
// evidence this check has — but deliberately NOT wired into the run:
//
//   $ node assert-commands.mjs --ref ghcr.io/moooon-b-v/motir-sandbox:claude
//     PRESENT … [linux/amd64] cli 0.2.0 · PRESENT … [linux/arm64] cli 0.2.0 → 0
//   $ node assert-commands.mjs --ref ghcr.io/moooon-b-v/motir-sandbox:claude-0.1.0
//     MISSING … login (both architectures), cli 0.1.0                       → 1
//
// `:claude-0.1.0` is the artifact MOTIR-2131 was filed about, still published, and
// the whole probe goes red on it and green on the current tag. Running it every
// time would make this job depend on a legacy tag nobody has promised to keep: a
// deleted control would report INDETERMINATE forever, and a check that cannot be
// green is muted within a week. So the run's control is the local, synthetic one
// above, and this pair is the reproduction a human runs — it is in the PR that
// added the job and it is two commands to redo.
//
// ── Three-valued on purpose ────────────────────────────────────────────────
//
// 0 every documented command is in the image · 1 at least one is MISSING ·
// 2 could not tell (a broken derivation, an unreadable image, a failed control,
// a host `node` too old to run the extracted CLI). Both siblings make the same
// split for the same reason: collapsing "could not measure" into a verdict is
// how a broken probe starts reporting reassuring answers.
//
// Usage:
//   assert-commands.mjs --ref ghcr.io/moooon-b-v/motir-sandbox:claude [--ref …]
//   assert-commands.mjs --image <registry/repo> --digests <dir> [--names a,b]
//   assert-commands.mjs --ref <ref> --guide <path to lib/apiDocs/sandbox.ts>
//
// `--digests <dir>` is the release lane's form, one file per published name,
// exactly as the push jobs upload them — and the same reader `assert-public.mjs`
// uses, imported from it rather than reimplemented.

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseBearerChallenge, parseReference, resolveReferences } from './assert-public.mjs';

/**
 * The page that OWNS the expectation. Repo-relative; `--guide` overrides it.
 *
 * Deliberately `sandbox.ts` and not its sibling `cli.ts`, which carries the same
 * `cliCommands` annotation for `/docs/cli`. Those commands run on the reader's
 * HOST, against an `npm install -g @motir/cli` that has nothing to do with this
 * image — asserting them here would fail on a release-skew between npm and GHCR
 * that is not this check's business.
 */
export const DEFAULT_GUIDE_PATH = 'lib/apiDocs/sandbox.ts';

/** Where `npm install -g` puts the CLI in the image (Dockerfile:127, on the
 *  official `node` base whose prefix is `/usr/local`). The entry point is read
 *  from the extracted `package.json`'s `bin`, not assumed from this path. */
export const CLI_PACKAGE_DIR = 'usr/local/lib/node_modules/@motir/cli';

/**
 * The negative control: a command name that cannot exist.
 *
 * Its absence is the only evidence that a "present" verdict means anything —
 * see the control section in the header. Shaped like a plausible command
 * (lowercase, hyphenated) so it exercises the same matcher path a real name
 * does; a name with a space or a slash would be rejected by the shape filter
 * before the matcher ever saw it, which would make the control vacuous.
 */
export const CONTROL_COMMAND = 'sandbox-control-command-that-cannot-exist';

const USER_AGENT = 'motir-sandbox-assert-commands';
const REQUEST_TIMEOUT_MS = 30_000;

/** Manifest media types to accept. An index and a plain manifest are different
 *  types and a registry 404s a type the client did not ask for, so all four. */
const INDEX_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

/** A ceiling on how much of an image this will pull looking for the CLI. The
 *  layer it wants is ~1.4 MB; the agent-install layers next to it are 100 MB+.
 *  A run that has downloaded this much without finding the package reports
 *  `unreadable` rather than continuing to drain a runner's bandwidth. */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** Raised for every "could not tell" — a transport failure, a digest mismatch,
 *  an unreadable manifest. Distinct from a command being missing, which is a
 *  verdict rather than an error. */
export class IndeterminateError extends Error {}

// ── The expectation, derived from the guide ──────────────────────────────────

/**
 * Read every `cliCommands: [...]` array out of the guide SOURCE.
 *
 * Text, not an import: this is a zero-dependency `.mjs` and the guide is
 * TypeScript. The parse is therefore the load-bearing part, and it is written to
 * make silence impossible — `declared` counts the `cliCommands:` keys present,
 * `parsed` counts the arrays it actually understood, and a caller that sees them
 * differ must refuse to give a verdict (`notes.html` #231: a pattern that quietly
 * stops matching keeps answering reassuringly).
 *
 * `unparsed` names the arrays it could not read, so the refusal says WHICH step
 * it choked on.
 */
export function parseCliCommands(source) {
  const text = String(source ?? '');
  const declared = (text.match(/\bcliCommands\s*:/g) ?? []).length;
  const commands = [];
  const unparsed = [];
  let parsed = 0;

  for (const match of text.matchAll(/\bcliCommands\s*:\s*\[([^\]]*)\]/g)) {
    const inner = match[1];
    const literals = [...inner.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    // Anything left once the string literals, commas and whitespace are removed
    // is an expression this parser cannot evaluate — a spread, an identifier, a
    // template literal. Counting such an array as "parsed" would silently drop
    // whatever it contributes, which is the failure mode above.
    const residue = inner.replace(/'[^']*'|"[^"]*"/g, '').replace(/[\s,]/g, '');
    if (residue.length > 0 || literals.some((value) => value.trim().length === 0)) {
      unparsed.push(inner.trim());
      continue;
    }
    parsed += 1;
    commands.push(...literals.map((value) => value.trim()));
  }

  return { declared, parsed, unparsed, commands: [...new Set(commands)].sort() };
}

/**
 * The expectation as a verdict-or-refusal.
 *
 * An empty set is a REFUSAL, not a trivially satisfied expectation. A guide with
 * no `cliCommands` anywhere and a parser that has stopped matching are the same
 * observation from here, and the first is not a state this repository is in.
 */
export function expectedCommands(source) {
  const { declared, parsed, unparsed, commands } = parseCliCommands(source);
  if (declared !== parsed) {
    return {
      ok: false,
      commands,
      detail:
        `the guide declares ${declared} cliCommands array(s) and this parser understood ${parsed} — ` +
        `it cannot state the expectation${unparsed.length > 0 ? `; unread: ${unparsed.join(' | ')}` : ''}`,
    };
  }
  if (commands.length === 0) {
    return {
      ok: false,
      commands,
      detail:
        'the guide yielded NO documented commands — either no step names one (which would make this ' +
        'check vacuous) or the parser no longer matches the source',
    };
  }
  return { ok: true, commands, detail: null };
}

// ── The answer, parsed out of the image's own help ───────────────────────────

/** A heading that introduces commands. `SETUP COMMANDS:` / `WORK LOOP COMMANDS:`
 *  in the curated top-level surface (`help.ts`), plain `Commands:` in
 *  commander's default subcommand rendering, plus the topics group, which holds
 *  `help` itself. Everything else — `FLAGS:`, `Options:`, `EXAMPLES:`,
 *  `LEARN MORE:` — is excluded, and that exclusion is what keeps `$` (from an
 *  example line) and `-v,` (from a flag) out of the command set. */
const COMMAND_HEADING = /(^|\s)commands:$/i;
const TOPICS_HEADING = /^help topics:$/i;

/**
 * Extract the top-level command names from one `motir help [...]` output.
 *
 * Two independent filters, because either alone is too loose: a name is counted
 * only INSIDE a command group, and only when the line is a group entry — exactly
 * two spaces of indent followed by a lowercase command-shaped token. Commander
 * wraps descriptions at a much deeper indent, so a continuation line fails the
 * second filter, and a substring scan (which would find `login` in prose, and is
 * what the negative control exists to catch) is not what happens here.
 */
export function parseHelpCommands(text) {
  const groups = [];
  let current = null;

  for (const raw of String(text ?? '').split('\n')) {
    const heading = /^([A-Za-z][A-Za-z ]*):\s*$/.exec(raw);
    if (heading) {
      const label = heading[1].trim();
      current =
        COMMAND_HEADING.test(`${label}:`) || TOPICS_HEADING.test(`${label}:`)
          ? { heading: label, names: [] }
          : null;
      if (current) groups.push(current);
      continue;
    }
    if (!current) continue;
    const entry = /^ {2}(?! )([a-z][a-z0-9-]*)(?=\s|$)/.exec(raw);
    if (entry) current.names.push(entry[1]);
  }

  return { groups, commands: [...new Set(groups.flatMap((group) => group.names))] };
}

/**
 * The whole judgement, as a function of the expectation and a help-text seam.
 *
 * `helpFor(segments)` returns the output of `motir help <segments…>`; the empty
 * array is the top-level surface. Injected rather than called directly so the
 * decision is testable without a registry, an image, or a subprocess — and so a
 * nested path (`auth status`, which `lib/apiDocs/cli.ts` already uses and a
 * sandbox step could adopt tomorrow) resolves by ASKING the CLI about its
 * parent, not by string-matching a two-word name against a one-word list.
 */
export async function assertCommandSet({ expected, helpFor, control = CONTROL_COMMAND }) {
  const top = parseHelpCommands(await helpFor([]));

  if (top.groups.length === 0 || top.commands.length === 0) {
    return {
      verdict: 'unreadable-help',
      exitCode: 2,
      expected,
      missing: [],
      present: [],
      summary:
        `\`motir help\` produced no recognisable command groups — the image's help surface has ` +
        `changed shape, or nothing ran. This is NOT a report that the commands are missing`,
    };
  }
  if (top.commands.includes(control)) {
    return {
      verdict: 'control-present',
      exitCode: 2,
      expected,
      missing: [],
      present: [],
      control,
      summary:
        `the negative control '${control}' was reported PRESENT — the matcher answers yes to ` +
        `anything, so this run proves NOTHING about the documented commands`,
    };
  }
  if (expected.length === 0) {
    return {
      verdict: 'no-expectation',
      exitCode: 2,
      expected,
      missing: [],
      present: [],
      summary: 'no documented commands to assert — see the derivation refusal above',
    };
  }

  const present = [];
  const missing = [];
  for (const path of expected) {
    const segments = String(path).trim().split(/\s+/);
    let available = top.commands;
    let found = true;
    for (const [index, segment] of segments.entries()) {
      if (!available.includes(segment)) {
        found = false;
        break;
      }
      if (index === segments.length - 1) break;
      // A nested path: ask the CLI what lives under the parent rather than
      // guessing. An unreadable sub-help is a refusal for the whole run — the
      // alternative is calling the child missing because its parent's help
      // could not be read.
      const parent = segments.slice(0, index + 1);
      const sub = parseHelpCommands(await helpFor(parent));
      if (sub.commands.length === 0) {
        return {
          verdict: 'unreadable-help',
          exitCode: 2,
          expected,
          missing: [],
          present,
          summary: `\`motir help ${parent.join(' ')}\` listed no commands — cannot resolve '${path}'`,
        };
      }
      available = sub.commands;
    }
    (found ? present : missing).push(path);
  }

  if (missing.length > 0) {
    return {
      verdict: 'missing',
      exitCode: 1,
      expected,
      present,
      missing,
      control,
      summary:
        `the published CLI is missing ${missing.length} of ${expected.length} command(s) the docs ` +
        `tell readers to run: ${missing.join(', ')} — every reader who follows the guide hits ` +
        `\`Unknown command\`. Cut a release: the image can only contain what its tag contained`,
    };
  }
  return {
    verdict: 'complete',
    exitCode: 0,
    expected,
    present,
    missing,
    control,
    summary: `all ${expected.length} documented command(s) are present: ${present.join(', ')}`,
  };
}

// ── Reading the image, anonymously ───────────────────────────────────────────

/**
 * A GET against one repository that never carries a credential of ours.
 *
 * The complete list of headers this sends: `accept`, `user-agent`, and — only
 * after the registry answered 401 with a challenge and only with the token that
 * challenge's own endpoint handed an unauthenticated caller — `authorization`.
 * GHCR requires that dance even for a public repository, so "no Authorization
 * header at all" is not reachable against it; what IS reachable, and what the
 * check actually rests on, is that no stored, ambient or job-provided credential
 * exists anywhere in this path. Same mechanism, same reason, as
 * `assert-public.mjs`, whose challenge parser this reuses.
 */
export function anonymousRegistry(parsed, fetchImpl = globalThis.fetch) {
  let token = null;

  const send = (url, accept) =>
    fetchImpl(url, {
      method: 'GET',
      headers: {
        accept,
        'user-agent': USER_AGENT,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  return async function get(path, accept) {
    const url = `https://${parsed.registry}/v2/${parsed.repository}/${path}`;
    let response;
    try {
      response = await send(url, accept);
      if (response.status === 401) {
        const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
        if (!challenge) {
          throw new IndeterminateError(
            `${parsed.registry} demanded authentication for ${path} and offered no bearer challenge`,
          );
        }
        const tokenUrl = new URL(challenge.realm);
        if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
        if (challenge.scope) tokenUrl.searchParams.set('scope', challenge.scope);
        const tokenResponse = await fetchImpl(tokenUrl.toString(), {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = tokenResponse.ok ? await tokenResponse.json().catch(() => null) : null;
        const issued = body && typeof body === 'object' ? (body.token ?? body.access_token) : null;
        if (typeof issued !== 'string' || issued.length === 0) {
          // The same wire fact `assert-public.mjs` reports as `private-or-absent`.
          // Here it is a refusal rather than a verdict: this script's question is
          // about the image's CONTENTS, and it has not seen them.
          throw new IndeterminateError(
            `${parsed.registry} refused an anonymous pull token for ${parsed.repository} — the ` +
              `package is private, or absent (that verdict belongs to assert-public.mjs)`,
          );
        }
        token = issued;
        response = await send(url, accept);
      }
    } catch (err) {
      if (err instanceof IndeterminateError) throw err;
      throw new IndeterminateError(
        `${parsed.registry} could not be reached for ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw new IndeterminateError(
        `HTTP ${response.status} reading ${path} from ${parsed.registry}`,
      );
    }
    return response;
  };
}

/** Recompute a blob's digest and refuse to go further if it does not match.
 *  This is what makes "digest-pinned" a property of the run rather than a claim
 *  about it — and the bytes are about to be EXECUTED. */
export function verifyDigest(bytes, digest, label) {
  const [algorithm, expected] = String(digest ?? '').split(':');
  if (algorithm !== 'sha256' || !expected) {
    throw new IndeterminateError(`${label} is named by an unsupported digest '${digest}'`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new IndeterminateError(
      `${label} did not match its digest — expected sha256:${expected}, got sha256:${actual}. ` +
        `Nothing was extracted or executed`,
    );
  }
}

/**
 * Walk a tar buffer, handing each file entry to `onEntry`.
 *
 * Enough of the format for a container layer and no more: 512-byte headers,
 * octal sizes, the `L` long-name extension GNU tar writes for deep
 * `node_modules` paths, and the `prefix` field POSIX tar uses for the same
 * purpose.
 */
export function walkTar(buffer, onEntry) {
  const octal = (field) => {
    const text = field.toString('latin1').replace(/\0.*$/, '').trim();
    return text.length === 0 ? 0 : Number.parseInt(text, 8) || 0;
  };
  let offset = 0;
  let longName = null;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const size = octal(header.subarray(124, 136));
    const type = header.subarray(156, 157).toString('latin1');
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    if (longName) {
      name = longName;
      longName = null;
    }
    // Regular files only ('0' and the historical '\0'). Directories, symlinks
    // and whiteouts carry no bytes this needs.
    if (type !== '0' && type !== '\0') continue;
    onEntry({ name, size, body });
  }
}

/**
 * Order the layers by how likely each is to hold the CLI, cheapest first.
 *
 * The image config's `history` records the Dockerfile instruction behind every
 * layer, and the CLI arrives via one that names the packed tarball
 * (`npm install -g /tmp/motir-cli.tgz`). Matching on that puts a ~1.4 MB layer
 * first instead of walking forward through two 50 MB apt layers.
 *
 * It is a HINT and cannot produce a wrong answer: the layer is accepted only
 * when the package is actually found in it, and every other layer is still
 * searched afterwards — newest first, which is also filesystem order, so a later
 * layer that replaced the CLI wins. A history that stops mentioning the tarball
 * costs a slower run, not a false verdict.
 */
export function orderLayersByLikelihood(config, layerCount) {
  const hinted = [];
  let index = -1;
  for (const entry of config?.history ?? []) {
    if (entry?.empty_layer) continue;
    index += 1;
    if (index >= layerCount) break;
    const createdBy = String(entry?.created_by ?? '');
    if (/motir-cli|@motir\/cli/.test(createdBy)) hinted.push(index);
  }
  const rest = [];
  for (let i = layerCount - 1; i >= 0; i -= 1) if (!hinted.includes(i)) rest.push(i);
  return [...hinted, ...rest];
}

/**
 * Pull the platform manifests for a reference. An index fans out to one per
 * platform; a single-arch manifest is its own list of one.
 *
 * The `unknown/unknown` entries buildx attaches (SBOM / provenance attestations)
 * are skipped — they carry no filesystem and would each cost a failed search.
 */
export async function resolvePlatforms(reference, io) {
  const parsed = parseReference(reference);
  if (!parsed) {
    throw new IndeterminateError(
      `'${reference}' is not a fully-qualified <registry>/<repository>[:tag|@digest] reference`,
    );
  }
  const get = io.registry(parsed);
  const response = await get(`manifests/${parsed.reference}`, INDEX_ACCEPT);
  const indexDigest = response.headers.get('docker-content-digest');
  const document = await response.json();

  if (!Array.isArray(document?.manifests)) {
    // A single-architecture manifest is its own list of one. Re-read by the
    // digest the reference already pinned where it had one, rather than by the
    // header the registry echoed — the release lane always passes a digest, and
    // a tag re-read is a second chance for the tag to have moved underneath.
    const pinned = parsed.reference.startsWith('sha256:') ? parsed.reference : indexDigest;
    return {
      parsed,
      indexDigest,
      platforms: [{ platform: 'unspecified', digest: pinned ?? parsed.reference }],
    };
  }
  const platforms = document.manifests
    .filter((entry) => entry?.platform?.os && entry.platform.os !== 'unknown')
    .map((entry) => ({
      platform: `${entry.platform.os}/${entry.platform.architecture}`,
      digest: entry.digest,
    }));
  if (platforms.length === 0) {
    throw new IndeterminateError(`${reference} is an index with no platform manifests`);
  }
  return { parsed, indexDigest, platforms };
}

/**
 * Extract the installed `@motir/cli` package out of one platform's layers.
 *
 * Returns the package's files keyed by their path INSIDE the package, plus the
 * layer digest they came from, so the report can name the exact bytes.
 */
export async function extractCliPackage(parsed, manifestDigest, io) {
  const get = io.registry(parsed);
  const manifest = await (await get(`manifests/${manifestDigest}`, INDEX_ACCEPT)).json();
  if (!Array.isArray(manifest?.layers) || manifest.layers.length === 0) {
    throw new IndeterminateError(`${manifestDigest} names no layers`);
  }

  const configBytes = Buffer.from(
    await (await get(`blobs/${manifest.config.digest}`, '*/*')).arrayBuffer(),
  );
  verifyDigest(configBytes, manifest.config.digest, 'the image config');
  let config = null;
  try {
    config = JSON.parse(configBytes.toString('utf8'));
  } catch {
    // A config we cannot parse costs the history HINT, nothing more.
    config = null;
  }

  const prefix = `${CLI_PACKAGE_DIR}/`;
  let downloaded = 0;

  for (const layerIndex of orderLayersByLikelihood(config, manifest.layers.length)) {
    const layer = manifest.layers[layerIndex];
    if (downloaded + (layer.size ?? 0) > MAX_DOWNLOAD_BYTES) continue;
    const compressed = Buffer.from(await (await get(`blobs/${layer.digest}`, '*/*')).arrayBuffer());
    downloaded += compressed.length;
    verifyDigest(compressed, layer.digest, `layer ${layerIndex} of ${manifestDigest}`);

    let tar;
    try {
      tar = layer.mediaType?.endsWith('gzip') ? gunzipSync(compressed) : compressed;
    } catch (err) {
      throw new IndeterminateError(
        `layer ${layerIndex} could not be decompressed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const files = new Map();
    walkTar(tar, ({ name, body }) => {
      // Layer paths are relative and may carry a `./` prefix depending on the
      // builder; both forms name the same file.
      const normalized = name.replace(/^\.\//, '');
      if (normalized.startsWith(prefix))
        files.set(normalized.slice(prefix.length), Buffer.from(body));
    });
    if (files.size > 0) {
      // Read off the package's own declared version here rather than in the
      // runner: the report names it whether or not the CLI ever started, which
      // is exactly the line a reader wants when it did not.
      let version = null;
      try {
        version = JSON.parse(files.get('package.json')?.toString('utf8') ?? '{}').version ?? null;
      } catch {
        version = null;
      }
      return { files, version, layerDigest: layer.digest, layerIndex };
    }
  }

  throw new IndeterminateError(
    `no ${CLI_PACKAGE_DIR} found in any layer of ${manifestDigest} after ${Math.round(downloaded / 1048576)} MB — ` +
      `the CLI is not installed where the Dockerfile puts it, or the image is not a motir sandbox`,
  );
}

/**
 * Run the extracted CLI's `help`, with the entry point taken from the package's
 * own `bin` rather than a path assumed here.
 *
 * The host `node` must satisfy the package's `engines`, and a host that does not
 * is a refusal: a CLI that will not start on this machine tells us nothing about
 * what it contains.
 */
export async function runHelp(pkg, io, segments = []) {
  const manifest = pkg.files.get('package.json');
  if (!manifest) throw new IndeterminateError('the extracted CLI has no package.json');
  let parsedManifest;
  try {
    parsedManifest = JSON.parse(manifest.toString('utf8'));
  } catch (err) {
    throw new IndeterminateError(
      `the extracted CLI's package.json is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const bin = parsedManifest?.bin;
  const entry = typeof bin === 'string' ? bin : bin?.motir;
  if (typeof entry !== 'string') {
    throw new IndeterminateError('the extracted CLI declares no `motir` bin — nothing to run');
  }
  const required = /(\d+)/.exec(String(parsedManifest?.engines?.node ?? ''))?.[1];
  const hostMajor = Number(process.versions.node.split('.')[0]);
  if (required && hostMajor < Number(required)) {
    throw new IndeterminateError(
      `the image's CLI requires node >=${required} and this host runs ${process.versions.node} — ` +
        `it cannot be asked what commands it has`,
    );
  }
  return io.runNode(pkg, entry.replace(/^\.\//, ''), ['help', ...segments]);
}

/**
 * The whole check for one reference: every platform in its index, each judged
 * against the same derived expectation.
 */
export async function assertReference(reference, expected, io) {
  const { indexDigest, parsed, platforms } = await resolvePlatforms(reference, io);
  const results = [];
  for (const { platform, digest } of platforms) {
    const pkg = await io.cached(digest, () => extractCliPackage(parsed, digest, io));
    const helpFor = (segments) => runHelp(pkg, io, segments);
    const result = await assertCommandSet({ expected, helpFor });
    results.push({ reference, platform, digest, cliVersion: pkg.version ?? null, ...result });
  }
  return { reference, indexDigest, results };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

export async function main(argv, io) {
  const expectation = expectedCommands(
    await io.readGuide(argOf(argv, 'guide', DEFAULT_GUIDE_PATH)),
  );
  if (!expectation.ok) {
    // Refused BEFORE a byte is pulled. An expectation this script cannot state
    // is not one it can test, and reporting 0-of-0 present would be the exact
    // silence the derivation is written to prevent.
    io.error(
      `::error::${expectation.detail} — this run proves NOTHING about the published images.`,
    );
    return 2;
  }
  io.log(
    `expected ${expectation.commands.join(', ')}  (from ${argOf(argv, 'guide', DEFAULT_GUIDE_PATH)})`,
  );
  io.log(`control  ${CONTROL_COMMAND} — must come back ABSENT`);

  const references = await resolveReferences(argv, io);
  const rows = [];
  for (const reference of references) {
    try {
      const { results } = await assertReference(reference, expectation.commands, io);
      rows.push(...results);
    } catch (err) {
      if (!(err instanceof IndeterminateError)) throw err;
      rows.push({
        reference,
        platform: '—',
        verdict: 'unreadable-image',
        exitCode: 2,
        summary: err.message,
      });
    }
  }

  for (const row of rows) {
    const label =
      row.verdict === 'complete' ? 'PRESENT' : row.verdict === 'missing' ? 'MISSING' : 'UNKNOWN';
    io.log(
      `         ${label} ${row.reference} [${row.platform}]` +
        `${row.cliVersion ? ` cli ${row.cliVersion}` : ''} — ${row.summary}`,
    );
  }
  // 1 (a definite defect) outranks 2 (could not tell): a release with one image
  // provably missing a documented command must not be reported as inconclusive
  // because a second image failed to download.
  const exitCode = rows.some((row) => row.exitCode === 1)
    ? 1
    : rows.some((row) => row.exitCode === 2)
      ? 2
      : 0;

  if (exitCode === 1) {
    io.error(
      `::error::The published sandbox image does not carry every command /docs/sandbox tells readers ` +
        `to run. FIX: cut a CLI release (bump packages/cli/package.json, merge, tag the merge commit ` +
        `as cli-v<version>) — the image can only ever contain what its tag contained. Do NOT edit the ` +
        `guide to match a stale image.`,
    );
  } else if (exitCode === 2) {
    io.error(
      `::error::assert-commands could not read the published CLI — this is a PROBE failure, not a ` +
        `verdict that the commands are present.`,
    );
  }
  return exitCode;
}

// Only when executed, never when imported by the unit tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { execFile } = await import('node:child_process');
  const { mkdtemp, mkdir, readdir, readFile, writeFile } = await import('node:fs/promises');
  const { promisify } = await import('node:util');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const run = promisify(execFile);
  const cache = new Map();

  const io = {
    readGuide: (path) => readFile(path, 'utf8'),
    readdir: (dir) => readdir(dir),
    readFile: (path) => readFile(path, 'utf8'),
    registry: (parsed) => anonymousRegistry(parsed),
    cached: async (key, produce) => {
      // Every published profile shares the base image's CLI layer, so a release
      // of ten tags resolves to one or two distinct sets of bytes. Keyed by
      // digest, which is what makes the reuse sound rather than an assumption.
      if (!cache.has(key)) cache.set(key, await produce());
      return cache.get(key);
    },
    runNode: async (pkg, entry, args) => {
      if (!pkg.dir) {
        pkg.dir = await mkdtemp(join(tmpdir(), 'motir-image-cli-'));
        for (const [name, bytes] of pkg.files) {
          const target = join(pkg.dir, name);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
        }
      }
      // A minimal environment and a temp cwd: this is the image's code, and it
      // is being run to be interrogated, not trusted. `PATH` is kept because
      // node itself needs none of it but a spawn without one is a portability
      // trap; nothing else is passed through.
      const { stdout } = await run(process.execPath, [join(pkg.dir, entry), ...args], {
        cwd: pkg.dir,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: pkg.dir, NO_COLOR: '1' },
        maxBuffer: 8e6,
        timeout: 60_000,
      });
      return stdout;
    },
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => console.error(line),
  };
  main(process.argv.slice(2), io).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
