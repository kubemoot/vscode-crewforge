import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repo = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');
const manifest = JSON.parse(read('package.json'));

/** The categories the Visual Studio Marketplace and VS Code accept in `categories`. */
const marketplaceCategories = new Set([
  'AI', 'Azure', 'Chat', 'Data Science', 'Debuggers', 'Education', 'Extension Packs', 'Formatters', 'Keymaps',
  'Language Packs', 'Linters', 'Machine Learning', 'Notebooks', 'Other', 'Programming Languages', 'SCM Providers',
  'Snippets', 'Testing', 'Themes', 'Visualization',
]);

/** Width and height from a PNG file's IHDR chunk, or undefined when the file is not a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('pngSize', () => {
  it('reads the size of a PNG', () => {
    expect(pngSize(fs.readFileSync(path.join(repo, 'media/icon.png')))).toEqual({ width: 512, height: 512 });
  });

  it('refuses a file that is not a PNG', () => {
    expect(pngSize(Buffer.from(read('media/kubemoot.svg')))).toBeUndefined();
    expect(pngSize(Buffer.alloc(4))).toBeUndefined();
  });
});

describe('the Marketplace and Open VSX listing fields', () => {
  it('names the extension kubemoot.crewforge, shown as CrewForge', () => {
    expect(manifest.publisher).toBe('kubemoot');
    expect(manifest.name).toBe('crewforge');
    expect(manifest.displayName).toBe('CrewForge');
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.description.length).toBeLessThanOrEqual(200);
  });

  it('keeps the version at 0.0.0 in git, since the workflows set it from the tag', () => {
    expect(manifest.version).toBe('0.0.0');
  });

  it('marks the extension as a preview while it is 0.x, and free', () => {
    expect(manifest.preview).toBe(true);
    expect(manifest.pricing).toBe('Free');
  });

  it('uses only categories the Marketplace accepts, without the catch-all', () => {
    expect(manifest.categories.length).toBeGreaterThan(0);
    for (const category of manifest.categories) expect(marketplaceCategories.has(category), category).toBe(true);
    expect(manifest.categories).not.toContain('Other');
  });

  it('stays within the Marketplace limit of 30 keywords, with no repeats', () => {
    expect(manifest.keywords.length).toBeGreaterThan(0);
    expect(manifest.keywords.length).toBeLessThanOrEqual(30);
    expect(new Set(manifest.keywords).size).toBe(manifest.keywords.length);
  });

  it('has a PNG icon of at least 128 x 128 pixels, since the Marketplace refuses an SVG icon', () => {
    expect(manifest.icon).toMatch(/\.png$/);
    const size = pngSize(fs.readFileSync(path.join(repo, manifest.icon)));
    expect(size?.width).toBeGreaterThanOrEqual(128);
    expect(size?.height).toBeGreaterThanOrEqual(128);
  });

  it('paints the gallery banner in the brand Table navy with light text', () => {
    expect(manifest.galleryBanner).toEqual({ color: '#1f2a37', theme: 'dark' });
  });

  it('links the repository, issues, Q&A, and documentation over https', () => {
    expect(manifest.repository.url).toBe('https://github.com/kubemoot/vscode-crewforge');
    expect(manifest.bugs.url).toBe('https://github.com/kubemoot/vscode-crewforge/issues');
    expect(manifest.homepage).toBe('https://kubemoot.org/docs/ecosystem/crewforge/');
    expect(manifest.qna).toMatch(/^https:\/\//);
  });

  it('declares the Apache 2.0 license it ships', () => {
    expect(manifest.license).toBe('Apache-2.0');
    expect(read('LICENSE')).toContain('Apache License');
  });

  it('declares no VS Code older than the API types it compiles against', () => {
    const engine = /^\^(\d+\.\d+\.\d+)$/.exec(manifest.engines.vscode)?.[1];
    const types = /^\^(\d+\.\d+\.\d+)$/.exec(manifest.devDependencies['@types/vscode'])?.[1];
    expect(engine).toBeDefined();
    expect(types).toBe(engine);
  });

  it('pins both publishing CLIs as devDependencies, so the lockfile and Dependabot own their versions', () => {
    expect(manifest.devDependencies['@vscode/vsce']).toBeDefined();
    expect(manifest.devDependencies.ovsx).toBeDefined();
  });
});

interface Step { name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string[]; permissions?: Record<string, string>; environment?: string; steps: Step[] }
interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { default: unknown; type: string }> } };
  jobs: Record<string, Job>;
}

describe('publishing to the registries in Promote Release', () => {
  const text = read('.github/workflows/promote-release.yaml');
  const workflow = load(text) as Workflow;
  const inputs = workflow.on.workflow_dispatch.inputs;
  const { promote, publish } = workflow.jobs;
  const step = (job: Job, name: string) => {
    const index = job.steps.findIndex((s) => s.name === name);
    expect(index, name).toBeGreaterThanOrEqual(0);
    return { index, step: job.steps[index] };
  };

  it('is off unless asked for, and a dry run stays the default', () => {
    expect(inputs.publish_marketplaces).toMatchObject({ default: false, type: 'boolean' });
    expect(inputs.pre_release).toMatchObject({ default: false, type: 'boolean' });
    expect(inputs.dry_run).toMatchObject({ default: true, type: 'boolean' });
  });

  it('never runs on a dry run or without the explicit input', () => {
    expect(publish.if).toContain('!inputs.dry_run');
    expect(publish.if).toContain('inputs.publish_marketplaces');
    expect(publish.if).not.toContain('||');
  });

  it('checks every credential before the final tag exists', () => {
    const check = step(promote, 'Check the registry credentials');
    expect(check.index).toBe(0);
    expect(check.index).toBeLessThan(step(promote, 'Tag the final version').index);
    expect(check.step.if).toContain('inputs.publish_marketplaces');
    const env = Object.values(check.step.env ?? {}).join(' ');
    for (const secret of ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'VSCE_PAT', 'OVSX_PAT']) expect(env).toContain(`secrets.${secret}`);
    expect(check.step.run).toContain('exit "${missing}"');
  });

  it('packages a pre-release when asked, so the GitHub Release and the registries carry the same file', () => {
    const pack = step(promote, 'Test and package at the final version').step;
    expect(pack.env?.PRE_RELEASE).toBe('${{ inputs.pre_release }}');
    expect(pack.run).toContain('flags+=(--pre-release)');
    expect(pack.run).toContain('npm run package -- "${flags[@]}"');
  });

  it('runs after the GitHub Release and publishes the .vsix that release carries', () => {
    expect(publish.needs).toEqual(expect.arrayContaining(['promote', 'release']));
    expect(step(publish, 'Download the .vsix from the GitHub Release').step.run).toContain('gh release download "${TAG}"');
  });

  it('can only read the repository and request an OIDC token, and keeps no git credential', () => {
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(publish.environment).toBe('marketplace');
    const checkout = step(publish, 'Check out the promoted commit').step;
    expect(checkout.with).toMatchObject({ ref: '${{ needs.promote.outputs.commit }}', 'persist-credentials': false });
  });

  it('hands each registry secret only to the step that uses it', () => {
    const holders = (secret: string) => publish.steps.filter((s) => JSON.stringify(s).includes(`secrets.${secret}`)).map((s) => s.name);
    expect(holders('VSCE_PAT')).toEqual(['Publish to the VS Code Marketplace']);
    expect(holders('OVSX_PAT')).toEqual(['Publish to Open VSX']);
    expect(holders('AZURE_CLIENT_ID')).toEqual(['Sign in to Microsoft Entra']);
  });

  it('publishes to Open VSX with Trusted Publishing unless an OVSX_PAT is set', () => {
    const openvsx = step(publish, 'Publish to Open VSX').step;
    expect(openvsx.run).toContain('--trusted-publishing');
    expect(openvsx.run).toMatch(/if \[ "\$\{AUTH\}" != pat \]; then flags\+=\(--trusted-publishing\)/);
    expect(JSON.stringify(openvsx.env)).toContain("openvsx_auth == 'pat' && secrets.OVSX_PAT");
    expect(publish.permissions?.['id-token']).toBe('write');
  });

  it('publishes with the locked CLIs, and never repackages', () => {
    const runs = publish.steps.map((s) => s.run ?? '').join('\n');
    expect(step(publish, 'Publish to the VS Code Marketplace').step.run).toContain('npx --no-install vsce publish --packagePath');
    expect(step(publish, 'Publish to Open VSX').step.run).toContain('npx --no-install ovsx publish');
    expect(runs.match(/--skip-duplicate/g)).toHaveLength(2);
    expect(runs).not.toMatch(/vsce package|npm version|npm run package|@vscode\/vsce@|ovsx@/);
  });

  it('points the README links of every packaged .vsix at the commit it was built from', () => {
    expect(text).toContain('flags=(--githubBranch "${COMMIT}")');
    expect(read('.github/workflows/release.yaml')).toContain('npm run package -- --githubBranch "${GITHUB_SHA}"');
  });
});
