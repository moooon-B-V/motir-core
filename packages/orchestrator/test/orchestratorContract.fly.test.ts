import { afterEach, beforeEach, vi } from 'vitest';
import { describeOrchestratorContract } from './contract/orchestratorContract';
import { FLY_APP, flyHarness, flyMachinesApi, FLY_IMAGE } from './contract/flyHarness';

// The Fly adapter against the shared contract suite (MOTIR-8960), over an
// in-memory Fly Machines API. No network, no database.

beforeEach(() => {
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
  vi.stubEnv('FLY_FLEET_APP', FLY_APP);
  vi.stubEnv('MOTIR_RUNNER_IMAGE', FLY_IMAGE);
  vi.stubEnv('FLY_FLEET_REGION', 'iad');
  vi.stubGlobal('fetch', vi.fn(flyMachinesApi));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describeOrchestratorContract('fly', flyHarness);
