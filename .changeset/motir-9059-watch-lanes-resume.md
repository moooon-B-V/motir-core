---
'@motir/cli': patch
---

`motir auto`, `motir batch` and `motir fix` now repair a red pull request in the conversation that built the card (MOTIR-9059). Each card's own session is handed to its CI watch, so in a multi-card run card N's fix lands in card N's conversation; a card that recorded no session keeps today's fresh-agent fix.
