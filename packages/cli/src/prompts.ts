import { createInterface } from 'node:readline';

// Minimal interactive prompts. All prompt CHROME goes to stderr so stdout stays
// a clean payload channel (output.ts). Non-interactive runs (the 7.9.5 suite,
// CI, pipes) never hit these — they pass flags / env instead, and the commands
// error with guidance when an interactive value is missing without a TTY.

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** Prompt for a line of input. `defaultValue` is offered in brackets. */
export function promptLine(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed.length > 0 ? trimmed : (defaultValue ?? ''));
    });
  });
}

interface MutableInterface {
  _writeToOutput?: (s: string) => void;
}

/** Prompt for a secret (the PAT) with echo suppressed. */
export function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // The classic muted-readline: suppress the interface's own echo so the typed
  // characters never reach the terminal.
  (rl as unknown as MutableInterface)._writeToOutput = () => {};
  process.stderr.write(`${question}: `);
  return new Promise<string>((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}
