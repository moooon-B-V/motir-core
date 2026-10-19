---
'@motir/cli': minor
---

`motir fix` in your own agent now continues the card's last session (MOTIR-9052). When the card's last run was in the same agent and recorded a session, the repair resumes that conversation instead of starting a fresh agent, prints one line saying so, and falls back to a fresh agent once if the resume fails. A repair in your own agent now answers a red CI or a failed acceptance re-run as well as a review.
