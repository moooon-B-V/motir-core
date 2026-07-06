// A tolerant, INCREMENTAL RFC-4180 CSV parser (Story 7.16 · MOTIR-1501).
//
// Real-world exports are messy — quoted fields, embedded newlines, doubled
// quotes (`""` → `"`), CRLF or LF line endings, ragged column counts, a
// trailing newline. This parser handles all of them and NEVER throws on a bad
// row: a malformed field is tolerated (best-effort), so a single bad row is a
// per-row concern for the caller, not a whole-file abort (the card's "clear
// per-row errors, no all-rows-at-once" contract).
//
// It is INCREMENTAL by construction: `CsvTokenizer` is a state machine you feed
// chunks to, `yield`ing each COMPLETE row as soon as its terminating newline
// arrives — it never requires the whole file up front (so it composes with a
// chunked upload stream via {@link parseCsvRecordsFromStream}). The convenience
// `parseCsvRecords(text)` wraps it for the common already-in-memory string.
//
// Pure string work — no DB, no I/O, no Prisma.

/** One parsed data row as a header→value record, plus provenance for per-row
 *  error messages and a ragged-column signal. */
export interface CsvRecord {
  /** header column name → cell value (missing cells → ''). */
  values: Record<string, string>;
  /** 1-based data-row line (the header is not counted). */
  line: number;
  /** The raw field count of this row (to flag a header-mismatch). */
  columnCount: number;
}

const DEFAULT_DELIMITER = ',';

type State = 'FIELD_START' | 'IN_UNQUOTED' | 'IN_QUOTED' | 'AFTER_QUOTE';

/**
 * Incremental CSV tokenizer. Feed it text with `push(chunk)` (repeatable) and
 * finish with `end()`; each yields the rows completed so far. State survives
 * across chunk boundaries, so a quoted field spanning two chunks parses
 * correctly.
 */
export class CsvTokenizer {
  private state: State = 'FIELD_START';
  private field = '';
  private row: string[] = [];
  /** True once the current row has accumulated any field content, so a bare
   *  blank line (just a newline) is skipped rather than emitted as `['']`. */
  private rowStarted = false;
  private readonly delimiter: string;

  constructor(delimiter: string = DEFAULT_DELIMITER) {
    this.delimiter = delimiter;
  }

  private endField(): void {
    this.row.push(this.field);
    this.field = '';
    this.rowStarted = true;
  }

  private takeRow(): string[] | null {
    if (!this.rowStarted && this.field === '' && this.row.length === 0) {
      // Purely blank line — skip.
      return null;
    }
    this.endField();
    const row = this.row;
    this.row = [];
    this.rowStarted = false;
    this.state = 'FIELD_START';
    return row;
  }

  *push(chunk: string): Generator<string[]> {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      switch (this.state) {
        case 'FIELD_START':
          if (ch === '"') {
            this.state = 'IN_QUOTED';
            this.rowStarted = true;
          } else if (ch === this.delimiter) {
            this.endField();
          } else if (ch === '\n') {
            const row = this.takeRow();
            if (row) yield row;
          } else if (ch === '\r') {
            // ignore — CRLF handled on the '\n'
          } else {
            this.field += ch;
            this.state = 'IN_UNQUOTED';
            this.rowStarted = true;
          }
          break;

        case 'IN_UNQUOTED':
          if (ch === this.delimiter) {
            this.endField();
            this.state = 'FIELD_START';
          } else if (ch === '\n') {
            const row = this.takeRow();
            if (row) yield row;
          } else if (ch === '\r') {
            // ignore
          } else {
            this.field += ch;
          }
          break;

        case 'IN_QUOTED':
          if (ch === '"') {
            this.state = 'AFTER_QUOTE';
          } else {
            // Inside quotes, everything is literal — including delimiters and
            // newlines.
            this.field += ch;
          }
          break;

        case 'AFTER_QUOTE':
          if (ch === '"') {
            // Escaped quote ("") → a literal quote, still inside the field.
            this.field += '"';
            this.state = 'IN_QUOTED';
          } else if (ch === this.delimiter) {
            this.endField();
            this.state = 'FIELD_START';
          } else if (ch === '\n') {
            const row = this.takeRow();
            if (row) yield row;
          } else if (ch === '\r') {
            // ignore
          } else {
            // Malformed (text after a closing quote) — tolerate: continue the
            // field unquoted.
            this.field += ch;
            this.state = 'IN_UNQUOTED';
          }
          break;
      }
    }
  }

  /** Flush any final row not terminated by a trailing newline. */
  *end(): Generator<string[]> {
    if (
      this.state === 'IN_QUOTED' ||
      this.state === 'AFTER_QUOTE' ||
      this.rowStarted ||
      this.field !== ''
    ) {
      const row = this.takeRow();
      if (row) yield row;
    }
  }
}

/** Turn a stream of raw rows into header→value records (first row = header).
 *  Shared by the sync + async entry points. */
function* rowsToRecords(rows: Iterable<string[]>): Generator<CsvRecord> {
  let header: string[] | null = null;
  let line = 0;
  for (const row of rows) {
    if (header === null) {
      header = row.map((h) => h.trim());
      continue;
    }
    line++;
    const values: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      values[header[i] || `col${i}`] = row[i] ?? '';
    }
    yield { values, line, columnCount: row.length };
  }
}

/**
 * Parse an in-memory CSV string into RAW rows (header row included), streaming
 * row-by-row via the incremental tokenizer. The lowest-level string entry point
 * — callers that need the header separately from the data rows use this.
 */
export function* parseCsvRows(
  text: string,
  delimiter: string = DEFAULT_DELIMITER,
): Generator<string[]> {
  const tok = new CsvTokenizer(delimiter);
  yield* tok.push(text);
  yield* tok.end();
}

/**
 * Parse an in-memory CSV string into records, streaming row-by-row (a lazy
 * generator — it does NOT build an array of every row). The first row is the
 * header; each subsequent row becomes a `{ header → value }` record.
 */
export function* parseCsvRecords(
  text: string,
  delimiter: string = DEFAULT_DELIMITER,
): Generator<CsvRecord> {
  yield* rowsToRecords(parseCsvRows(text, delimiter));
}

/**
 * Parse a CHUNKED upload stream (an async iterable of string chunks — e.g. a
 * `ReadableStream` decoded to text) into records without ever holding the whole
 * file. The incremental tokenizer emits each row as its newline arrives.
 */
export async function* parseCsvRecordsFromStream(
  chunks: AsyncIterable<string>,
  delimiter: string = DEFAULT_DELIMITER,
): AsyncGenerator<CsvRecord> {
  const tok = new CsvTokenizer(delimiter);
  let header: string[] | null = null;
  let line = 0;

  const emit = function* (row: string[]): Generator<CsvRecord> {
    if (header === null) {
      header = row.map((h) => h.trim());
      return;
    }
    line++;
    const values: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      values[header[i] || `col${i}`] = row[i] ?? '';
    }
    yield { values, line, columnCount: row.length };
  };

  for await (const chunk of chunks) {
    for (const row of tok.push(chunk)) yield* emit(row);
  }
  for (const row of tok.end()) yield* emit(row);
}
