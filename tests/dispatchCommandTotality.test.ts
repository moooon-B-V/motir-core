import { describe, expect, it } from 'vitest';
import { DispatchCommand } from '@/generated/prisma/client';
import { dispatchCommandSchema } from '@/lib/api/v1/workLoop/schema';
import { dispatchRunLabel } from '@/lib/services/howToTestService';
import type { OpenDispatchRunInput } from '@/packages/cli/src/dispatchRunReporter';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// DISPATCH COMMAND TOTALITY (Story MOTIR-5460 · MOTIR-5467). `fix` joined the enum
// with the repair claim; every reader of the vocabulary must know it, and so must
// the next command. Each reader is asserted over the ENUM, never over a list typed
// here, so a seventh member fails this file until every reader has it.

const COMMANDS = Object.keys(DispatchCommand) as DispatchCommand[];

/** The CLI's own union, made total at COMPILE time: a member missing here, or one
 *  the union lacks, is a type error. */
const CLI_COMMANDS = {
  next: true,
  run: true,
  run_scope: true,
  batch: true,
  auto: true,
  fix: true,
} satisfies Record<OpenDispatchRunInput['command'], true> & Record<DispatchCommand, true>;

describe('every reader of DispatchCommand handles every member', () => {
  it('includes fix', () => {
    expect(COMMANDS).toContain('fix');
  });

  it.each(COMMANDS)('%s — the v1 wire vocabulary', (command) => {
    expect(dispatchCommandSchema.options).toContain(command);
  });

  it.each(COMMANDS)('%s — a run label in en and zh', (command) => {
    expect(en.runs.command[command as keyof typeof en.runs.command]).toEqual(expect.any(String));
    expect(zh.runs.command[command as keyof typeof zh.runs.command]).toEqual(expect.any(String));
  });

  it.each(COMMANDS)('%s — the How to test run label names the typed command', (command) => {
    const label = dispatchRunLabel(command, new Date('2026-09-16T12:04:00Z'));
    expect(label).toMatch(/^motir \w+ · 2026-09-16 12:04 UTC$/);
    expect(label).not.toContain('run_scope');
  });

  it('the CLI union and the enum are the same set', () => {
    expect(Object.keys(CLI_COMMANDS).sort()).toEqual([...COMMANDS].sort());
    expect(dispatchCommandSchema.options.slice().sort()).toEqual([...COMMANDS].sort());
  });
});
