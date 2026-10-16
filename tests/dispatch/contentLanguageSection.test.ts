import { describe, expect, it } from 'vitest';
import { assembleDispatchPrompt, type DispatchPromptSource } from '@/lib/dispatch/promptTemplate';
import { locales } from '@/lib/i18n/locales';

// The WORK CONTENT LANGUAGE section of the dispatch prompt (Story MOTIR-7734 ·
// Subtask MOTIR-8745) — PURE: the assembler reads nothing, so these fix the TEXT.
// The service half, which reads the organisation's language from the real
// database, is `contentLanguageRead.test.ts`.

function source(over: Partial<DispatchPromptSource> = {}): DispatchPromptSource {
  return {
    key: 'PROD-7',
    title: 'Add the ready-set filter bar',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    difficulty: null,
    priority: 'high',
    storyPoints: 3,
    estimateMinutes: 40,
    descriptionMd: 'Build it.\n\n## Acceptance criteria\n\n- It is built.',
    blockerKeys: [],
    openDependentKeys: [],
    parent: { key: 'PROD-2', title: 'Ready surface' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: 'motir-core',
    sessionBranch: null,
    ...over,
  };
}

const NAMES = {
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
} as const;

describe('the WORK CONTENT LANGUAGE section (MOTIR-8745)', () => {
  it('names the language by code and name, between CONTEXT and WHAT TO DO', () => {
    const { prompt } = assembleDispatchPrompt(source({ contentLanguage: 'zh' }));
    const context = prompt.indexOf('\nCONTEXT\n');
    const section = prompt.indexOf('\nWORK CONTENT LANGUAGE\n');
    const whatToDo = prompt.indexOf('\nWHAT TO DO\n');
    expect(context).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(context);
    expect(whatToDo).toBeGreaterThan(section);
    expect(prompt).toContain('This organisation writes its work content in Chinese (`zh`).');
    expect(prompt).toContain('to-do text and notes written in Chinese');
  });

  it('keeps identifiers, paths, code, commands, keys and quoted text in their original form', () => {
    const { prompt } = assembleDispatchPrompt(source({ contentLanguage: 'zh' }));
    expect(prompt).toContain(
      'Identifiers, file paths, code, commands, work item keys and quoted text keep\ntheir original form.',
    );
  });

  it('renders byte-identically to today when no language is passed', () => {
    const without = assembleDispatchPrompt(source()).prompt;
    expect(without).not.toContain('WORK CONTENT LANGUAGE');
    expect(assembleDispatchPrompt(source({ contentLanguage: undefined })).prompt).toBe(without);
  });

  it('a MANUAL item renders no section even when a language is passed', () => {
    for (const over of [{ type: 'manual' as const }, { executor: 'human' as const }]) {
      const { prompt } = assembleDispatchPrompt(source({ ...over, contentLanguage: 'ja' }));
      expect(prompt).not.toContain('WORK CONTENT LANGUAGE');
      expect(prompt).toBe(assembleDispatchPrompt(source(over)).prompt);
    }
  });

  it.each(locales.map((code) => [code, NAMES[code]] as const))('renders %s as %s', (code, name) => {
    const { prompt } = assembleDispatchPrompt(source({ contentLanguage: code }));
    expect(prompt).toContain(`This organisation writes its work content in ${name} (\`${code}\`).`);
    expect(prompt.split('WORK CONTENT LANGUAGE')).toHaveLength(2);
  });
});
