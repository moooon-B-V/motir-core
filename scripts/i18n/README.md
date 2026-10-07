# Translating the catalogues

`messages/en.json` is the source. Every other `messages/<locale>.json` is a
translation of it, and `messages/sources/<locale>.json` records, key by key, the
English each translation was made from. `messages/glossary/<locale>.json` fixes
the product's terms and the register for that language (see its README).

The script calls no model. It cuts the work into batch files, an agent or a
person fills them in, and the script checks what comes back before it writes a
single string into a catalogue.

## The loop

```sh
pnpm i18n:status                      # every locale: current / missing / stale / untracked / orphan
pnpm i18n:extract --locale ja         # writes .i18n-work/ja/batch-NNN.json (git-ignored)
# fill each batch file's "target" object, key for key, from its "source"
pnpm i18n:merge --locale ja           # checks every entry, writes messages/ja.json + messages/sources/ja.json
pnpm i18n:status --locale ja --check  # exits 1 while anything is missing, stale or orphaned
```

Run `merge` again after fixing what it rejected. A batch can be merged more than
once, and an entry already merged is not rewritten.

### extract

Writes the keys that need work: **missing** (en has it, the catalogue does not)
and **stale** (the recorded English differs from today's). Each batch carries
the glossary rendered as instructions, the English `source`, the `previous`
translation of a stale key, and an empty `target`.

- `--batch-size N` — keys per batch (default 150). An array, such as a billing
  tier's feature list, is never split across two batches.
- `--namespaces a,b,c` — only keys under these top-level namespaces.
- `--include-untracked` — also write keys translated before the record existed,
  for a review pass over an old catalogue.

### merge

Refuses an entry, and names it, when:

- the key is not in `en.json`, or the batch's `source` is no longer today's
  English (re-extract);
- it is not a key the batch was entitled to change;
- it breaks the ICU shape of its source — the same arguments of the same kind,
  the same select options, plural branches valid for the language, the same tags
  nested the same way (`messageShape.ts`);
- a glossary term marked `doNotTranslate` is not kept verbatim, or a term the
  glossary keeps in Latin script is translated.

A glossary's banned word is a warning, not a refusal, because some are right in
another sense (a payment card is a card). Orphans are dropped from both files.
Exit code 1 when anything was refused.

### baseline

`pnpm i18n:baseline --locale zh --confirm` records today's English as the source
of every **untracked** key. That asserts every one of those translations already
says what the English says now — a reviewer's judgement, which is why it needs
`--confirm`.

## The gates

- `tests/i18n-message-shape.test.ts` — every committed translation keeps its
  source's shape. Old debt is listed in `KNOWN_SHAPE_DEBT` and can only shrink.
- `tests/i18n-source-record.test.ts` — every record matches its catalogue, and
  every catalogue has one, except a locale in `UNTRACKED_LOCALES` (that list can
  only shrink too). Commit `messages/<l>.json` and `messages/sources/<l>.json`
  together. A stale key does not fail it; `pnpm i18n:status` reports staleness.
