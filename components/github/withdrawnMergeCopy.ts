import type { ApprovalGateSupersedeCauseDTO } from '@/lib/dto/approvalGate';
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// STATE `G` OF THE MERGE GATE SAYS WHY — AND ONLY PROMISES WHAT CAN HAPPEN (Bug MOTIR-5884;
// `design/github/design-notes.md` § 29, its cause table and its cite table).
//
// ⚠️ A PURE RESOLVER, NOT A COMPONENT, and directive-free on purpose: it answers WHICH
// message keys band 1's meta, the withdrawn sentence and its cite read, so every row of
// § 29's two tables is a plain assertion rather than a render. The frame turns the keys
// into words.
//
// ⚠️ `member_closed` IS SPLIT BY THE ROWS, NOT BY A NEW STORED CAUSE (§ 29 decision 5). A
// merge made with the host's own button and a pull request closed without merging are both
// written `member_closed`, and the rows the block already draws say which one happened. A
// superseded gate is never the result of Motir's own merge — an approval decides the gate
// before it merges — so a MERGED member under one was merged outside a Motir decision.
//
// ⚠️ A NULL OR `unknown` CAUSE NEVER BORROWS ONE FROM THE ROWS' SHAPE. A moved head beside
// a row with no recorded cause is not evidence that a push withdrew the question, and the
// shared frame already refuses to infer (`ApprovalGateControl`'s `withdrawnSentence`).

/** A message the frame renders: WHICH namespace, which key, and the values it takes. */
export interface WithdrawnMessage {
  /** `pra` = `approvalGate.pullRequestApproval`; `gate` = the shared `approvalGate`. */
  scope: 'pra' | 'gate';
  key: string;
  values: Record<string, string | number>;
}

export interface WithdrawnMergeCopy {
  meta: WithdrawnMessage;
  sentence: WithdrawnMessage;
  cite: WithdrawnMessage;
}

/** One member of the withdrawn set, as the Development block draws its row. `null` state:
 *  the block has no row for it (it was unlinked). */
export interface WithdrawnMember {
  name: string;
  state: LinkedPullRequestDto['state'] | null;
  /** The host reports this member conflicted at its head (MOTIR-5916). Absent = no. */
  conflicted?: boolean;
  /** The branch it targets, for `{base}`; null when the row never recorded one. */
  baseRef?: string | null;
}

const pra = (key: string, values: Record<string, string | number> = {}): WithdrawnMessage => ({
  scope: 'pra',
  key,
  values,
});
const gate = (key: string, values: Record<string, string | number> = {}): WithdrawnMessage => ({
  scope: 'gate',
  key,
  values,
});

export function withdrawnMergeCopy({
  cause,
  members,
  moved,
  terminal,
  itemIdentifier,
  host,
  nameList,
}: {
  cause: ApprovalGateSupersedeCauseDTO | null;
  members: readonly WithdrawnMember[];
  /** The members whose head a push moved since the gate was raised, by name. */
  moved: readonly string[];
  /** The card sits in a DONE-category status — nothing will ask again, whatever the cause. */
  terminal: boolean;
  itemIdentifier: string;
  /** The host's display name, as *Open on {host}* renders it. */
  host: string;
  /** The shipped *a, b and c* joiner, so a sentence names two members the way band 3 does. */
  nameList: (names: string[]) => string;
}): WithdrawnMergeCopy {
  const count = members.length;
  const open = members.filter((m) => m.state === 'open');
  // The cite that promises a re-ask on green — true only while something is left to ask about.
  const reask = open.length > 0 ? pra('withdrawn.portCite') : gate('withdrawn.portCite');
  const unrecorded = (sharedCause: ApprovalGateSupersedeCauseDTO) => ({
    meta: pra('meta.withdrawnUnknown', { count }),
    sentence: gate(`withdrawn.cause.${sharedCause}`),
    cite: gate('withdrawn.portCite'),
  });

  const copy = ((): WithdrawnMergeCopy => {
    switch (cause) {
      case 'head_moved': {
        if (moved.length === 0) {
          // The cause is known and no member can be named: the shared sentence says a push
          // moved the commits, which is exactly what is known.
          return { ...unrecorded('head_moved'), cite: reask };
        }
        const pr = nameList([...moved]);
        return {
          meta: pra('meta.withdrawn', { count, pr }),
          sentence: pra('withdrawn.port', { pr }),
          cite: reask,
        };
      }
      case 'set_changed':
        return {
          meta: pra('meta.withdrawnSet', { count }),
          sentence: pra('withdrawn.portSet'),
          cite: reask,
        };
      case 'member_closed': {
        // A closed-unmerged member BLOCKS the re-ask (MOTIR-5901's ADR amendment keeps it
        // blocking), so where one exists it is the member the reader must act on, and the
        // only true cite is the one that says how.
        const closed = members.filter((m) => m.state === 'closed').map((m) => m.name);
        if (closed.length > 0) {
          const pr = nameList(closed);
          return {
            meta: pra('meta.withdrawnClosed', { count, pr }),
            sentence: pra('withdrawn.portClosed', { pr }),
            cite:
              open.length > 0
                ? pra('withdrawn.citeUnlink', { pr, key: itemIdentifier })
                : gate('withdrawn.portCite'),
          };
        }
        const merged = members.filter((m) => m.state === 'merged').map((m) => m.name);
        if (merged.length > 0) {
          const pr = nameList(merged);
          return {
            meta: pra('meta.withdrawnMerged', { count, pr, host }),
            sentence: pra('withdrawn.portMerged', { pr, host }),
            // A merged member is SETTLED (MOTIR-5901): the open ones are asked about on green.
            cite: reask,
          };
        }
        return unrecorded('member_closed');
      }
      case 'member_drafted': {
        // ⚠️ THE ROWS CARRY NO DRAFT FLAG, AND DELIBERATELY: `github_pull_request.draft` has
        // ONE reader by design (MOTIR-5002 — the schema's own note), and the Development
        // surface is named among those that must go on reading a draft as an ordinary OPEN
        // pull request. So the drafted member is DEDUCED, not read: a draft is open, and when
        // exactly one member is open it is the one that went back to draft. With two or more
        // open, naming one would be a guess, and the shared sentence says what is known.
        if (open.length !== 1) return unrecorded('member_drafted');
        const pr = open[0]!.name;
        return {
          meta: pra('meta.withdrawnDrafted', { count, pr }),
          sentence: pra('withdrawn.portDrafted', { pr }),
          cite: pra('withdrawn.citeDrafted', { pr }),
        };
      }
      case 'conflict': {
        // A CONFLICT FOUND BEFORE ANY PRESS (MOTIR-5916; design/github § 30 Panels 1, 2
        // and 7). The conflicted member is READ off its row — the stored mergeability, not
        // a deduction — so band 1, the sentence and the pill all name the same member. No
        // conflicted row left (it resolved and was pushed since) says only what the cause
        // records.
        const conflicted = members.filter((m) => m.conflicted === true);
        if (conflicted.length === 0) return unrecorded('conflict');
        const pr = nameList(conflicted.map((m) => m.name));
        // `{base}` only when every conflicted member names the SAME one; otherwise each row
        // names its own and the band says *its base branch* (§ 30's copy note).
        const bases = new Set(conflicted.map((m) => m.baseRef ?? null));
        const base = bases.size === 1 ? [...bases][0]! : null;
        return base !== null
          ? {
              meta: pra('meta.withdrawnConflict', { count, pr, base }),
              sentence: pra('withdrawn.portConflict', { pr, base }),
              cite: pra('withdrawn.citeConflict'),
            }
          : {
              meta: pra('meta.withdrawnConflictNoBase', { count, pr }),
              sentence: pra('withdrawn.portConflictNoBase', { pr }),
              cite: pra('withdrawn.citeConflict'),
            };
      }
      case 'ci_failed':
        // A RED BUILD AT THE ASKED-ABOUT COMMITS (MOTIR-6271). The members carry no CI
        // verdict on this row — `WithdrawnMember` is what the Development block draws, and
        // the pill is rendered from the delivery's own `ciState` beside it — so the sentence
        // says what the CAUSE records and names nobody. The cite is the RE-ASK one while a
        // member is still open, and that promise is exact here: a push fixing the build
        // raises a fresh gate on its next green, which is the whole point of withdrawing
        // rather than leaving the question standing over a commit that failed.
        return { ...unrecorded('ci_failed'), cite: reask };
      case 'pulled_back':
        return {
          meta: pra('meta.withdrawnPulledBack', { count }),
          sentence: gate('withdrawn.cause.pulled_back'),
          cite: pra('withdrawn.citePulledBack', { key: itemIdentifier }),
        };
      default:
        // `unknown`, a null cause, and the two DESIGN causes a merge gate is never written
        // with: say what the row recorded, and promise nothing.
        return unrecorded(cause ?? 'unknown');
    }
  })();

  // A card in a done-category status asks nothing again, whatever the cause (§ 29's cite
  // table, second row): the cite says only that nobody decided it.
  return terminal ? { ...copy, cite: gate('withdrawn.portCite') } : copy;
}
