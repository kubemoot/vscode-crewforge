import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');
const script = path.join(repo, 'scripts/changelog.sh');
const fixtures = path.join(repo, 'test/fixtures/changelog');
const stubLib = path.join(fixtures, 'release-lib.sh');
const releasesUrl = 'https://github.com/kubemoot/vscode-crewforge/releases';

/** A git environment that ignores the developer's own config, so no signing or hooks run. */
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
for (const name of ['GH_TOKEN', 'GITHUB_API_URL', 'GITHUB_SERVER_URL', 'CURL_STUB_FAIL']) delete gitEnv[name];

interface Release { tag_name: string; draft: boolean; prerelease: boolean; body: string | null }
const release = (tag_name: string, body: string | null, flags: Partial<Release> = {}): Release =>
  ({ tag_name, draft: false, prerelease: false, body, ...flags });

/**
 * The GitHub Releases the curl stand-in serves, out of order as the API may return them:
 * three final releases, plus a draft, a candidate, a pre-release with a final-looking
 * tag, and another component's tag, none of which belong in the changelog.
 */
const publishedReleases: Release[] = [
  release('v0.1.0', '## Changes\n\n### New\n\n- Chat with a crew, as the maintainer reworded it.\n\n**Full Changelog**: kept as written\n'),
  release('v0.1.1', '## Changes since v0.1.0\r\n\r\nNo user-facing changes: maintenance only.\r\n\r\nAll commits: https://github.com/kubemoot/vscode-crewforge/compare/v0.1.0...v0.1.1\r\n'),
  release('v0.2.0', '## Changes since v0.1.1\n\n- Not published yet.', { draft: true }),
  release('v0.2.0-rc.1', '- A candidate.', { prerelease: true }),
  release('v0.0.9', null),
  release('v0.1.5', '- A pre-release.', { prerelease: true }),
  release('kmctl-v1.0.0', '- Another component.'),
];

let work: string;
let releasesFile: string;
let curlLog: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: work, env: gitEnv, encoding: 'utf8' }).trim();
const commit = (subject: string) => {
  git('commit', '--allow-empty', '-q', '-m', subject);
  return git('rev-parse', '--short', 'HEAD');
};
const serve = (releases: unknown) => fs.writeFileSync(releasesFile, JSON.stringify(releases));
const run = (args: string[], lib: string, env: NodeJS.ProcessEnv = {}) =>
  spawnSync(script, args, {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...gitEnv,
      PATH: `${path.join(fixtures, 'bin')}:${process.env.PATH ?? ''}`,
      RELEASE_LIB: lib,
      GITHUB_REPOSITORY: 'kubemoot/vscode-crewforge',
      CURL_STUB_RELEASES: releasesFile,
      CURL_STUB_LOG: curlLog,
      ...env,
    },
  });
const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
/** The body of one `## TITLE` section, up to the next one. */
const sectionOf = (text: string, title: string) => text.split(`\n## ${title}\n`)[1]?.split('\n## ')[0].trim();

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  releasesFile = path.join(work, '.git', 'releases.json');
  curlLog = path.join(work, '.git', 'curl.log');
  git('init', '-q', '-b', 'main');
  serve(publishedReleases);
});

afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

/**
 * The script runs against the stand-in library always, and also against the real
 * release-lib.sh when RELEASE_LIB names it: Publish Release runs the tests after its
 * setup step exports RELEASE_LIB, and a developer can set it to a local clone.
 */
const libraries: [string, string][] = [['the stand-in release library', stubLib]];
if (process.env.RELEASE_LIB) libraries.push(['kubemoot/release-actions release-lib.sh', process.env.RELEASE_LIB]);

describe.each(libraries)('scripts/changelog.sh with %s', (_name, lib) => {
  const changelog = (version: string) => {
    const result = run([version], lib);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout;
  };
  const expectRefused = (result: ReturnType<typeof run>, message: RegExp) => {
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(message);
  };

  /** The tags of the published releases, a candidate after them, and commits since. */
  function releasedRepo() {
    commit('feat: an early start');
    git('tag', 'v0.0.9');
    commit('feat: chat with a crew');
    git('tag', 'v0.1.0');
    commit('chore: tidy the build');
    git('tag', 'v0.1.1');
    const show = commit('feat: show the crew dashboard');
    const fix = commit('fix: reconnect a dropped stream');
    git('tag', 'v0.2.0-rc.1');
    const rename = commit('feat: rename a crew');
    return { show, fix, rename };
  }

  it('starts with the title and a link to the GitHub Releases it is generated from', () => {
    releasedRepo();
    const lines = changelog('0.2.0').split('\n');
    expect(lines[0]).toBe('# Changelog');
    expect(lines[2]).toContain(`(${releasesUrl})`);
    expect(lines[2]).toMatch(/^Generated from the release notes/);
  });

  it('lists the version being published on top, then each final GitHub Release newest first', () => {
    releasedRepo();
    expect(headings(changelog('0.2.0'))).toEqual(['0.2.0', '0.1.1', '0.1.0', '0.0.9']);
  });

  it('skips draft releases, pre-releases, candidates, and other tags', () => {
    releasedRepo();
    const text = changelog('0.2.0');
    for (const absent of ['Not published yet', 'A candidate', 'A pre-release', 'Another component', '0.1.5', 'rc.1']) {
      expect(text, absent).not.toContain(absent);
    }
  });

  it('uses each release body as written, without its own heading and commits link', () => {
    releasedRepo();
    const text = changelog('0.2.0');
    expect(sectionOf(text, '0.1.0')).toBe(
      '### New\n\n- Chat with a crew, as the maintainer reworded it.\n\n**Full Changelog**: kept as written',
    );
    expect(sectionOf(text, '0.1.1')).toBe('No user-facing changes: maintenance only.');
    expect(text).not.toContain('Changes since');
    expect(text).not.toContain('All commits:');
    expect(text).not.toContain('\r');
  });

  it('says "Maintenance only." for a release with an empty body', () => {
    releasedRepo();
    expect(sectionOf(changelog('0.2.0'), '0.0.9')).toBe('Maintenance only.');
  });

  it('gives the version being published the release notes since the last final tag, candidates included', () => {
    const shas = releasedRepo();
    const top = sectionOf(changelog('0.2.0'), '0.2.0');
    expect(top).toContain(`- Show the crew dashboard (${shas.show})`);
    expect(top).toContain(`- Rename a crew (${shas.rename})`);
    expect(top).toContain(`### Fixed\n\n- Reconnect a dropped stream (${shas.fix})`);
    expect(top).not.toContain('Chat with a crew');
  });

  it('heads a release candidate build with the candidate version', () => {
    releasedRepo();
    const text = changelog('0.2.0-rc.2');
    expect(headings(text)).toEqual(['0.2.0-rc.2', '0.1.1', '0.1.0', '0.0.9']);
    expect(sectionOf(text, '0.2.0-rc.2')).toContain('Rename a crew');
  });

  it('adds no extra entry when the version packaged already has a final release', () => {
    releasedRepo();
    git('checkout', '-q', 'v0.1.1');
    expect(headings(changelog('0.1.1'))).toEqual(['0.1.1', '0.1.0', '0.0.9']);
  });

  it('says "Maintenance only." for a version packaged with no user-facing change since the last final tag', () => {
    releasedRepo();
    commit('ci: cache npm');
    git('tag', 'v0.2.0');
    commit('test: cover the tree');
    expect(sectionOf(changelog('0.2.1'), '0.2.1')).toBe('Maintenance only.');
  });

  it('writes one entry from all of history before the first release', () => {
    serve([]);
    commit('feat: chat with a crew');
    commit('docs: describe the views');
    const text = changelog('0.1.0');
    expect(headings(text)).toEqual(['0.1.0']);
    expect(sectionOf(text, '0.1.0')).toMatch(/^### New\n\n- Chat with a crew \([0-9a-f]+\)$/);
  });

  it('reads the releases API of GITHUB_REPOSITORY, with GH_TOKEN when it is set', () => {
    releasedRepo();
    expect(run(['0.2.0'], lib, { GH_TOKEN: 'the-token' }).status).toBe(0);
    const calls = fs.readFileSync(curlLog, 'utf8').trim().split('\n');
    expect(calls[0]).toContain('https://api.github.com/repos/kubemoot/vscode-crewforge/releases?per_page=100&page=1');
    expect(calls[0]).toContain('Authorization: Bearer the-token');
    expect(calls.at(-1)).toContain('page=2');
  });

  it('sends no token when GH_TOKEN is unset', () => {
    releasedRepo();
    changelog('0.2.0');
    expect(fs.readFileSync(curlLog, 'utf8')).not.toContain('Authorization');
  });

  it('ends with one newline and uses no dashes but the ASCII hyphen', () => {
    releasedRepo();
    const text = changelog('0.2.0');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it('fails with status 2 and prints nothing when GitHub cannot be read', () => {
    releasedRepo();
    expectRefused(run(['0.2.0'], lib, { CURL_STUB_FAIL: '1' }), /cannot read the releases/);
  });

  it('fails with status 2 when the releases API does not return a list', () => {
    releasedRepo();
    fs.writeFileSync(releasesFile, '{"message": "Bad credentials"}');
    expectRefused(run(['0.2.0'], lib), /not a JSON list/);
  });

  it('fails with status 2 without GITHUB_REPOSITORY', () => {
    releasedRepo();
    expectRefused(run(['0.2.0'], lib, { GITHUB_REPOSITORY: '' }), /GITHUB_REPOSITORY/);
  });

  it.each([[[]], [['v0.2.0']], [['0.2']], [['0.2.0-beta.1']], [['']], [['0.2.0', 'extra']]])(
    'refuses %j as the version, printing the usage',
    (args) => {
      releasedRepo();
      expectRefused(run(args, lib), /^usage: /);
    },
  );

  it('refuses to run without the release library', () => {
    releasedRepo();
    for (const missing of ['', path.join(work, 'missing.sh')]) expectRefused(run(['0.2.0'], missing), /RELEASE_LIB/);
  });
});

describe('the committed CHANGELOG.md', () => {
  // Read from the commit, not the working tree: Publish Release writes the real
  // changelog before it runs these tests.
  const text = execFileSync('git', ['show', 'HEAD:CHANGELOG.md'], { cwd: repo, encoding: 'utf8' });

  it('stays a stub: packaging writes the real one, so nobody edits it by hand', () => {
    expect(text.trim().split('\n').filter((l) => l.trim() !== '').length).toBeLessThanOrEqual(3);
    expect(text).not.toMatch(/^## /m);
    expect(text).toContain(releasesUrl);
    expect(text).toMatch(/generated|packaged/i);
  });

  it('is shipped in the .vsix', () => {
    expect(read('.vscodeignore').split('\n')).toContain('!CHANGELOG.md');
  });
});

interface Step { name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string> }
type Jobs = Record<string, { steps: Step[] }>;
const stepsOf = (workflow: string, job: string) => (load(read(`.github/workflows/${workflow}`)) as { jobs: Jobs }).jobs[job].steps;

describe('writing the changelog in each packaging path', () => {
  const paths = [
    {
      workflow: 'release.yaml',
      job: 'release',
      pack: 'Package the candidate',
      write: 'scripts/changelog.sh "${VERSION}" > CHANGELOG.md',
      lib: 'release-candidate-version',
    },
    {
      workflow: 'publish-release.yaml',
      job: 'prepare',
      pack: 'Test and package at the final version',
      write: 'scripts/changelog.sh "${FINAL_TAG#v}" > CHANGELOG.md',
      lib: 'release-actions/setup',
    },
  ];
  const writeStep = 'Write the changelog';
  const indexOf = (steps: Step[], name: string) => {
    const index = steps.findIndex((s) => s.name === name);
    expect(index, name).toBeGreaterThanOrEqual(0);
    return index;
  };

  it.each(paths)('$workflow writes CHANGELOG.md for the packaged version in its own step', ({ workflow, job, write }) => {
    const step = stepsOf(workflow, job)[indexOf(stepsOf(workflow, job), writeStep)];
    expect(step.run?.trim()).toBe(write);
  });

  it.each(paths)('$workflow writes it after the checkout it packages and before the packaging step', ({ workflow, job, pack }) => {
    const steps = stepsOf(workflow, job);
    const write = indexOf(steps, writeStep);
    expect(write).toBeLessThan(indexOf(steps, pack));
    const lastCheckout = steps.findLastIndex((s, i) => i < write && (s.uses?.startsWith('actions/checkout') || s.run?.includes('git checkout')));
    expect(lastCheckout).toBeGreaterThanOrEqual(0);
  });

  it.each(paths)('$workflow gives the GitHub token to the changelog step only', ({ workflow, job }) => {
    const steps = stepsOf(workflow, job);
    expect(steps[indexOf(steps, writeStep)].env?.GH_TOKEN).toBe('${{ github.token }}');
    const holders = steps.filter((s) => JSON.stringify(s.env ?? {}).includes('GH_TOKEN')).map((s) => s.name);
    expect(holders).toEqual([writeStep]);
    const permissions = (load(read(`.github/workflows/${workflow}`)) as { jobs: Record<string, { permissions?: Record<string, string> }> })
      .jobs[job].permissions;
    expect(['read', 'write']).toContain(permissions?.contents);
  });

  it.each(paths)('$workflow runs the changelog step only when it packages', ({ workflow, job, pack }) => {
    const steps = stepsOf(workflow, job);
    expect(steps[indexOf(steps, writeStep)].if).toBe(steps[indexOf(steps, pack)].if);
  });

  it.each(paths)('$workflow has RELEASE_LIB before it writes the changelog', ({ workflow, job, lib }) => {
    const steps = stepsOf(workflow, job);
    const exporter = steps.findIndex((s) => s.uses?.includes(lib));
    expect(exporter).toBeGreaterThanOrEqual(0);
    expect(exporter).toBeLessThan(indexOf(steps, writeStep));
  });

  it('restores the stub after the final version packages', () => {
    const steps = stepsOf('publish-release.yaml', 'prepare');
    expect(steps[indexOf(steps, 'Test and package at the final version')].run).toMatch(/git checkout --quiet -- .*CHANGELOG\.md/);
  });
});
