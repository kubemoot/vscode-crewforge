import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tabIcon } from '../src/panels/tabIcon';
import { Uri } from './vscodeFake';

describe('the tab icon', () => {
  it('is the Kubemoot logo in a light and a dark variant, both shipped in media', () => {
    const icon = tabIcon(Uri.file('/ext') as never);
    expect(icon.light.fsPath).toBe('/ext/media/logo-light.svg');
    expect(icon.dark.fsPath).toBe('/ext/media/logo-dark.svg');
    for (const file of ['logo-light.svg', 'logo-dark.svg']) {
      const svg = fs.readFileSync(path.join(__dirname, '..', 'media', file), 'utf8');
      expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 200 200"/);
    }
  });
});
