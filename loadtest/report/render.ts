// report.md AND report.json (Story MOTIR-8538 · MOTIR-8679).
//
// The order of report.md is the order a reader needs: the what-answered header, the
// `comparable` block, the verdict, the threshold lines, the refusal and proxy_shed
// readings, the first bottleneck with every candidate, then the supporting tables.
// report.json carries the same as structured fields. An absent value prints
// `unmeasured`.

import type { Candidate, FirstBottleneck, StatementDelta, WaitHoldRow } from './bottleneck';
import { CANDIDATE_LABELS } from './bottleneck';
import type { Line, Measures } from './thresholds';
import type { P2028Reading } from './p2028';
import type { ProxyShed } from './proxyShed';
import type { Reading } from './inputs';

/** A markdown table cell: backslashes first, then the pipe that would end the cell. */
const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
export const VERDICTS = ['PASS', 'FAIL', 'UNMEASURED', 'INVALID'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const CONCURRENCY_SENTENCE =
  "Staging's proxy limits are raised for the load test (1200 hard at the default profile) and are not production's (250), so a PASS says nothing about the production proxy limit — that is the sizing task's.";
export const CLOCK_SENTENCE =
  'Window times are the generator clock and Prometheus timestamps are Fly’s; skew is not measured, so every Prometheus range is widened by ±30 s.';

export interface GeneratorLoad {
  status: 'ok' | 'saturated' | 'unmeasured';
  mean: number | null;
  peak: number | null;
  reason: string | null;
}

export interface Report {
  verdict: Verdict;
  verdictReasons: string[];
  exitCode: number;
  servedRps: number | null;
  header: Record<string, unknown> & {
    profile: { name: string; path: string; loadHash: string };
    app: { name: string; size: string };
  };
  comparable: Record<string, unknown>;
  lines: Line[];
  measures: Measures;
  p2028: P2028Reading;
  proxyShed: ProxyShed;
  generator: GeneratorLoad;
  bottleneck: { first: FirstBottleneck; candidates: Candidate[]; caveats: string[] };
  tables: {
    routes: Reading<{ route: string; rps: number; p95: number | null; p99: number | null }[]>;
    waitHold: Reading<WaitHoldRow[]>;
    statements: StatementDelta;
  };
  crossChecks: string[];
}

const r2 = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? 'unmeasured'
    : String(Math.round(n * 100) / 100);
const show = (v: unknown): string =>
  v === null || v === undefined
    ? 'unmeasured'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);

function readingLine<T>(r: Reading<T>, fmt: (v: T) => string): string {
  return r.state === 'ok' ? fmt(r.value) : `unmeasured — ${r.reason}`;
}

export function renderMarkdown(r: Report): string {
  const h = r.header;
  const out: string[] = [];
  out.push(`# Load-test report — ${h.profile.name} at N = ${show(h['instances'])}`, '');
  out.push(
    `**Verdict: ${r.verdict}**${r.verdictReasons.length ? ` — ${r.verdictReasons.join('; ')}` : ''}`,
    '',
  );

  out.push('## What answered', '');
  for (const [k, v] of Object.entries(h)) out.push(`- **${k}**: ${show(v)}`);
  out.push('', `> ${CONCURRENCY_SENTENCE}`, '', `> ${CLOCK_SENTENCE}`, '');

  out.push('### Comparable', '', '```json', JSON.stringify(r.comparable, null, 2), '```', '');

  out.push(
    '## Thresholds',
    '',
    '| line | status | measured | limit | note |',
    '|---|---|---|---|---|',
  );
  for (const l of r.lines) {
    const note = [l.reason, l.annotation].filter(Boolean).join(' — ');
    out.push(`| ${l.name} | ${l.status} | ${l.value} | ${l.limit} | ${cell(note)} |`);
  }
  const g = r.generator;
  out.push(
    '',
    `Generator CPU over the steady window: mean ${r2(g.mean)}, peak ${r2(g.peak)} — ${g.status}${g.reason ? ` (${g.reason})` : ''}.`,
    '',
  );

  out.push('## P2028', '');
  const p = r.p2028;
  out.push(
    `P2028: ${p.total === null || p.status === 'unmeasured' ? 'unmeasured' : p.total} — ${p.status}${p.reason ? ` (${p.reason})` : ''}`,
  );
  for (const i of p.instances)
    out.push(
      `- ${i.instance}: p2028_wait ${show(i.p2028_wait)}, p2028_timeout ${show(i.p2028_timeout)}, committed rose ${show(i.committedRise)}${i.reason ? ` — unmeasured: ${i.reason}` : ''}`,
    );
  out.push(
    `- log cross-check: ${p.logs.state}, ${p.logs.total} line(s)${p.logs.reason ? ` (${p.logs.reason})` : ''}${p.logs.disagrees ? ' — DISAGREES with the platform count' : ''}`,
  );
  for (const [inst, halves] of Object.entries(p.logs.byInstance))
    out.push(`  - ${inst}: p2028_wait ${halves.p2028_wait}, p2028_timeout ${halves.p2028_timeout}`);
  out.push('', `> ${p.blindSpot}`, '');

  out.push('## Rate-limit refusals', '');
  const ref = r.lines.find((l) => l.key === 'perInstance.rateLimitedMax');
  out.push(
    `${ref?.status ?? 'unmeasured'}: ${ref?.value ?? 'unmeasured'} (limit ${ref?.limit ?? '?'})`,
    '',
  );

  out.push('## proxy_shed (a reading, not judged)', '');
  out.push(
    `- platform 503s by instance: ${readingLine(
      r.proxyShed.platform,
      (v) =>
        Object.entries(v)
          .map(([k, n]) => `${k} ${show(n)}`)
          .join(', ') || 'none',
    )}`,
    `- proxy log codes: ${readingLine(r.proxyShed.logCodes, (v) => `PL01 ${v.PL01}, PL02 ${v.PL02}, PR01 ${v.PR01}`)}`,
    `- client http_503: ${readingLine(r.proxyShed.client503, (v) => String(v))}`,
    '',
    '> None of the three says who answered: Fly documents no header that marks a proxy-made response.',
    '',
  );

  out.push('## First bottleneck', '');
  const f = r.bottleneck.first;
  out.push(
    f.kind === 'candidate'
      ? `**${CANDIDATE_LABELS[f.name]}**, saturated from ${f.onset}`
      : f.kind === 'unattributed'
        ? `**unattributed** — worst route by p95: ${f.worstRouteByP95}; highest wait/hold p95: ${f.worstWaitRoute}; top statement by total-time delta: ${f.topStatement}`
        : '**no resource saturated**',
    '',
  );
  for (const c of r.bottleneck.candidates) {
    const onset = c.state === 'saturated' ? `from ${new Date(c.onset!).toISOString()}` : c.state;
    out.push(
      `- ${CANDIDATE_LABELS[c.name]}: ${onset}; peak ${c.peak}${c.reason ? ` — ${c.reason}` : ''}`,
    );
    for (const b of c.beside) out.push(`  - ${b}`);
  }
  for (const c of r.bottleneck.caveats) out.push('', `> ${c}`);
  out.push('');

  out.push('## Per route (steady window)', '');
  if (r.tables.routes.state === 'ok') {
    out.push('| route | rps | p95 ms | p99 ms |', '|---|---|---|---|');
    for (const row of r.tables.routes.value)
      out.push(`| ${row.route} | ${r2(row.rps)} | ${r2(row.p95)} | ${r2(row.p99)} |`);
  } else out.push(`unmeasured — ${r.tables.routes.reason}`);
  out.push('', '## Wait and hold (seconds)', '');
  if (r.tables.waitHold.state === 'ok') {
    out.push(
      '| by | name | wait p95 | wait p99 | hold p95 | hold p99 |',
      '|---|---|---|---|---|---|',
    );
    for (const w of r.tables.waitHold.value)
      out.push(
        `| ${w.by} | ${w.name} | ${r2(w.waitP95)} | ${r2(w.waitP99)} | ${r2(w.holdP95)} | ${r2(w.holdP99)} |`,
      );
  } else out.push(`unmeasured — ${r.tables.waitHold.reason}`);
  out.push('', '## Top statements by total-time delta', '');
  const s = r.tables.statements;
  if (s.state === 'ok') {
    out.push('| Δ total ms | Δ calls | statement |', '|---|---|---|');
    for (const row of s.top)
      out.push(
        `| ${r2(row.totalMsDelta)} | ${row.callsDelta} | \`${cell(row.query.slice(0, 200)).replace(/`/g, "'")}\` |`,
      );
    out.push('', `entered the top 200: ${s.entered.length}; left it: ${s.left.length}`);
  } else out.push(`unmeasured — ${s.reason}`);
  if (r.crossChecks.length)
    out.push('', '## Cross-checks', '', ...r.crossChecks.map((c) => `- ${c}`));
  out.push('');
  return out.join('\n');
}

export function renderJson(r: Report): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}
