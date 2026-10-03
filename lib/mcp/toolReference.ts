import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withMcpToolReference } from '@/lib/apiDocs/mcpToolReference';

// The REFERENCE-LINK seam (MOTIR-7391): every tool's description ends with a link
// to that tool's own entry in the published MCP tool reference.
//
// Claude's connector directory suggested "Reference the target API docs in the
// description" on six write tools. Appending the link here, at registration,
// rather than in each tool module puts it on EVERY tool from one place: the url
// and the anchor shape live in `lib/apiDocs/mcpToolReference.ts`, no tool module
// repeats them, and a tool added later carries the link without anyone
// remembering to write it.
//
// Like `strictInputServer` and `annotatedServer`, it rewrites the config and never
// the callback, so it composes with the policy wrappers without ordering against
// them.

/**
 * Wrap `server` so every `registerTool(name, config, cb)` call's
 * `config.description` ends with the tool's reference sentence
 * (`Reference: https://app.motir.co/docs/mcp/tools#tool-<name>`).
 */
export function referencedServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'registerTool' || typeof value !== 'function') return value;
      const register = value as (...registerArgs: unknown[]) => unknown;
      return (...registerArgs: unknown[]) => {
        const name = String(registerArgs[0]);
        const config = (registerArgs[1] ?? {}) as { description?: unknown };
        const next = [...registerArgs];
        next[1] = {
          ...config,
          description: withMcpToolReference(
            name,
            typeof config.description === 'string' ? config.description : undefined,
          ),
        };
        return register.apply(target, next);
      };
    },
  });
}
