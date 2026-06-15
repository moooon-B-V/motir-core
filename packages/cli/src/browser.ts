import { spawn } from 'node:child_process';

// Best-effort "open this URL in the default browser." The CLI ALWAYS prints the
// URL first (output.ts), so this is purely additive — a headless / SSH / no-DISPLAY
// box where the launcher is missing or fails just keeps the printed link. Hence
// the resolve-false-never-throw contract.

/** The platform launcher + leading args. */
function launcher(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', args: [] };
}

/** A Linux box with no graphical session can't open a browser; detect the
 * common headless case so we don't even try (the printed URL is the result). */
function hasDisplay(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env['DISPLAY'] || env['WAYLAND_DISPLAY']);
}

export interface OpenUrlEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Try to open `url`. Resolves `true` if the launcher started, `false` if it was
 * skipped (headless) or failed to spawn — NEVER rejects. The browser is a
 * convenience on top of the always-printed URL.
 */
export function openUrl(url: string, opts: OpenUrlEnv = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (!hasDisplay(env, platform)) return Promise.resolve(false);

  const { cmd, args } = launcher(platform);
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.unref();
      // Spawn is async; if no 'error' fires on the next tick, treat it as launched.
      setTimeout(() => resolve(true), 0);
    } catch {
      resolve(false);
    }
  });
}
