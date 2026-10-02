---
'@motir/cli': patch
---

`motir fix`'s acceptance Re-run closing turn now checks the checkout before publishing (MOTIR-7254). Where the repository's acceptance lane carries the `upload-acceptance-video` action — motir-core, and projects generated from the starter — CI's green pull-request run publishes the receipt, so the agent makes no MCP publish and reports that the lane published. Anywhere else it re-records and publishes over MCP exactly as before.
