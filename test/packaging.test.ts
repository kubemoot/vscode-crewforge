import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');

/**
 * Whether .vscodeignore lets `file` into the .vsix: a later `!pattern` that matches it
 * un-ignores it. It reads `*` and `**` only, which is all the ignore file uses.
 */
function shipped(file: string): boolean {
  const patterns = read('.vscodeignore').split('\n').map((l) => l.trim()).filter(Boolean);
  let included = true;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    const glob = negated ? p.slice(1) : p;
    const re = new RegExp(`^${glob.replaceAll('.', '\\.').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')}$`);
    if (re.test(file)) included = negated;
  }
  return included;
}

/** Every image README.md loads: `src` and `srcset` attributes and Markdown images. */
function readmeImages(): string[] {
  return [...read('README.md').matchAll(/(?:src|srcset)="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? m[2]);
}

const isRemote = (ref: string) => /^([a-z]+:|\/\/)/i.test(ref);

/** This repository's files as raw GitHub URLs, the form vsce rewrites a relative README image to. */
const rawRepoUrl = /^https:\/\/raw\.githubusercontent\.com\/kubemoot\/vscode-crewforge\/main\/(.+)$/;

describe('the packaged extension', () => {
  it('ships every script the build writes to dist, so no webview loads a missing file', () => {
    const outfiles = [...read('esbuild.mjs').matchAll(/outfile: '(dist\/[^']+)'/g)].map((m) => m[1]);
    expect(outfiles).toEqual(expect.arrayContaining(['dist/extension.js', 'dist/webview.js', 'dist/page.js']));
    for (const file of outfiles) expect(shipped(file), file).toBe(true);
  });

  it('ships every dist and media file a webview names', () => {
    const named = new Set<string>();
    for (const file of ['src/dashboard/pagePanel.ts', 'src/panels/chatPanel.ts', 'src/panels/tabIcon.ts']) {
      for (const m of read(file).matchAll(/'(dist|media)', '([^']+)'/g)) named.add(`${m[1]}/${m[2]}`);
    }
    expect(named.size).toBeGreaterThanOrEqual(5);
    for (const file of named) {
      expect(fs.existsSync(path.join(repo, file)) || file.startsWith('dist/'), file).toBe(true);
      expect(shipped(file), file).toBe(true);
    }
  });

  it('names README images that exist in the repository, since the Marketplace page loads them from GitHub', () => {
    expect(readmeImages()).toEqual(
      expect.arrayContaining([
        '.github/assets/kubemoot-horizontal-color.png',
        'docs/screenshots/views.png',
      ]),
    );
    for (const ref of readmeImages()) {
      const local = isRemote(ref) ? rawRepoUrl.exec(ref)?.[1] : ref;
      if (local === undefined) {
        expect(ref, ref).toMatch(/^https:\/\/img\.shields\.io\/|^https:\/\/github\.com\/kubemoot\/vscode-crewforge\/actions\//);
        continue;
      }
      expect(fs.existsSync(path.join(repo, local)), ref).toBe(true);
    }
  });

  it('makes every README image an https URL in the package: vsce rewrites relative ones to GitHub', () => {
    const script = JSON.parse(read('package.json')).scripts.package as string;
    expect(script).toMatch(/vsce package .*--githubBranch \S+/);
    expect(script).not.toContain('--no-rewrite-relative-links');
    // vsce rewrites `src` and Markdown images but not `srcset`, so a srcset is written absolute.
    for (const m of read('README.md').matchAll(/srcset="([^"]+)"/g)) expect(m[1]).toMatch(rawRepoUrl);
    for (const ref of readmeImages()) expect(ref.startsWith('http:'), ref).toBe(false);
  });

  it('uses PNG for every README image from the repository, since the Marketplace refuses SVG images in a README', () => {
    for (const ref of readmeImages().filter((r) => !isRemote(r) || rawRepoUrl.test(r))) expect(ref, ref).toMatch(/\.png$/);
  });

  it('keeps README images out of the package, since the package links them from GitHub', () => {
    for (const ref of readmeImages().filter((r) => !isRemote(r))) expect(shipped(ref), ref).toBe(false);
  });

  it('reads an ignore file the way vsce does: later lines win', () => {
    expect(shipped('src/extension.ts')).toBe(false);
    expect(shipped('test/fakes.ts')).toBe(false);
    expect(shipped('media/kubemoot-favicon-small.svg')).toBe(true);
    expect(shipped('brand.lock')).toBe(false);
    expect(shipped('scripts/brand-sync.sh')).toBe(false);
    expect(shipped('.github/workflows/ci.yaml')).toBe(false);
  });
});
