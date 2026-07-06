import { describe, expect, it } from 'vitest';
import {
  CsvTokenizer,
  parseCsvRecords,
  parseCsvRecordsFromStream,
  parseCsvRows,
} from '@/lib/import/csv/parseCsv';

// Unit tests for the tolerant, incremental RFC-4180 CSV parser (MOTIR-1501).
// Pure string work — no DB.

function rows(text: string): string[][] {
  return Array.from(parseCsvRows(text));
}

describe('parseCsvRows — RFC-4180 tokenizer', () => {
  it('parses simple rows', () => {
    expect(rows('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with embedded delimiters', () => {
    expect(rows('id,title\n1,"hello, world"')).toEqual([
      ['id', 'title'],
      ['1', 'hello, world'],
    ]);
  });

  it('handles embedded newlines inside quotes', () => {
    expect(rows('id,body\n1,"line one\nline two"')).toEqual([
      ['id', 'body'],
      ['1', 'line one\nline two'],
    ]);
  });

  it('handles escaped doubled quotes', () => {
    expect(rows('id,title\n1,"she said ""hi"""')).toEqual([
      ['id', 'title'],
      ['1', 'she said "hi"'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(rows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('ignores a trailing newline (no empty final row)', () => {
    expect(rows('a\n1\n')).toEqual([['a'], ['1']]);
  });

  it('skips fully-blank lines', () => {
    expect(rows('a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a trailing empty field (trailing delimiter)', () => {
    expect(rows('a,b,\n1,2,')).toEqual([
      ['a', 'b', ''],
      ['1', '2', ''],
    ]);
  });

  it('flushes a final row not terminated by a newline', () => {
    expect(rows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('tolerates malformed text after a closing quote', () => {
    // `"ab"c` → best-effort: keep both.
    expect(rows('h\n"ab"c')).toEqual([['h'], ['abc']]);
  });

  it('supports a custom delimiter', () => {
    expect(Array.from(parseCsvRows('a;b\n1;2', ';'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseCsvRecords — header→value records', () => {
  it('maps rows to records keyed by header, with 1-based data line', () => {
    const recs = Array.from(parseCsvRecords('id,title\n7,First\n8,Second'));
    expect(recs).toEqual([
      { values: { id: '7', title: 'First' }, line: 1, columnCount: 2 },
      { values: { id: '8', title: 'Second' }, line: 2, columnCount: 2 },
    ]);
  });

  it('pads missing cells and reports the raw column count for ragged rows', () => {
    const recs = Array.from(parseCsvRecords('a,b,c\n1,2'));
    expect(recs[0]!.values).toEqual({ a: '1', b: '2', c: '' });
    expect(recs[0]!.columnCount).toBe(2);
  });

  it('trims header names', () => {
    const recs = Array.from(parseCsvRecords(' id , title \n1,x'));
    expect(recs[0]!.values).toEqual({ id: '1', title: 'x' });
  });
});

describe('CsvTokenizer — chunk boundaries', () => {
  it('parses a quoted field split across chunks', () => {
    const tok = new CsvTokenizer();
    const out: string[][] = [];
    for (const r of tok.push('id,body\n1,"one')) out.push(r);
    for (const r of tok.push(' two"\n2,x')) out.push(r);
    for (const r of tok.end()) out.push(r);
    expect(out).toEqual([
      ['id', 'body'],
      ['1', 'one two'],
      ['2', 'x'],
    ]);
  });
});

describe('parseCsvRecordsFromStream — async chunk stream', () => {
  it('parses records from an async iterable of chunks', async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield 'id,title\n1,';
      yield 'Hello\n2,';
      yield 'World';
    }
    const recs = [];
    for await (const r of parseCsvRecordsFromStream(chunks())) recs.push(r);
    expect(recs).toEqual([
      { values: { id: '1', title: 'Hello' }, line: 1, columnCount: 2 },
      { values: { id: '2', title: 'World' }, line: 2, columnCount: 2 },
    ]);
  });
});
