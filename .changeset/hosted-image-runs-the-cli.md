---
'@motir/cli': minor
---

A hosted run indexes every checkout it clones with codegraph before the agent starts, and the hosted image now runs the CLI itself (MOTIR-6560). The container's entrypoint is a launcher for `motir run` (or `motir continue`) on the run the server opened, so a leaf, a leaf that spans several repositories and a parent all run hosted exactly as they do locally. The image carries `motir`, `gh`, git ≥ 2.36, the pinned OpenCode and codegraph, and no credential. The hosted `gh` shim now resolves a checkout's repository from its configured remote URL, not one rewritten by `url.insteadOf`.
