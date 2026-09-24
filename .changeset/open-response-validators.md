---
'@motir/cli': patch
---

The CLI no longer rejects a response because the server added a field it does
not know. Every command reading a response shape that had grown a field since
the CLI was built failed with "Unexpected response … must NOT have additional
properties". Since `difficulty` shipped, that included `motir link` and
everything else that reads the ready set. Missing fields and wrong types are
still reported.
