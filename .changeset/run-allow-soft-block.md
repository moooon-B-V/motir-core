---
'@motir/cli': minor
---

`motir run <key> --allow-soft-block` runs a work item held only by an
ancestor's block (a SOFT block) and still refuses one with its own open blocker
(a HARD block, which only `--force` passes). On a leaf it dispatches the
soft-blocked item with one line naming the ancestor it overrode. On a story it
refuses a story whose own blocker is open, and otherwise builds the scope from
the ready read with `allowSoftBlock=true`, so the children held only by the
story's ancestor chain are claimed and worked. Without the flag, the not-ready
refusal's hint now names `--allow-soft-block` for a soft block and `--force` for
a hard one. `--allow-soft-block` together with `--force` is refused as
redundant; `motir next`, `motir auto` and `motir batch` do not take the flag
(MOTIR-6355).
