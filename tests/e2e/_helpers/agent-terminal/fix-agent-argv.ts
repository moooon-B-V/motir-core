/**
 * THE FIX RUN'S AGENT COMMAND, BUILT BY THE SHIPPED CHOOSER (Story MOTIR-8981 ·
 * MOTIR-9056). TEST-ONLY: `motir-run.py`'s `fix` branch runs this under `tsx` with the
 * run's `repair.resume` on stdin and launches what it prints.
 *
 * ⚠️ NO PROFILE FLAG IS WRITTEN OUT HERE. The argv comes from `chooseRepairAgent` /
 * `unattendedAgentCommand` in `packages/cli/src`, so a profile whose resume form drifts
 * changes what the stand-in launches and the spec reads it back from the stub's record
 * — a literal copy here would keep agreeing with itself.
 */
import { chooseRepairAgent } from '../../../../packages/cli/src/agentResume';

interface Resume {
  profile: string;
  sessionId: string | null;
  canResume: boolean;
}

const key = process.argv[2] ?? '';
const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const resume = raw === '' || raw === 'null' ? null : (JSON.parse(raw) as Resume);
  const choice = chooseRepairAgent(key, resume, process.env);
  const argv = (c: { binary: string; args: string[] }) => [c.binary, ...c.args];
  process.stdout.write(
    JSON.stringify({
      line: choice.line,
      argv: argv(choice.parsed),
      fresh: choice.fresh ? argv(choice.fresh) : null,
    }),
  );
});
