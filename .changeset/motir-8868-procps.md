---
'@motir/cli': patch
---

The sandbox images now ship `procps`, so `ps` is on the PATH and Codex's background app-server can start in a hosted agent (MOTIR-8868). Before this, every `codex` after a successful `codex login --device-auth` exited with `failed to invoke ps for pid-managed app server`. The fix merged in #3644 without a changeset, so it was never released; this patch release publishes it. Agents created from an earlier image keep that image, so create a new Codex agent to get it.
