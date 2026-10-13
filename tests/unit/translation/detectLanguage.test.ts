import { describe, expect, it } from 'vitest';
import { DETECTOR_CODE_TO_LOCALE, detectLocale, proseOf } from '@/lib/translation/detectLanguage';
import { locales } from '@/lib/i18n/locales';

// The local language detector (Story MOTIR-7735 · Subtask MOTIR-8115). Pure and
// in-process: these tests mock nothing and reach no network or database.

describe('detectLocale', () => {
  it('detects Latin-script prose', () => {
    expect(detectLocale('Das ist ein ganz normaler Satz über die Planung unserer Arbeit.')).toBe(
      'de',
    );
    expect(detectLocale('This is a perfectly ordinary sentence about planning our work.')).toBe(
      'en',
    );
    expect(detectLocale('Ceci est une phrase tout à fait ordinaire sur la planification.')).toBe(
      'fr',
    );
  });

  it('decides CJK by script, even for a short title', () => {
    expect(detectLocale('修复登录页面的错误')).toBe('zh');
    expect(detectLocale('ログイン画面の不具合を修正する')).toBe('ja');
    expect(detectLocale('로그인 화면 오류 수정')).toBe('ko');
  });

  it('reads the prose only — code, URLs and chips do not count', () => {
    const body = [
      '## 登录失败',
      '',
      '用户在登录页面输入正确的密码后仍然看到错误提示，请参考 [这个问题](motir:abc) 和 [文档](https://example.com/docs/login-errors-and-how-to-handle-them)。',
      '',
      '```ts',
      'throw new Error("Invalid credentials: the password you entered does not match our records");',
      'console.log("Please check the network request and the response body for more details");',
      '```',
      '',
      '详见 https://example.com/an/extremely/long/english/url/about/authentication/failures 以及 `const password = getPasswordFromTheForm()`。',
    ].join('\n');
    expect(detectLocale(body)).toBe('zh');
    expect(proseOf('[label](motir:abc) and motir-ref:xyz')).toBe('and');
    expect(proseOf('see [the docs](https://x.example/a) now')).toBe('see the docs now');
  });

  it('returns null for too little prose, code or URLs only, and an unsupported language', () => {
    expect(detectLocale('Fix login')).toBeNull();
    expect(detectLocale('```\nconst a = computeTheValueOfSomethingImportant(b);\n```')).toBeNull();
    expect(
      detectLocale('https://example.com/a/very/long/path/that/is/not/prose/at/all'),
    ).toBeNull();
    expect(
      detectLocale('Det här är en helt vanlig mening om planeringen av vårt arbete.'),
    ).toBeNull();
    expect(detectLocale('')).toBeNull();
  });

  it('maps exactly the eleven locales', () => {
    expect(Object.values(DETECTOR_CODE_TO_LOCALE).sort()).toEqual([...locales].sort());
  });
});
