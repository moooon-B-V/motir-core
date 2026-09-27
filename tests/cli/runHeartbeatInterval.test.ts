import { describe, expect, it } from 'vitest';
import { RUN_HEARTBEAT_INTERVAL_MS as CLI_INTERVAL } from '../../packages/cli/src/dispatchRunReporter';
import { RUN_HEARTBEAT_INTERVAL_MS as SERVER_INTERVAL } from '@/lib/runs/runLiveness';

// The CLI restates the server's heartbeat interval (it cannot import the server's
// module); this pins the two together (MOTIR-6530). If the server's lapse rule
// ever changes its interval, the CLI must beat at the new one.
describe('the heartbeat interval', () => {
  it('the CLI beats at the interval the server’s liveness rule counts', () => {
    expect(CLI_INTERVAL).toBe(SERVER_INTERVAL);
  });
});
