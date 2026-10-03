import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tabIcon } from '../src/panels/tabIcon';
import { Uri } from './vscodeFake';

const repo = path.join(__dirname, '..');
const lockedFiles = fs
  .readFileSync(path.join(repo, 'brand.lock'), 'utf8')
  .split('\n')
  .filter((line) => /^[0-9a-f]{64} /.test(line))
  .map((line) => line.split(' ')[1]);

describe('the tab icon', () => {
  it('is the small brand mark, one file for light and dark themes', () => {
    const icon = tabIcon(Uri.file('/ext') as never);
    expect(icon.fsPath).toBe('/ext/media/kubemoot-favicon-small.svg');
  });

  it('is a copy of the brand file that brand.lock pins', () => {
    const svg = fs.readFileSync(path.join(repo, 'media', 'kubemoot-favicon-small.svg'), 'utf8');
    expect(svg).toMatch(/^<svg [^>]*viewBox="18 18 164 164"/);
    expect(lockedFiles).toContain('media/kubemoot-favicon-small.svg');
  });
});

describe('the extension icons in package.json', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

  it('uses the full-color brand icon, a PNG of at least 128 px, for the Marketplace', () => {
    expect(manifest.icon).toBe('media/icon.png');
    const png = fs.readFileSync(path.join(repo, manifest.icon));
    expect([...png.subarray(1, 4)]).toEqual([...Buffer.from('PNG')]);
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
    expect(lockedFiles).toContain('media/icon.png');
  });

  it('uses the one-color brand icon in the activity bar, which VS Code tints', () => {
    const [container] = manifest.contributes.viewsContainers.activitybar;
    expect(container.icon).toBe('media/kubemoot.svg');
    expect(lockedFiles).toContain('media/kubemoot.svg');
  });

  it('ships every file brand.lock lists, and no hand-drawn logo beside them', () => {
    for (const file of lockedFiles) expect(fs.existsSync(path.join(repo, file)), file).toBe(true);
    for (const file of ['logo-light.svg', 'logo-dark.svg']) expect(fs.existsSync(path.join(repo, 'media', file)), file).toBe(false);
  });
});
