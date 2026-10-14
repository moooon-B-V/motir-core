---
'@motir/design-system': patch
---

`renderMock` no longer copies style rules its markup cannot match into a mock (MOTIR-8565). Tailwind compiles a utility only for a class the markup carries, but it copies every plain rule of `theme.css` through whole, so since 0.14.0 every mock carried the four StyleVignette canvas rules (`.style-vignette[data-style='…'] > .sv-canvas`) whether or not it rendered a vignette, and motir-core's design guard failed it for declaring rules no element carries. A rule is now dropped when every selector in it needs a class the markup lacks. A class inside `:not()`, `:is()` or `:where()` does not count as needed, `@layer utilities` is left alone, and a mock that renders the component keeps its rules.
