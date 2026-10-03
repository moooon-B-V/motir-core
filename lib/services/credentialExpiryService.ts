import { CREDENTIAL_REGISTRY } from '@/lib/health/credentialRegistry';
import {
  probeCredentialExpiry,
  type CredentialExpiryVerdict,
} from '@/lib/health/credentialExpiryProbe';

// THE CREDENTIAL-EXPIRY PROBE, given a service seam (MOTIR-1933) so
// `system.daily-health-check` can consume it through `jobServices`, exactly as
// it consumes `monitorConfigPreflightService`. The whole decision is the pure
// `probeCredentialExpiry()`; what is added here is the binding to the real
// registry, the real environment and the clock.

export const credentialExpiryService = {
  /**
   * Judge every registered credential. Never throws on a lapsing credential —
   * each arm of {@link CredentialExpiryVerdict} is an answer, and the CALLER
   * decides which arms are loud. `now` is injectable so a test never reads the
   * wall clock.
   */
  check(now: Date = new Date()): CredentialExpiryVerdict {
    return probeCredentialExpiry(CREDENTIAL_REGISTRY, process.env, now);
  },
};
