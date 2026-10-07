import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareMessageShape } from '../scripts/i18n/messageShape';
import { flattenCatalogue } from '../scripts/i18n/sourceRecord';

// MOTIR-7745 — every translated string keeps the ICU shape of its English
// source: the same arguments, of the same kind, the same select options, plural
// branches valid for the target language, and the same rich-text tags nested
// the same way. `pnpm i18n:merge` refuses a batch entry that breaks one; this is
// the standing gate over what is already committed, so a hand edit to a
// catalogue meets the same check.
//
// The locales are found by LISTING `messages/`, never by naming them, so a new
// catalogue is checked the moment it lands. A plural branch is judged against
// the TARGET locale's CLDR categories, so Japanese with only `other` and Polish
// with `few` / `many` both pass when they are right for the language.

const ROOT = process.cwd();
const MESSAGES = join(ROOT, 'messages');

/** Every catalogue except the English source, by directory listing. */
function targetLocales(): string[] {
  return readdirSync(MESSAGES)
    .filter((f) => /^[a-z]{2,3}(-[A-Za-z0-9]+)?\.json$/.test(f) && f !== 'en.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function load(locale: string) {
  return flattenCatalogue(JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8')));
}

/**
 * Committed strings that break the shape today, keyed `<locale>:<key>`. Every
 * row is a zh string written before this gate existed — almost all of them a
 * plural flattened to a bare `{count}`, which Chinese reads fine but which
 * drops the branch structure the source carries. MOTIR-7781 corrects zh's
 * drift and shrinks this list. Asserted TIGHT in both directions: an unlisted
 * violation fails, and a listed row that no longer violates fails too, so the
 * list can only shrink.
 */
const KNOWN_SHAPE_DEBT: Record<string, string> = {
  'zh:planReview.itemCount': '{n} is simple but the source has plural',
  'zh:planReview.staleSummary': '{n} is simple but the source has plural',
  'zh:planReview.approveCta': '{n} is simple but the source has plural',
  'zh:planReview.approveHintStale': '{n} is simple but the source has plural',
  'zh:planReview.approveHintFolderMissing': '{n} is simple but the source has plural',
  'zh:planReview.discardConfirmBody': '{n} is simple but the source has plural',
  'zh:planReview.approvedOutcome': '{n} is simple but the source has plural',
  'zh:planReview.liveAnnounce': '{count} is simple but the source has plural',
  'zh:planReview.staleConfirmBody': '{n} is simple but the source has plural',
  'zh:email.twoFactorOtp.expires': '{minutes} is simple but the source has plural',
  'zh:email.followDigest.subject': '{count} is simple but the source has plural',
  'zh:email.followDigest.lede': '{count} is simple but the source has plural',
  'zh:email.organizationDeletionReminder.subject': '{daysLeft} is simple but the source has plural',
  'zh:email.organizationDeletionReminder.lede': '{daysLeft} is simple but the source has plural',
  'zh:email.agentsDeletionScheduled.agents': '{count} is simple but the source has plural',
  'zh:auth.twoFactor.emailSent.expiry': '{minutes} is simple but the source has plural',
  'zh:issueViews.removeConfirmBefore': 'missing {relationship}',
  'zh:issueViews.removeConfirmAfter': 'invented {relationship}',
  'zh:issueViews.quickViewMoreFields': '{count} is simple but the source has plural',
  'zh:settings.members.migration.count': '{count} is simple but the source has plural',
  'zh:settings.members.projectCount': '{count} is simple but the source has plural',
  'zh:settings.access.memberCountLabel': '{count} is simple but the source has plural',
  'zh:settings.access.membersOnlyConfirmBody': '{count} is simple but the source has plural',
  'zh:settings.access.visitors.countLabel': '{count} is simple but the source has plural',
  'zh:settings.publicAddress.rename.remaining': '{count} is simple but the source has plural',
  'zh:settings.publicAddress.domains.addModal.recordsHeading':
    '{count} is simple but the source has plural',
  'zh:settings.codeAccess.setLabel': '{count} is simple but the source has plural',
  'zh:settings.codeAccess.expand': '{count} is simple but the source has plural',
  'zh:settings.codeAccess.expandPartial': '{count} is simple but the source has plural',
  'zh:settings.codeAccess.self.body': '{count} is simple but the source has plural',
  'zh:settings.codeAccess.empty.connectedBody': '{count} is simple but the source has plural',
  'zh:settings.account.twoFactor.methods.email.descOn':
    '{minutes} is simple but the source has plural',
  'zh:settings.account.twoFactor.recovery.low': '{remaining} is simple but the source has plural',
  'zh:settings.account.twoFactor.regenerate.body':
    '{remaining} is simple but the source has plural',
  'zh:settings.apiTokens.expiresIn': '{days} is simple but the source has plural',
  'zh:ready.nudge.approved': '{count} is simple but the source has plural',
  'zh:backlog.selectionBarLabel': '{count} is simple but the source has plural',
  'zh:backlog.selectedCount': '{count} is simple but the source has plural',
  'zh:backlog.aiPlan.stepRead': '{count} is simple but the source has plural',
  'zh:backlog.aiPlan.reviewSub':
    '{sprints} is simple but the source has plural; {items} is simple but the source has plural',
  'zh:backlog.aiPlan.lengthDays': '{days} is simple but the source has plural',
  'zh:backlog.aiPlan.approve': '{count} is simple but the source has plural',
  'zh:backlog.aiPlan.sprintRegionLabel': '{count} is simple but the source has plural',
  'zh:backlog.aiPlan.doneTitle': '{count} is simple but the source has plural',
  'zh:backlog.aiPlan.doneBody': '{items} is simple but the source has plural',
  'zh:orgAdmin.menu.workspacesCount': '{count} is simple but the source has plural',
  'zh:orgAdmin.settings.workspacesSummary': '{count} is simple but the source has plural',
  'zh:orgAdmin.settings.membersSummary': '{count} is simple but the source has plural',
  'zh:orgAdmin.settings.workspaceConfigSub':
    "plural {count} has one, outside zh\'s categories (other)",
  'zh:orgAdmin.settings.workspaceConfigBadge': '{count} is simple but the source has plural',
  'zh:orgAdmin.members.count': '{count} is simple but the source has plural',
  'zh:orgAdmin.seat.count': '{n} is simple but the source has plural',
  'zh:orgAdmin.delete.workspaces':
    '{workspaces} is simple but the source has plural; {projects} is simple but the source has plural',
  'zh:orgAdmin.delete.members': '{count} is simple but the source has plural',
  'zh:orgAdmin.delete.hostedRepos': '{count} is simple but the source has plural',
  'zh:orgAdmin.scheduled.body': '{daysLeft} is simple but the source has plural',
  'zh:workItemActions.deleteCascadeCount': '{count} is simple but the source has plural',
  'zh:workItemActions.deleteLiveWarningBody': '{count} is simple but the source has plural',
  'zh:workItemActions.deleteAllArchivedRow': '{count} is simple but the source has plural',
  'zh:workItemActions.deleteConfirmCascade': '{count} is simple but the source has plural',
  'zh:workItemActions.kindEpic': '{count} is simple but the source has plural',
  'zh:workItemActions.kindStory': '{count} is simple but the source has plural',
  'zh:workItemActions.kindTask': '{count} is simple but the source has plural',
  'zh:workItemActions.kindBug': '{count} is simple but the source has plural',
  'zh:workItemActions.kindSubtask': '{count} is simple but the source has plural',
  'zh:github.development.fix.sentBack': 'missing {count}',
  'zh:github.development.fix.gaveUp.title': '{attempts} is simple but the source has plural',
  'zh:github.development.fix.sentBackByAgent': 'missing {count}',
  'zh:github.development.fix.personSentBack': 'missing {count}',
  'zh:github.development.fix.personSentBackAnon': 'missing {count}',
  'zh:planningWorkspace.closeGuard.title': '{count} is simple but the source has plural',
  'zh:planningWorkspace.guide.files.attaching': '{count} is simple but the source has plural',
  'zh:planningWorkspace.guide.files.reading': '{count} is simple but the source has plural',
  'zh:designResult.mockCount': '{count} is simple but the source has plural',
  'zh:workbench.toFix.reason.runDiedMoreRepositories':
    '{count} is simple but the source has plural',
  'zh:workbench.toFix.entry.carriesRun': '{count} is simple but the source has plural',
  'zh:workbench.toFix.entry.carriesPullRequests': '{count} is simple but the source has plural',
  'zh:workbench.toFix.entry.showMore': '{count} is simple but the source has plural',
  'zh:workbench.toResume.waiting': '{count} is simple but the source has plural',
  'zh:platformAdmin.monitoring.stopped.behind': '{n} is simple but the source has plural',
  'zh:platformAdmin.monitoring.stopped.duration.days': '{n} is simple but the source has plural',
  'zh:platformAdmin.monitoring.fleet.orgs.runningCount':
    '{count} is simple but the source has plural',
  'zh:platformAdmin.lessons.filter.count': '{n} is simple but the source has plural',
  'zh:platformAdmin.lessons.window.impact': '{n} is simple but the source has plural',
  'zh:platformAdmin.ops.status.active':
    '{members} is simple but the source has plural; {workspaces} is simple but the source has plural',
  'zh:platformAdmin.tenant.fleet.confirm.ci':
    'missing {runs}; {containers} is simple but the source has simple/plural',
  'zh:platformAdmin.tenant.fleet.confirm.ciUnknown':
    '{containers} is simple but the source has simple/plural',
  'zh:platformAdmin.tenant.fleet.confirm.hosted': 'missing {count}',
  'zh:platformAdmin.tenant.fleet.confirm.instances': 'missing {count}',
  'zh:platformAdmin.tenant.fleet.confirm.index': 'missing {count}',
  'zh:platformAdmin.tenant.fleet.result.ci':
    '{runs} is simple but the source has plural; {stopped} is simple but the source has plural',
  'zh:platformAdmin.tenant.fleet.result.hosted': '{ended} is simple but the source has plural',
  'zh:platformAdmin.tenant.fleet.result.instances':
    '{hibernated} is simple but the source has plural',
  'zh:platformAdmin.runModels.inUse.projects': '{n} is simple but the source has plural',
  'zh:platformAdmin.runModels.remove.inUseParts.projects':
    '{n} is simple but the source has plural',
  'zh:platformAdmin.ideas.detail.sources': '{n} is simple but the source has plural',
  'zh:platformAdmin.ideas.edit.refused': '{n} is simple but the source has plural',
  'zh:runs.hosted.notReady': '{count} is simple but the source has plural',
  'zh:runs.hosted.refused.notWritable.leadNoTotal': '{count} is simple but the source has plural',
  'zh:runs.hosted.cost.creditsValue': '{count} is number but the source has plural',
  'zh:runs.start.notReady': '{count} is simple but the source has plural',
  'zh:runs.agent.refused.notReady.body': '{count} is simple but the source has plural',
  'zh:code.repositories.drift.commits': '{count} is simple but the source has plural',
  'zh:approvalGate.acceptanceResult.verdict.rerun.consequence': 'missing {count}',
  'zh:approvalGate.pullRequestApproval.meta.count': '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.delivered':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.approved':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.approvedByYou':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawn':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnSet':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnMerged':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnClosed':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnDrafted':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnPulledBack':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnUnknown':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnConflict':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnConflictNoBase':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.meta.withdrawnQueueFailed':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.confirm.records':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.record.commits':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.github.meta.approved':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.reasked.meta': '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.reasked.earlier':
    '{count} is simple but the source has plural',
  'zh:approvalGate.pullRequestApproval.reasked.confirm.newApproval':
    '{count} is simple but the source has plural',
  'zh:approvalGate.decision.headMeta.one': '{count} is simple but the source has plural',
  'zh:approvalGate.decision.headMeta.oneNoRun': '{count} is simple but the source has plural',
  'zh:approvalGate.decision.headMeta.none': '{count} is simple but the source has plural',
  'zh:approvalGate.decision.headMeta.noneNoRun': '{count} is simple but the source has plural',
  'zh:approvalGate.decision.headMeta.several': '{count} is simple but the source has plural',
  'zh:approvalGate.decision.headMeta.severalNoRun': '{count} is simple but the source has plural',
  'zh:approvalGate.choice.meta': '{count} is simple but the source has plural',
  'zh:approvalGate.decisionConfirm.record.detail': '{count} is simple but the source has plural',
  'zh:approvalGate.decisionConfirm.row.overturned': '{count} is simple but the source has plural',
  'zh:approvalGate.planApproval.row.details': '{count} is simple but the source has plural',
  'zh:approvalGate.agentReview.run.started': '{count} is simple but the source has plural',
  'zh:approvalGate.agentReview.run.decided': '{count} is simple but the source has plural',
  'zh:approvalGate.agentReview.run.decidedNoRun': '{count} is simple but the source has plural',
  'zh:approvalGate.agentReview.run.commits': '{count} is simple but the source has plural',
  'zh:approvalGate.agentReview.sentBack.record': '{count} is simple but the source has plural',
  'zh:approvalGate.agentReview.override.bandNote': '{count} is simple but the source has plural',
  'zh:folders.deleteMoves':
    '{folders} is simple but the source has plural; {items} is simple but the source has plural; {pages} is simple but the source has plural',
  'zh:monitoring.confirm.one.body': 'missing {count}',
  'zh:monitoring.picker.partial': '{attempted} is simple but the source has simple/plural',
  'zh:monitorErrors.seen': '{count} is number but the source has number/plural',
  'zh:monitorErrors.candidate': '{count} is number but the source has number/plural',
  'zh:visitor.shell.rateLimitedBody': '{seconds} is simple but the source has plural',
  'zh:toFix.banner.carries': '{count} is simple but the source has plural',
  'zh:pages.archive.confirm.title': '{count} is simple but the source has plural',
  'zh:pages.archive.confirm.impact': '{total} is simple but the source has plural',
  'zh:pages.archive.confirm.action': '{total} is simple but the source has plural',
  'zh:pages.archive.archived': '{count} is simple but the source has plural',
  'zh:pages.archive.banner.withSubPages': '{count} is simple but the source has plural',
  'zh:pages.archive.restored': '{count} is simple but the source has plural',
  'zh:pages.archive.delete.body': '{count} is simple but the source has plural',
  'zh:pages.archive.delete.impact': '{total} is simple but the source has plural',
  'zh:pages.archive.delete.action': '{total} is simple but the source has plural',
  'zh:pages.archive.delete.deleted': '{count} is plural/simple but the source has plural',
  'zh:pages.archive.list.subPages': '{count} is simple but the source has plural',
};

function violations(): Map<string, string> {
  const en = load('en');
  const found = new Map<string, string>();
  for (const locale of targetLocales()) {
    const target = load(locale);
    for (const [key, source] of en) {
      const translated = target.get(key);
      if (translated === undefined) continue;
      const v = compareMessageShape(source, translated, locale);
      if (v.length) found.set(`${locale}:${key}`, v.map((x) => x.detail).join('; '));
    }
  }
  return found;
}

describe('i18n message shape (MOTIR-7745)', () => {
  it('checks every catalogue in messages/, zh among them', () => {
    const locales = targetLocales();
    expect(locales).toContain('zh');
    expect(locales).not.toContain('en');
  });

  it('every translated string keeps its English source shape, apart from the listed debt', () => {
    const found = violations();
    const unlisted = [...found].filter(([k]) => !(k in KNOWN_SHAPE_DEBT));
    expect(unlisted.map(([k, d]) => `${k}: ${d}`)).toEqual([]);
  });

  it('every KNOWN_SHAPE_DEBT row still violates (the list only shrinks)', () => {
    const found = violations();
    const fixed = Object.keys(KNOWN_SHAPE_DEBT).filter((k) => !found.has(k));
    expect(fixed).toEqual([]);
  });

  it('the scan is not vacuous: a dropped argument is caught', () => {
    expect(compareMessageShape('Hi {name}', 'Hallo', 'de').length).toBeGreaterThan(0);
  });
});
