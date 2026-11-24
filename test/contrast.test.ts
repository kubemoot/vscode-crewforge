import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const media = (name: string) => readFileSync(path.join(__dirname, '..', 'media', name), 'utf8');
const page = media('page.css');
const chat = media('chat.css');

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgb) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** What `color-mix(in srgb, status share%, foreground)` gives. */
const mix = (status: Rgb, share: number, foreground: Rgb): Rgb => status.map((v, i) => v * share + foreground[i] * (1 - share)) as Rgb;

type Kind = 'light' | 'dark' | 'hc' | 'hcLight';
interface Theme {
  kind: Kind;
  bg: string;
  widget: string;
  fg: string;
  passed: string;
  error: string;
  warning: string;
}
/** The colours VS Code's own themes give the variables the status text is mixed from, and the surfaces it sits on. */
const THEMES: Record<string, Theme> = {
  'Light Modern': { kind: 'light', bg: '#ffffff', widget: '#f8f8f8', fg: '#3b3b3b', passed: '#73c991', error: '#f85149', warning: '#bf8803' },
  'Light+': { kind: 'light', bg: '#ffffff', widget: '#f3f3f3', fg: '#616161', passed: '#73c991', error: '#a1260d', warning: '#bf8803' },
  'Dark Modern': { kind: 'dark', bg: '#1f1f1f', widget: '#202020', fg: '#cccccc', passed: '#73c991', error: '#f85149', warning: '#cca700' },
  'Dark+': { kind: 'dark', bg: '#1e1e1e', widget: '#252526', fg: '#cccccc', passed: '#73c991', error: '#f48771', warning: '#cca700' },
  'Dark High Contrast': { kind: 'hc', bg: '#000000', widget: '#0c141f', fg: '#ffffff', passed: '#89d185', error: '#f48771', warning: '#ffcc00' },
  'Light High Contrast': { kind: 'hcLight', bg: '#ffffff', widget: '#ffffff', fg: '#292929', passed: '#136c22', error: '#b5200d', warning: '#895503' },
};

/** The share of the status colour the stylesheet uses for a theme kind, read from the stylesheet itself. */
function tint(css: string, kind: Kind): number {
  const selector = { light: '', dark: 'body.vscode-dark', hc: 'body.vscode-high-contrast', hcLight: 'body.vscode-high-contrast-light' }[kind];
  const rules = [...css.matchAll(/^([^{\n]*) \{ --tint: (\d+)%;/gm)].map((m) => ({ selectors: m[1].split(',').map((x) => x.trim()), share: Number(m[2]) }));
  const found = rules.find((r) => r.selectors.includes(selector === '' ? 'body' : selector));
  if (!found) throw new Error(`no tint for ${kind}`);
  return found.share / 100;
}

const AA = 4.5;

describe.each([
  ['page.css', page, ['passed', 'error', 'warning'] as const],
  ['chat.css', chat, ['error'] as const],
])('status text in %s', (_name, css, statuses) => {
  it.each(Object.entries(THEMES))('meets WCAG AA (4.5:1) on %s, on the page and on a widget surface', (_theme, t) => {
    const share = tint(css, t.kind);
    for (const status of statuses) {
      const text = mix(rgb(t[status]), share, rgb(t.fg));
      expect(ratio(text, rgb(t.bg))).toBeGreaterThanOrEqual(AA);
      expect(ratio(text, rgb(t.widget))).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('the stylesheets', () => {
  it('draw badge, error and diff text from the mixed tokens, not from a theme status colour or a hardcoded colour', () => {
    for (const selector of ['.badge.good', '.badge.warn', '.badge.bad']) {
      const rule = new RegExp(String.raw`^${selector.replaceAll('.', String.raw`\.`)} \{([^}]*)\}`, 'm').exec(page)![1];
      expect(rule).toMatch(/(^|[ ;])color: var\(--text-(good|warn|bad)\)/);
    }
    expect(page).toMatch(/^\.error \{ color: var\(--text-bad\)/m);
    expect(page).toMatch(/^pre\.diff \.added \{ color: var\(--text-good\)/m);
    expect(page).toMatch(/^pre\.diff \.removed \{ color: var\(--text-bad\)/m);
    expect(chat).toMatch(/^\.finding-card\.finding-problem \.finding-summary \{ color: var\(--text-error\)/m);
    expect(chat).toMatch(/^\.menu-item\.danger \{ color: var\(--text-error\)/m);
  });

  it('build the tokens from theme variables only, and set a share for each theme kind', () => {
    for (const css of [page, chat]) {
      const tokens = css.split('\n').filter((l) => /^body \{ --tint/.test(l)).join('');
      expect(tokens).toContain('var(--vscode-foreground)');
      expect(tokens).toContain('var(--vscode-errorForeground');
      for (const kind of ['light', 'dark', 'hc', 'hcLight'] as Kind[]) expect(tint(css, kind)).toBeGreaterThan(0);
    }
    expect(page).toContain('var(--vscode-testing-iconPassed');
    expect(page).toContain('var(--vscode-editorWarning-foreground');
  });

  it('measure the old colours below AA, so the check can fail', () => {
    const light = THEMES['Light Modern'];
    expect(ratio(rgb(light.passed), rgb(light.bg))).toBeLessThan(AA);
    expect(ratio(rgb(light.error), rgb(light.bg))).toBeLessThan(AA);
  });
});
