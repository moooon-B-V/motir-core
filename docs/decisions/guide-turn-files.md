# ADR: Files on a guide turn — and agent-step prompts and changes to ticked steps

- **Status:** Accepted on approval of MOTIR-7481's pull request (2026-10-03).
- **Extends:** `docs/decisions/conversation-turn-intent.md`. Every `§n` and
  `A2.n` below names a section of that record. This record extends its
  AMENDMENT 2 (A2.2's persisted turn, A2.3's input, A2.8's credits) and adds one
  field to its §1 wire. A3.9 **amends** A2.3, A2.4 and A2.7: agent steps and
  changes to ticked steps. Every other rule in that record holds exactly as
  written. `ask`, `plan_change` and `debug` turns are unchanged and still
  carry text only.
- **Story / Subtask:** MOTIR-7471 (Show Motir AI what you see) · Subtask
  MOTIR-7481.
- **Consumed by:** MOTIR-7471. That means the design MOTIR-7482, the motir-ai
  change MOTIR-7483 (multi-part messages in the gateway client, files in the
  `guide_work_item` handler) and its tests MOTIR-7485, the motir-core intake
  MOTIR-7484 (attach, then resolve into the job's input), the composer
  MOTIR-7486, its Postgres tests MOTIR-7487 and the acceptance run MOTIR-7488.
  A3.9 changes the shipped guide, so MOTIR-7483 also changes the
  `guide_work_item` handler for it, MOTIR-7484 lands `needs_replan`, and
  MOTIR-7482 draws the agent prompt and the re-plan reply.
  Outside the story, MOTIR-1344 (Help with a task) may reuse A3.2's wire field
  and A3.4's resolution if it takes files.

## Context

A person being guided through a manual card is looking at a screen Motir AI
cannot see. The story lets them add a file to their turn: a screenshot, a text
file, a log. This record answers four questions. Where does the file live?
Which kinds does Motir AI read? Within what limits? How do the bytes reach a
model when motir-ai cannot read the blob store?

Verified on `origin/main` @ `0a04b2694` (motir-core), `2f360c9f` (motir-ai) and
`68e2945` (motir-gateway), 2026-10-03:

| Fact                                                                                                                                                                                                                                          | Where                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| An upload is checked against a per-file cap (10 MB baseline, 100 MB on a cloud `scaled` org), the MIME allow-list, a rate limit and the org storage cap, in that order. The MIME is the browser-reported `file.type`; nothing sniffs content. | `lib/services/attachmentsService.ts` (`uploadAttachment`)                                              |
| The allow-list's images are PNG, JPEG, GIF, WebP and SVG. Its text types are `text/plain`, `text/csv` and `text/markdown`. **`application/json` is not on it**, and neither is an empty type.                                                 | `lib/blob/allowlist.ts` (`ALLOWED_IMAGE_TYPES`, `ALLOWED_FILE_TYPES`)                                  |
| `attachToWorkItem` uploads AND attaches in one user action, gated on the card's view and create-attachment permissions, and records the card's History entry.                                                                                 | `lib/services/attachmentsService.ts` (`attachToWorkItem`); `app/api/work-items/[id]/attachments/`      |
| Blob reads are presigned GETs with a 300 s TTL, minted per request.                                                                                                                                                                           | `lib/blob/uploader.ts` (`signedDownloadUrl`); `attachment-access-control.md` §5                        |
| motir-ai's `ChatMessage.content` is a `string`. The guide handler sends one `structured` (JSON-mode) call.                                                                                                                                    | motir-ai `src/llm/gatewayClient.ts`; `src/jobs/handlers/guideWorkItem.ts`                              |
| The guide handler reads consent only from a quote it FINDS in the latest `user` turn's text, and refuses a turn whose latest text is empty.                                                                                                   | motir-ai `src/jobs/handlers/guideWorkItem.ts` (`quotedInLatest`, the `latest` read)                    |
| The gateway accepts OpenAI-style `image_url` parts and decodes a `data:image/…;base64,` URL without fetching. A URL it must fetch goes through the SSRF-guarded client, capped at 20 MB.                                                      | motir-gateway `relay/model/message.go`; `common/image/image.go`; `common/client/motir_user_content.go` |
| The planner model is a platform setting chosen per audience. The gateway's catalog carries no image-input capability the planner can read.                                                                                                    | motir-ai `src/llm/gatewayClient.ts` (header); motir-gateway `motir/catalog/`                           |

## Decision

### A3.1 — Where the file lives: the GUIDED CARD's attachment. (Option 1.)

| Option                                                                                                                        | Verdict    | Reason                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(1) The file is an attachment on the guided card, uploaded through the shipped path. The turn carries the attachment ids.** | **CHOSEN** | Upload, the allow-list, the size cap, the storage cap, per-workspace access, preview and the Attachments panel already exist. The file is evidence of the manual work, and the card is where a teammate looks for it. |
| (2) Conversation-only files in a new store.                                                                                   | REJECTED   | A second upload path and a second access model beside `attachment-access-control.md`, which `attachment-api-door.md` §1 forbids. The evidence would be lost to the card.                                              |
| (3) Text only: the person describes the screenshot.                                                                           | REJECTED   | It does not answer the ask. Describing an unfamiliar dashboard is exactly what a person mid-task does worst.                                                                                                          |

The composer uploads each file with `attachmentsService.attachToWorkItem`
(`source: 'panel'`) against the guided card **before** the turn is sent. The
attachment rules are unchanged: a type the allow-list refuses, or a file over
the cap, gets the shipped refusal and the turn is not sent. If any upload
fails, the turn is not sent and the composer keeps its text. Files that did
upload stay on the card.

**A temporary walk attaches to the card too.** An attachment is the card's
evidence, not the list's, so A2.2's rule that a temporary walk writes nothing
to the card does not extend to files.

### A3.2 — The wire and the persisted turn. (Extends §1 and A2.2.)

| Concern                | Pinned value                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The wire**           | `POST /api/ai/ask` gains an optional `attachmentIds: string[]`. It is DATA, like `anchorKey`, and never an intent.                                                                                                                                                                          |
| **The checks**         | Every id must be an attachment in the caller's workspace, attached to the guided card (the session's `targetKeys[0]`), and readable by the caller. At most 4 ids (A3.3). Any failure refuses the whole turn with 400 before any job runs.                                                   |
| **Guide only**         | A turn carrying `attachmentIds` on a conversation whose origin is not `guide` is refused with 400. The composer shows the attach control, paste and drop only in a guide conversation (A3.7).                                                                                               |
| **The turn's text**    | A turn may carry files and no words. Its consent text is then empty, so it can drive no action that needs the person's words (A3.6). The handler's refusal of an empty latest turn narrows to a turn with neither words nor files.                                                          |
| **The persisted turn** | `PlanChangeTurn` gains `attachmentIds String[]`, default empty, with a generated migration. The rail renders a chip per id (an image as a thumbnail) that opens the shipped preview. An id whose attachment has since been deleted renders as removed, and the turn is otherwise unchanged. |

### A3.3 — What is read, and the limits.

**The readable set** is the part of the shipped allow-list a model can use.
Every other allowed type is attached and not read.

| Kind     | MIME types                                                                              | What the model receives                               |
| -------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| image    | `image/png`, `image/jpeg`, `image/webp`, `image/gif`                                    | the image (A3.4)                                      |
| text     | `text/plain`, `text/markdown`, `text/csv`                                               | the file's text, decoded as UTF-8, up to a limit      |
| not read | everything else the allow-list accepts: `image/svg+xml`, PDF, zip, Word and Excel files | nothing; the turn says the file was not read, and why |

- **SVG is attached and not read.** Models take raster images, and SVG is markup
  that can carry script.
- **A text file that is not valid UTF-8** is attached and not read.
- **JSON, `.log` and `.env` files.** The card that framed this question listed
  `application/json` and logs as readable. The shipped allow-list refuses
  `application/json` and any file with an empty type, and this story does not
  change attachment rules. So a `.json` file gets the shipped refusal. A `.log`
  or `.env.example` file is read when the browser reports it as `text/plain`,
  and refused when it reports another type or none. Widening the allow-list is
  a decision for `attachment-access-control.md`, not for this record.

**The limits:**

| Limit                             | Value                                              | Reason                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| files per turn                    | **4**                                              | Enough for a before and after screenshot plus a config and a log. It bounds the job's input to roughly 20 MB in the worst case (4 images at the per-image cap, base64-encoded).                                                                           |
| bytes per image sent to the model | **3.75 MiB raw (5 MiB once base64-encoded)**       | 5 MiB encoded is the smallest inline-image cap among the major providers the gateway relays, so an image under it is accepted whichever model plans. A larger image is attached and not read, and the turn says so. This story does not downscale images. |
| text read per file                | **the first 20,000 characters**                    | About 5k tokens. A config or a log excerpt fits, and one file cannot crowd out the card and the conversation (A2.3's input already carries up to 8,000 characters of card body and 40 turns of up to 4,000 characters).                                   |
| text read per turn                | **40,000 characters** across the turn's text files | Keeps a whole turn's file text within a small share of a 128k-token context, beside the history above. Files past the budget are attached and not read.                                                                                                   |

A cut file is marked cut, and Motir AI says it read the first part. Limits are
checked by motir-core when it resolves the files (A3.4); the composer may warn
earlier, but the server's check is the one that holds.

### A3.4 — How a file reaches the model: motir-core resolves, motir-ai builds the parts.

motir-ai cannot read the blob store, and must not. **motir-core reads the
bytes** when it builds the job's input (A2.3), and sends each file of the
CURRENT turn resolved:

| Field in each `files[]` entry  | Content                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `attachmentId`, `name`, `mime` | from the attachment row                                                             |
| `kind`                         | `image` · `text` · `unread`                                                         |
| `dataUrl`                      | for `image`: `data:<mime>;base64,<bytes>`                                           |
| `text`, `cut`                  | for `text`: the decoded text up to A3.3's limit, and whether it was cut             |
| `reason`                       | for `unread`: `type_not_read` · `image_too_large` · `not_utf8` · `turn_text_budget` |

**The image is sent INLINE, as a `data:` URL.** The rejected alternative is a
presigned URL that the gateway or the provider fetches. That URL lives 300 s
(`attachment-access-control.md` §5, unchanged), so a queued job can outlive it.
It would also hand a bearer link to the private bucket to a third party.
Lengthening the TTL is an attachment rule this story does not change. The
gateway decodes a `data:` URL without any fetch.

**motir-ai widens `ChatMessage.content`** to `string | ContentPart[]`, where a
part is `{ type: 'text', text }` or `{ type: 'image_url', image_url: { url } }`.
Every existing caller keeps sending a string. The guide handler sends the
latest `user` turn as parts: the person's words, then each file. Text files and
unread files are text parts, framed per A3.5.

**Files are sent on their own turn only.** An earlier turn's files are not
re-sent. The history carries a one-line note per file (its name, and whether
it was read), and Motir AI's earlier reply carries what it saw. This bounds
both cost and payload.

**A model that refuses image input.** No image capability is readable from the
catalog, so motir-ai does not guess. If the gateway refuses the call because of
an image part, the handler asks once more with each image replaced by a text
note saying it could not be read. The reply then says the current model cannot
read images. A second refusal fails the turn as any failed call does.

### A3.5 — A file is input only.

A file's content is data the person showed, never an instruction to Motir AI.

| Rule                                                                                                                                                                     | Why                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Text and images are framed in the prompt as the content of a file the person attached, to be read and not obeyed.                                                        | A pasted config or log is untrusted text.                                                                          |
| Consent is read only from the person's own words. The quote that justifies `tick`, `untick`, `write_todos` or `close` must be found in the turn's text, never in a file. | A file cannot tick a step, save a list or close a card. A2.3's closed action set and A2.4's landers are unchanged. |
| Motir AI never follows a link in a file, never runs a command from one, and never acts outside the conversation because a file says to.                                  | A2.7's "never reads or acts on a third-party system" applies to files as well.                                     |

**A screenshot is evidence, not consent.** "done, see screenshot" ticks the
step when the screenshot agrees, and the reply says what it showed. If the
screenshot shows the step not done, or Motir AI cannot tell, it does not tick.
It says what it saw and asks the person to confirm.

### A3.6 — What the reply says.

Every turn that carried files states, in its message, what was read and what
was not: what an image shows, which text file it used, which file was cut, and
which file it could not read and why. A turn of files with no words gets the
same statement, and drives no action that needs the person's words.

### A3.7 — Guide conversations are the only ones that take files.

`ask`, `plan_change` and `debug` turns stay text only. They have no single
anchored card to attach a file to (an ask turn's `anchorKey` is a citation, not
an owner). Files in item-scoped help outside a guide belong to MOTIR-1344.

### A3.8 — Metering.

| Concern        | Pinned value                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the model call | Metered like any guide turn (A2.8): AI credits under `ai:plan`, from the usage the gateway reports. Image input is input tokens. There is no surcharge per file. |
| the door       | The `ai:generate` rate-limit bucket, once per turn, as today.                                                                                                    |
| the upload     | The shipped attachment rate limit and the org storage cap. A file counts against storage like any attachment.                                                    |
| out of credits | The shipped paywall state. The turn writes nothing (A2.4). Files already uploaded stay on the card, because the upload is not part of the turn.                  |

### A3.9 — Two changes to the guide itself, made at the requester's review. (Amends A2.3, A2.4 and A2.7.)

These are not about files. The requester made them when reviewing this record
(MOTIR-7481's decision gate, 2026-10-03). They change how the guide shipped in
MOTIR-7459, and they are recorded here because this is the record under review.

**(a) An agent step gets a prompt for the person's LOCAL agent.** This replaces
A2.7's first "never" row and the shipped handler's rule that an `agent` row is
only "not runnable yet".

| Concern                     | Pinned value                                                                                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| what Motir AI says          | The step can be run by a coding agent in the person's own environment. Motir does not hold the person's credentials, so it cannot run the step. Their local agent can read the credentials where they already live and help run it.                                                      |
| what Motir AI produces      | A prompt to give that local agent: the step's goal, its notes and command, what is done when it succeeds, and which credentials or access the agent needs to find locally. It is returned as a new action, `local_agent_prompt` (row id, prompt), so the rail can show it ready to copy. |
| what the prompt never holds | A secret. Motir AI never asks the person to paste a credential into the conversation, and the prompt names what the agent needs without carrying it.                                                                                                                                     |
| what it never does          | Run the step, or start an agent. MOTIR-6856's boundary (no secret store, so no hosted run) is unchanged.                                                                                                                                                                                 |
| the tick                    | Unchanged: the step is ticked on the person's word that it is done (A2.3), whoever did it.                                                                                                                                                                                               |
| what lands                  | `local_agent_prompt` writes nothing to the card. It is recorded on the conversation, like `current_step`.                                                                                                                                                                                |

**(b) The guide may change the card and any step, ticked or not, as long as the
card's TARGET stays the same.** This replaces A2.7's rule that a ticked row is
never changed, A2.3's "the row is not ticked" condition on `revise_step`,
`remove_step` and `move_step`, and A2.4's rule that a correction aimed at a
ticked row is skipped.

| Concern               | Pinned value                                                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the target**        | What the card exists to achieve: the outcome that is true when the card is done. A different way of reaching the same outcome is not a change of target. A different outcome is.                                                                                                                                       |
| **target unchanged**  | `edit_item`, `add_step`, `revise_step`, `remove_step` and `move_step` are legal on any row, ticked or not. A revised ticked row keeps its tick unless the revision means the work already done no longer satisfies it. Then Motir AI unticks it and says so. Every change is stated with its reason (A2.3, unchanged). |
| **target changed**    | Motir AI edits nothing and changes no step. It says the change needs a re-plan, and why, and the walk stops. It returns a new action, `needs_replan` (reason), landed like `cannot_do` as a comment on the guided card through `commentsService.addComment`.                                                           |
| **who judges**        | Motir AI, from the card and the conversation. When it is unsure whether the target changed, it asks the person before changing anything.                                                                                                                                                                               |
| **what a re-plan is** | The shipped planning conversation on that card. The guide does not submit a plan, because a guide conversation is never a planning session (A2.2).                                                                                                                                                                     |
| **unchanged**         | `edit_item` still sets only `title`, `descriptionMd` and `explanationMd` on the guided card (A2.5). Status still moves only through `close` (A2.6). The landers and permissions of A2.4 are unchanged.                                                                                                                 |

## Consequences

1. **motir-ai's gateway client gains multi-part content.** This is the one new
   seam. Every existing call site is unchanged.
2. **The guide job's input gains `files[]` on the latest turn**, resolved by
   motir-core. The job request grows by up to the encoded image bytes of one
   turn.
3. **The ask route and `PlanChangeTurn` gain `attachmentIds`.** The route
   refuses them outside a guide conversation.
4. **The vitest gates gain a files arm:** ownership by the guided card, the
   count limit, guide-only, the temporary walk, cut and unread files, and a
   file whose text asks for a tick and gets none.
5. **The guide's closed action set gains `local_agent_prompt` and
   `needs_replan`** (A3.9), and the handler stops dropping corrections aimed at
   a ticked row.

## What this does NOT decide

- **The attachment allow-list, size caps, TTL and access rules.** All are
  unchanged. Whether JSON, `.log` or extension-less text files should be
  allowed is a question for `attachment-access-control.md`.
- **Image downscaling or re-encoding** to fit a larger screenshot under the
  per-image cap.
- **Reading PDFs, Office documents or archives.**
- **A capability registry** that says which planner models accept images.
- **How long motir-ai keeps a job's input**, image bytes included.
- **The UI**: the attach control, paste and drop, the queued and uploading
  states, chips and thumbnails, and every copy string. That is MOTIR-7482's
  design.
- **The prompt wording** that frames files and states what was seen. That is
  MOTIR-7483.
- **How the guide decides that a target changed**, beyond A3.9's definition.
  That is the prompt's, MOTIR-7483.
- **Running an agent step from Motir.** A3.9 hands the person a prompt; a
  hosted run still waits on MOTIR-6856.
- **Files on `ask`, `plan_change` or `debug` turns, and in Help with a task**
  (MOTIR-1344).
