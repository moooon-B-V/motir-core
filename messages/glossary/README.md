# Catalogue glossaries

One file per language, holding the **terms** every catalogue in that language
is translated under. `messages/en.json` is the source of truth for what the app
says; these files fix **which words** each language uses for Motir's own nouns,
so the person adding a key next year writes the same word the catalogue already
uses. (Story MOTIR-7730 · MOTIR-7744.)

| file                                                                                      | what it is                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ja.json` `ko.json` `de.json` `fr.json` `es.json` `it.json` `nl.json` `pl.json` `pt.json` | the glossaries for the nine languages added by MOTIR-7730 (`pt` is Brazilian Portuguese)                                        |
| `zh.json`                                                                                 | the **reference column**: the terms `messages/zh.json` already uses, each cited by key path. It records; it decides nothing new |

The files live in this subdirectory on purpose: catalogues are addressed as
`messages/${locale}.json`, and `tsconfig.json` includes `messages/*.json`, so a
file here is never mistaken for a catalogue.

## The file shape

The catalogue script (`scripts/i18n/`) loads and validates exactly this shape:

```json
{
  "locale": "ja",
  "register": { "formality": "…", "quotes": "「」", "note": "…" },
  "terms": {
    "work item": {
      "translation": "…",
      "banned": ["…"],
      "allowedSenses": "…",
      "source": "<url or product + surface>",
      "note": "…"
    },
    "Motir": { "translation": "Motir", "doNotTranslate": true }
  }
}
```

- `locale` equals the file name.
- `register` records the formality, the quotation marks, and how punctuation,
  a sentence-final `…` and a `{placeholder}` in running text are written.
- `terms` is keyed by the English term, and **every file carries the same key
  set**. Each term has a `translation` and a `source` saying where it was
  checked; `note` says why, and says so when no reference could be reached.

## The rules every catalogue follows

- **Never translated, in any language:** `Motir`, `Motir AI` (both
  `doNotTranslate`), and `Sprint`, which stays in Latin script everywhere —
  including Japanese and Korean, whose Jira write スプリント / 스프린트. That is a
  recorded decision, not an oversight.
- **The product noun is "work item"** — one term per language — and **never**
  that language's word for "issue" or "card". Each file's `work item.banned`
  lists those words. "Card" stays correct for a **payment card** and a **UI
  panel**; `allowedSenses` says so.
- **A new catalogue key is translated under these terms.** When you add a key
  to `messages/en.json`, its ten translations use the words recorded here. If a
  term is missing or wrong, change it here first, in the same pull request, and
  say why in its `note`.
