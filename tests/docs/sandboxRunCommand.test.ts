import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_AUTH_VOLUME,
  SANDBOX_CONFIG_DIR,
  SANDBOX_IMAGE,
  sandboxProfileRows,
  sandboxPullCommand,
  sandboxRunCommand,
} from '@/lib/apiDocs/sandbox';

// THE RUN RECIPE IS IDEMPOTENT (MOTIR-4970 · MOTIR-4972).
//
// The defect these guard was not a wrong command — it was a command that was
// right ONCE. `motir login` wrote into the container's writable layer, so the
// guide had to say "no `--rm`, name it, come back with `docker start -ai`", and
// keeping the container is precisely what pins a reader to the image it was
// built from. One reader's six-week-old container ran a CLI with no `login`
// command at all while the page told them to run it.
//
// ⚠️ THESE ASSERT PER PROFILE, NOT ONCE. The command is generated from a
// derived row, and the failure worth catching is a profile that gets a
// different recipe from its siblings — which a single spot-check on `claude`
// cannot see.
//
// ⚠️ AND THEY ARE THE FIRST TESTS THIS MODULE HAS HAD. MOTIR-4972's criterion 7
// asked for "the assertions that named `--name motir-sandbox`" to be UPDATED
// rather than deleted; there were none. `SANDBOX_CONTAINER_NAME` had exactly two
// references in the repository — its own declaration and its single use in the
// run command — so nothing failed when the recipe was wrong, which is the same
// reason it stayed wrong. Reported on the card rather than quietly re-scoped.

const rows = sandboxProfileRows();

describe('sandboxRunCommand — disposable by construction', () => {
  it('has profiles to assert over at all', () => {
    // A derived table that silently empties would make every per-profile loop
    // below vacuously green.
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(rows.map((row) => [row.id, row] as const))(
    '%s: throws the container away and fetches the current image',
    (_id, row) => {
      const command = sandboxRunCommand(row);
      expect(command).toContain('--rm');
      expect(command).toContain('--pull=always');
      expect(command).toContain(`${SANDBOX_IMAGE}:${row.id}`);
    },
  );

  it.each(rows.map((row) => [row.id, row] as const))(
    '%s: names no container, and tells nobody to start or remove one',
    (_id, row) => {
      const command = sandboxRunCommand(row);
      // `--name` is the flag that made the container worth keeping, and keeping
      // it is the defect. Its absence is what makes the recipe idempotent.
      expect(command).not.toContain('--name');
      expect(command).not.toContain('docker start');
      expect(command).not.toContain('docker rm');
    },
  );

  it.each(rows.map((row) => [row.id, row] as const))(
    '%s: mounts the auth volume, writable, at the CLI config dir',
    (_id, row) => {
      expect(sandboxRunCommand(row)).toContain(`-v ${SANDBOX_AUTH_VOLUME}:${SANDBOX_CONFIG_DIR}`);
    },
  );

  it.each(rows.filter((row) => row.mounts.length > 0).map((row) => [row.id, row] as const))(
    '%s: keeps every credential mount it already had, still read-only',
    (_id, row) => {
      const command = sandboxRunCommand(row);
      for (const mount of row.mounts) {
        const relative = mount.replace(/^~\//, '');
        expect(command).toContain(`-v "$HOME/${relative}:/home/node/${relative}:ro"`);
      }
    },
  );

  it('makes the auth volume the ONLY writable mount', () => {
    // The container USES an agent sign-in and never performs one — every
    // credential bind stays `:ro`. The one exception is the volume whose whole
    // purpose is to be written by `motir login`, and it must stay the only one:
    // a second writable bind is how a host credential gets modified from inside
    // a sandbox.
    for (const row of rows) {
      const volumeFlags = sandboxRunCommand(row)
        .split('\n')
        .filter((line) => line.trim().startsWith('-v '));
      const writable = volumeFlags.filter((line) => !line.includes(':ro'));
      expect(writable, `${row.id} writable mounts`).toHaveLength(2);
      // `$PWD:/workspace` is the checkout the agent is there to edit; the other
      // is the auth volume. Neither is a host credential.
      expect(writable.some((line) => line.includes('"$PWD:/workspace"'))).toBe(true);
      expect(
        writable.some((line) => line.includes(`${SANDBOX_AUTH_VOLUME}:${SANDBOX_CONFIG_DIR}`)),
      ).toBe(true);
    }
  });
});

describe('SANDBOX_CONFIG_DIR agrees with the image', () => {
  // ⚠️ ASSERTED AGAINST THE DOCKERFILE'S OWN LITERALS, not recomputed here. The
  // mount target is `configDir()`'s resolution under the image's pinned HOME, and
  // the failure this catches is a change to either one landing without the guide
  // following it — at which point `motir login` writes into the container's
  // writable layer again and the sign-in stops surviving `--rm`, silently.
  const dockerfile = readFileSync(
    join(process.cwd(), 'packages', 'cli', 'sandbox', 'Dockerfile'),
    'utf8',
  );

  it('mounts where the image pins HOME', () => {
    const home = /^ENV HOME=(\S+)$/m.exec(dockerfile)?.[1];
    expect(home, 'the image must pin HOME').toBe('/home/node');
    expect(SANDBOX_CONFIG_DIR).toBe(`${home}/.config/motir`);
  });

  it('mounts a directory the image pre-creates for the runtime user', () => {
    // Docker seeds an empty named volume from the image's own directory, so the
    // volume comes up owned by `node` only because this line ran as root first.
    // Without it the mount would be root-owned and `motir login` would fail on a
    // volume it cannot write — the same symptom, one layer down.
    expect(dockerfile).toContain(SANDBOX_CONFIG_DIR);
    expect(dockerfile).toMatch(/mkdir -p .*\/home\/node\/\.config\/motir/);
    expect(dockerfile).toMatch(/chown -R node:node/);
  });
});

describe('sandboxPullCommand — kept, and still the same tag', () => {
  it.each(rows.map((row) => [row.id, row] as const))(
    '%s: pulls exactly the tag the run command starts',
    (_id, row) => {
      // The one thing this pair must never do is name two different tags.
      // `--pull=always` made the pull redundant for a reader who runs the
      // container; it did not make it free to disagree.
      expect(sandboxPullCommand(row)).toBe(`docker pull ${SANDBOX_IMAGE}:${row.id}`);
      expect(sandboxRunCommand(row)).toContain(`${SANDBOX_IMAGE}:${row.id}`);
    },
  );
});
