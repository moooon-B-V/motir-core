// THE READERS' k6 `scenarios` FRAGMENT (Story MOTIR-8538 · MOTIR-8677).
//
// `readerScenarios(profile)` turns the profile's reader numbers into two k6
// scenarios, `readerTab` and `readerBrowse`. It defines no thresholds and no
// instance count: those belong to the profile (MOTIR-8678), which also owns every
// number passed in here.
//
// `profile`:
//   readers          reader VUs in total
//   tabShare         the share of them holding a Workbench tab (default 0.75)
//   rampSeconds      the ramp to full strength
//   durationSeconds  the steady stretch after the ramp
//   holdSeconds      one tab's hold time; an iteration can run this long past the
//                    stages, so each tab scenario's graceful stop covers it
//   exec             `{ tab, browse }`: the names the k6 script exports the two
//                    iteration functions under (default readerTab / readerBrowse)
//
// PURE (no k6 import); `scenarios/readers.js` re-exports it.

export const DEFAULT_TAB_SHARE = 0.75;

/** The tab and browse VU counts: tabs rounded from the share, browsers the rest. */
export function readerSplit(readers, tabShare = DEFAULT_TAB_SHARE) {
  const total = Math.max(0, Math.floor(readers));
  const tabs = Math.min(total, Math.max(0, Math.round(total * tabShare)));
  return { tabs, browsers: total - tabs };
}

/** The k6 `scenarios` entries for the readers; an empty side is left out. */
export function readerScenarios(profile) {
  const { readers, tabShare, rampSeconds, durationSeconds, holdSeconds } = profile;
  for (const [name, v] of Object.entries({ readers, rampSeconds, durationSeconds, holdSeconds })) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`readerScenarios: ${name} must be a non-negative number`);
    }
  }
  const { tabs, browsers } = readerSplit(readers, tabShare ?? DEFAULT_TAB_SHARE);
  const stages = (target) => [
    { duration: `${rampSeconds}s`, target },
    { duration: `${durationSeconds}s`, target },
  ];
  const scenarios = {};
  if (tabs > 0) {
    const grace = `${Math.ceil(holdSeconds) + 30}s`;
    scenarios.readerTab = {
      executor: 'ramping-vus',
      exec: profile.exec?.tab ?? 'readerTab',
      startVUs: 0,
      stages: stages(tabs),
      gracefulRampDown: grace,
      gracefulStop: grace,
      tags: { role: 'reader' },
    };
  }
  if (browsers > 0) {
    scenarios.readerBrowse = {
      executor: 'ramping-vus',
      exec: profile.exec?.browse ?? 'readerBrowse',
      startVUs: 0,
      stages: stages(browsers),
      gracefulRampDown: '30s',
      gracefulStop: '30s',
      tags: { role: 'reader' },
    };
  }
  return scenarios;
}
