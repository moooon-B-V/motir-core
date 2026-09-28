// The typed failures of motir-core's calls to motir-gateway's per-run key API
// (MOTIR-689). Three, because a caller does something different for each:
//
//   - `GatewayRunKeyConfigError` — THIS deployment is missing `MOTIR_GATEWAY_URL`
//     or `MOTIR_RUN_KEY_MINT_SECRET`. Nothing was sent. An operator fixes it.
//   - `GatewayRunKeyRefusedError` — the gateway ANSWERED and said no (a 4xx, or
//     its own `503 run_keys_not_configured`). Its `code` is the gateway's own.
//   - `GatewayRunKeyUnavailableError` — the gateway could not be reached, did not
//     answer within the deadline, or failed (5xx). Retrying may help.

export abstract class GatewayRunKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class GatewayRunKeyConfigError extends GatewayRunKeyError {}

export class GatewayRunKeyRefusedError extends GatewayRunKeyError {
  constructor(
    readonly status: number,
    /** The gateway's own error code, e.g. `run_key_unauthorized`, or `unknown`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class GatewayRunKeyUnavailableError extends GatewayRunKeyError {}
