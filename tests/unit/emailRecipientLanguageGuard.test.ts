import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMAIL_TEMPLATE_CLASS } from '@/lib/services/emailService';

// Story MOTIR-7732 · MOTIR-8110 — THE RULE THAT KEEPS EMAILS IN THE RECIPIENT'S
// LANGUAGE. Every place in `lib/` that queues an `email.send` puts the
// RECIPIENT's language on the payload (`data.locale`, from
// `resolveRecipientLocale(s)`), and none of them reads the language of the
// request that happened to cause the email (`currentLocale()`, `next/headers`).
// The sweep cards' own tests assert the VALUES each sender chooses; this file is
// the static half — a sender added next month is seen here whether or not anyone
// remembered to write a test that drives it.
//
// A pure scan over source strings, modelled on `tests/jobs/sendEvent.test.ts`:
// no database, no job runner, no render.

/** Staff mail, English by design: it goes to Motir's own team, not a customer.
 *  Empty since the Contact-sales staff email went with its feature
 *  (MOTIR-9386), so every template must have a recognisable sender. */
const EXEMPT_STAFF_TEMPLATES: readonly string[] = [];

/** Files that hold an enqueue site AND read the request for another purpose.
 *  In these, only the payload object and the lines just above it are checked. */
const REQUEST_READ_ALLOWLIST: Record<string, string> = {
  [join('lib', 'auth', 'index.ts')]:
    'Better-Auth wiring: `getSession()` reads `next/headers` for the session cookie, not a language',
};

/** Where `template:` is a TYPE (the `TransactionalEmail` union) or the render
 *  path, never a send. */
const NOT_SENDERS = [
  join('lib', 'emailTemplates') + sep,
  join('lib', 'services', 'emailService.ts'),
  join('lib', 'jobs', 'definitions', 'emailSend.ts'),
];

/** The render path: it runs in the off-request `email.send` job. */
const RENDER_PATH = [
  join('lib', 'emailTemplates'),
  join('lib', 'services', 'emailService.ts'),
  join('lib', 'services', 'emailRecipientLocale.ts'),
  join('lib', 'jobs', 'definitions', 'emailSend.ts'),
];

const REQUEST_READ = /currentLocale|next\/headers|serverLocale/;
/** A `locale` PROPERTY — `locale: …` or the shorthand `locale,` / `locale }` —
 *  never the word inside a comment or another identifier. */
const LOCALE_PROPERTY = /(^|[\s{,])locale\s*(:|,|\n?\s*})/m;
/** `template: '<name>'` in VALUE position: followed by `,`, `}` or a newline.
 *  The union writes `template: '<name>';`, which this never matches. */
const TEMPLATE_VALUE = /template:\s*'([a-z0-9-]+)'\s*(?=[,}\n])/g;

const LINES_ABOVE = 30;

interface EnqueueSite {
  file: string;
  template: string;
  /** The balanced `{ … }` object holding `template:`. */
  payload: string;
  /** The payload plus the LINES_ABOVE lines before its `template:`. */
  window: string;
}

/** The balanced object literal enclosing `index`, by brace counting outward. */
function enclosingObject(source: string, index: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = index; i >= 0; i--) {
    const ch = source[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** Every `email.send` enqueue site in one source string. */
function findEnqueueSites(file: string, source: string): EnqueueSite[] {
  const sites: EnqueueSite[] = [];
  for (const match of source.matchAll(TEMPLATE_VALUE)) {
    const payload = enclosingObject(source, match.index);
    if (!payload) continue;
    const lineStart = source.slice(0, match.index).split('\n').length - 1;
    const above = source
      .split('\n')
      .slice(Math.max(0, lineStart - LINES_ABOVE), lineStart)
      .join('\n');
    sites.push({ file, template: match[1]!, payload, window: `${above}\n${payload}` });
  }
  return sites;
}

interface Violation {
  file: string;
  template: string;
  problem: string;
}

/** The two rules, over one source string. `allowRequestRead` narrows the
 *  request-read check to each site's window. */
function checkSource(file: string, source: string, allowRequestRead = false): Violation[] {
  const violations: Violation[] = [];
  const sites = findEnqueueSites(file, source).filter(
    (s) => !EXEMPT_STAFF_TEMPLATES.includes(s.template),
  );
  for (const site of sites) {
    if (!LOCALE_PROPERTY.test(site.payload)) {
      violations.push({
        file,
        template: site.template,
        problem:
          'no recipient language — put `locale: await resolveRecipientLocale(...)` ' +
          '(or a `resolveRecipientLocales` lookup) in the payload’s `data`',
      });
    }
    const readsRequest = allowRequestRead
      ? REQUEST_READ.test(site.window)
      : REQUEST_READ.test(source);
    if (readsRequest) {
      violations.push({
        file,
        template: site.template,
        problem:
          'reads the REQUEST’s language (`currentLocale` / `next/headers` / `serverLocale`) — ' +
          'resolve the RECIPIENT’s with `resolveRecipientLocale(...)` instead',
      });
    }
  }
  return violations;
}

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.tsx?$/.test(full)) files.push(full);
  }
  return files;
}

/** Every `lib/` source file, as a path relative to the repository root. */
function libFiles(): Array<{ file: string; source: string }> {
  const root = process.cwd();
  return walk(join(root, 'lib')).map((full) => ({
    file: relative(root, full),
    source: readFileSync(full, 'utf8'),
  }));
}

function senderFiles() {
  return libFiles().filter(({ file }) => !NOT_SENDERS.some((p) => file.startsWith(p)));
}

function realSites(): EnqueueSite[] {
  return senderFiles().flatMap(({ file, source }) => findEnqueueSites(file, source));
}

function realViolations(): Violation[] {
  return senderFiles().flatMap(({ file, source }) =>
    checkSource(file, source, file in REQUEST_READ_ALLOWLIST),
  );
}

const describeViolations = (vs: Violation[]) =>
  vs.map((v) => `  ${v.file}: ${v.template} — ${v.problem}`).join('\n');

describe('the scanner', () => {
  it('finds a deliberately non-compliant fixture, and the real enqueue sites (positive control)', () => {
    const fixture = `await sendEvent('email.send', { to, template: 'mention-notification', data: { excerpt } });`;
    expect(findEnqueueSites('fixture.ts', fixture).map((s) => s.template)).toEqual([
      'mention-notification',
    ]);
    // A wrong root or a regex that matches nothing would make every rule below
    // vacuously green — so the real tree must yield every non-exempt template.
    const found = new Set(realSites().map((s) => s.template));
    const nonExempt = Object.keys(EMAIL_TEMPLATE_CLASS).filter(
      (t) => !EXEMPT_STAFF_TEMPLATES.includes(t),
    );
    expect([...found].filter((t) => nonExempt.includes(t)).length).toBe(
      Object.keys(EMAIL_TEMPLATE_CLASS).length - EXEMPT_STAFF_TEMPLATES.length,
    );
  });

  it('reports a payload with no language, naming the template and the fix', () => {
    const violations = checkSource(
      'fixture.ts',
      `sendEvent('email.send', { to, template: 'mention-notification', data: { excerpt } })`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'fixture.ts', template: 'mention-notification' });
    expect(violations[0]!.problem).toContain('resolveRecipientLocale');
  });

  it('accepts a payload carrying a language, explicit or shorthand', () => {
    for (const data of ['{ excerpt, locale: localeByUserId.get(id) }', '{ excerpt, locale, }']) {
      expect(
        checkSource(
          'fixture.ts',
          `sendEvent('email.send', { to, template: 'mention-notification', data: ${data} })`,
        ),
      ).toEqual([]);
    }
  });

  it('is not fooled by the word in a comment', () => {
    const source = `sendEvent('email.send', {
      to,
      template: 'mention-notification',
      // TODO: add the locale here
      data: { excerpt },
    })`;
    expect(checkSource('fixture.ts', source)).toHaveLength(1);
  });

  it('reports a payload that reads the request’s language', () => {
    const inline = `sendEvent('email.send', { to, template: 'two-factor-otp', data: { code, locale: await currentLocale() } })`;
    expect(checkSource('fixture.ts', inline).map((v) => v.problem)).toEqual([
      expect.stringContaining('REQUEST'),
    ]);
  });

  it('reports a file that imports the request reader and holds an enqueue site', () => {
    for (const imp of [
      `import { headers } from 'next/headers';`,
      `import { currentLocale } from '@/lib/i18n/serverLocale';`,
    ]) {
      const source = `${imp}
      export async function send() {
        await sendEvent('email.send', { to, template: 'two-factor-otp', data: { code, locale } });
      }`;
      expect(checkSource('fixture.ts', source).map((v) => v.problem)).toEqual([
        expect.stringContaining('REQUEST'),
      ]);
    }
  });

  it('ignores the TYPE form `template: …;` of the union', () => {
    expect(findEnqueueSites('types.ts', `| { template: 'password-reset'; data: X }`)).toEqual([]);
  });
});

describe('every sender in lib/ supplies the recipient’s language', () => {
  it('every enqueue site puts `locale` on its payload, and none reads the request', () => {
    const violations = realViolations();
    expect(
      violations,
      `email senders breaking the rule:\n${describeViolations(violations)}`,
    ).toEqual([]);
  });

  it('no template escapes the scan — each non-exempt template has a recognisable sender', () => {
    const found = new Set(realSites().map((s) => s.template));
    const missing = Object.keys(EMAIL_TEMPLATE_CLASS).filter(
      (t) => !EXEMPT_STAFF_TEMPLATES.includes(t) && !found.has(t),
    );
    expect(
      missing,
      `templates with no \`template: '<name>',\` sender in lib/ — write the name literally in ` +
        `the payload object that carries \`locale\`, so this guard can see it:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the exempt set is empty — no staff-only template ships today', () => {
    expect([...EXEMPT_STAFF_TEMPLATES]).toEqual([]);
  });

  it('the request-read allowlist names only files that are real enqueue sites', () => {
    const siteFiles = new Set(realSites().map((s) => s.file));
    for (const file of Object.keys(REQUEST_READ_ALLOWLIST)) expect(siteFiles).toContain(file);
  });
});

describe('the render path stays off-request', () => {
  it('templates, the email service, the resolver and the send job read no request', () => {
    const hits = libFiles().filter(
      ({ file, source }) =>
        RENDER_PATH.some((p) => file.startsWith(p)) && REQUEST_READ.test(source),
    );
    expect(hits.map((h) => h.file)).toEqual([]);
    // Control: the render path was actually walked.
    expect(libFiles().some(({ file }) => file.startsWith(RENDER_PATH[0]!))).toBe(true);
  });
});

describe('what is NOT a sender', () => {
  it('the subscribe route RECORDS a language and is outside the scanned roots', () => {
    const route = join('app', 'api', 'public', 'p', '[identifier]', 'subscribe', 'route.ts');
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    expect(source).toMatch(/currentLocale/);
    expect(findEnqueueSites(route, source)).toEqual([]);
    expect(realSites().some((s) => s.file === route)).toBe(false);
  });

  it('seedDefaultWorkflow reads the request language for workflow names and is not reported', () => {
    const file = join('lib', 'services', 'workflowsService.ts');
    expect(readFileSync(join(process.cwd(), file), 'utf8')).toMatch(/currentLocale/);
    expect(realViolations().some((v) => v.file === file)).toBe(false);
  });
});
