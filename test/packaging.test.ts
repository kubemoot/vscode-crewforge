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

/** The images README.md loads from the repository: `src` and `srcset` attributes and Markdown images, remote URLs left out. */
function readmeImages(): string[] {
  const refs = [...read('README.md').matchAll(/(?:src|srcset)="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? m[2]);
  return refs.filter((ref) => !/^([a-z]+:|\/\/)/i.test(ref));
}

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

  it('ships every image the README names, so its header and screenshot render from the .vsix', () => {
    expect(readmeImages()).toEqual(
      expect.arrayContaining([
        '.github/assets/kubemoot-horizontal-color.png',
        '.github/assets/kubemoot-horizontal-white-text.png',
        'docs/screenshots/views.png',
      ]),
    );
    for (const file of readmeImages()) {
      expect(fs.existsSync(path.join(repo, file)), file).toBe(true);
      expect(shipped(file), file).toBe(true);
    }
  });

  it('uses PNG for every README image, since the Marketplace refuses SVG images in a README', () => {
    for (const file of readmeImages()) expect(file, file).toMatch(/\.png$/);
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
