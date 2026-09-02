import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '../helpers/stripSourceComments';

// ⚠️ THE SESSION COOKIE IS HOST-ONLY (MOTIR-4120 · `public-surface-hosts.md` §4).
//
// ── This is the condition the whole host split rests on ───────────────────
//
// §4 accepts a deviation no comparable product accepted. Notion, GitHub,
// Vercel, Canny and Statuspage each put customer-authored content on a separate
// REGISTRABLE DOMAIN; Motir puts it on `motir.co`, which is the PARENT of the
// domain holding the login. §4 says so in terms — "better than today and weaker
// than the mirrors" — and accepts the residual exposure "on the condition that
// the session cookie is host-only", adding: "that condition is what makes it
// survivable, so it is a test rather than an intention".
//
// This is that test. Until MOTIR-3877 the sentence was the only thing enforcing
// it, and a condition nothing checks is a hope.
//
// ── What would break it, and why it is EASY to break ──────────────────────
//
// Widening the cookie's `Domain` to `.motir.co` is one line, it makes every
// cross-origin affordance work instantly, and it silently converts an XSS in
// somebody's project README into a session-stealing bug. That pressure arrives
// at a specific, predictable moment — the moment somebody makes a Follow button
// work from a page that cannot see the session — which is exactly what
// `app/act/route.ts` (MOTIR-4114) exists to make unnecessary.
//
// ── ⚠️ AND `SameSite` IS PART OF THE SAME PROMISE (AMENDMENT 3 §B) ────────
//
// `sameSite: 'lax'` is the constraint that actually forecloses a credentialed
// cross-origin call, independently of `Domain` — a `fetch` from `motir.co` with
// `credentials: 'include'` sends no cookie at all under `lax`. So `Domain` and
// `SameSite` are asserted together: relaxing EITHER re-opens what §4 closed, and
// a suite that watched only the famous one would go green on the change that
// actually mattered.
//
// ── The check is a TREE GREP, not a file read ─────────────────────────────
//
// Reading `lib/auth/index.ts` proves that file is clean and says nothing about
// the other 2,000. A widening can arrive anywhere: a second `betterAuth()`
// call, a `Set-Cookie` written by hand, a middleware rewriting a cookie header.
// The idiom is `tests/hosting/appUrlSeam.test.ts`'s — ask the repository, not
// one file — and this suite fails on ANY of them.

const REPO_ROOT = process.cwd();
const AUTH_MODULE = 'lib/auth/index.ts';

/**
 * Every tracked source file under the application, with its COMMENTS STRIPPED.
 *
 * ⚠️ THE STRIP IS NOT A DETAIL. This suite's whole subject is a thing the corpus
 * explains at length: `app/act/route.ts`, `lib/publicProjects/cors.ts` and the
 * ADR all say the words `sameSite: 'none'` and `domain` in order to record why
 * they are refused. A raw `git grep` fails on every one of them, and the only
 * way to make it pass is to stop writing the explanation down — a guard that
 * punishes documenting the hazard it guards.
 *
 * Reading the INDEX (`git ls-files`) rather than the disk keeps an untracked
 * scratch file from failing the suite.
 */
function sourceFiles(): Array<{ file: string; code: string }> {
  const listed = execFileSync('git', ['ls-files', 'app', 'lib', 'proxy.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => /\.(ts|tsx)$/.test(file));

  return listed.map((file) => ({
    file,
    code: stripSourceComments(readFileSync(join(REPO_ROOT, file), 'utf8')),
  }));
}

/** Every CODE line matching `pattern`, as `path:line` — comments excluded. */
function grepTree(pattern: string): string[] {
  const re = new RegExp(pattern);
  const hits: string[] = [];
  for (const { file, code } of sourceFiles()) {
    code.split('\n').forEach((line, index) => {
      if (re.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe('the shipped auth configuration', () => {
  const source = stripSourceComments(readFileSync(join(REPO_ROOT, AUTH_MODULE), 'utf8'));
  const attributes = source.slice(
    source.indexOf('session_token:'),
    source.indexOf('session_token:') + 400,
  );

  it('declares the session cookie, so this suite is not measuring an absence', () => {
    // The vacuous-pass floor. Every assertion below is a `not.toContain`, and a
    // renamed or removed block would satisfy all of them.
    expect(source).toContain('session_token:');
    expect(attributes).toContain('attributes:');
  });

  it('sets NO `domain` on the session cookie', () => {
    expect(attributes).not.toMatch(/\bdomain\s*:/i);
  });

  it("keeps `sameSite: 'lax'` — the constraint that actually forecloses the cross-origin call", () => {
    expect(attributes).toContain("sameSite: 'lax'");
    expect(attributes).not.toContain("sameSite: 'none'");
  });

  it('keeps `httpOnly` — a cookie script can read is a cookie script can send', () => {
    expect(attributes).toContain('httpOnly: true');
  });

  it("does not enable Better-Auth's cross-subdomain cookie mode", () => {
    // `advanced.crossSubDomainCookies` is the framework's own one-flag version
    // of the widening, and it does not spell the word `domain` at the call site.
    expect(source).not.toContain('crossSubDomainCookies');
  });
});

describe('and NOTHING ELSE in the tree widens a cookie either', () => {
  it('no source file scopes a cookie to a dot-prefixed domain', () => {
    // `.motir.co`, `.example.com` — the shape of a widening, wherever it is
    // written: a Better-Auth option, a `cookies().set`, a hand-written
    // `Set-Cookie`.
    const offenders = grepTree('domain: *[\'"`]\\.');
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no `Set-Cookie` header is written by hand with a Domain attribute', () => {
    const offenders = grepTree('[Ss]et-[Cc]ookie.*[Dd]omain=');
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('there is exactly ONE `betterAuth(` call — a second config is a second answer', () => {
    // The widening's other route in: not editing this config, but adding
    // another one somewhere that shadows it for some subset of requests.
    const calls = grepTree('betterAuth\\(');
    expect(calls, calls.join('\n')).toHaveLength(1);
    expect(calls[0]).toContain(AUTH_MODULE);
  });

  it("no `sameSite: 'none'` anywhere — the relaxation that reads as unrelated", () => {
    // A reader hunting for a session-cookie problem greps for `domain`. This is
    // the change that would let a credentialed cross-origin call through while
    // every `domain` check stayed green.
    const offenders = grepTree('sameSite: *[\'"`]none');
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the guard fails when the thing it guards changes', () => {
  it('would catch a widening — the assertions are run against a mutated copy', () => {
    // ⚠️ A GUARD NOBODY HAS SEEN FAIL IS A GUARD NOBODY KNOWS WORKS. Every case
    // above is a negative assertion over text, and the failure mode of such a
    // suite is that it stops reading the right region and passes for ever. So
    // the region is re-extracted from a copy with the widening ADDED, and the
    // check is asserted to notice.
    const original = readFileSync(join(REPO_ROOT, AUTH_MODULE), 'utf8');
    const widened = original.replace(
      "sameSite: 'lax',",
      "sameSite: 'lax',\n          domain: '.motir.co',",
    );

    expect(widened, 'the anchor moved — re-point this test at the real one').not.toBe(original);

    const mutated = stripSourceComments(widened);
    const region = mutated.slice(
      mutated.indexOf('session_token:'),
      mutated.indexOf('session_token:') + 400,
    );
    expect(region).toMatch(/\bdomain\s*:/i);
  });
});
