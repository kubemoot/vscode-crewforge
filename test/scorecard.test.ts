import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repo = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');

interface Step { uses?: string; with?: Record<string, unknown> }
interface Job { 'runs-on': string; permissions?: Record<string, string>; env?: unknown; defaults?: unknown; container?: unknown; services?: unknown; steps: Step[] }
interface Workflow { on: Record<string, unknown>; permissions?: Record<string, string>; env?: unknown; defaults?: unknown; jobs: Record<string, Job> }

const workflow = load(read('.github/workflows/scorecard.yaml')) as Workflow;
const jobs = Object.values(workflow.jobs);
const job = jobs[0];

/** The actions the Scorecard API accepts in a job that publishes results. */
const approved = ['actions/checkout', 'actions/upload-artifact', 'github/codeql-action/upload-sarif', 'ossf/scorecard-action', 'step-security/harden-runner'];

describe('the Scorecard workflow', () => {
  it('runs weekly and on every push to main', () => {
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    expect(workflow.on.schedule).toHaveLength(1);
  });

  it('has no workflow-level write permission, env, or defaults (the Scorecard API rejects them)', () => {
    expect(Object.values(workflow.permissions ?? {})).not.toContain('write');
    expect(workflow.env).toBeUndefined();
    expect(workflow.defaults).toBeUndefined();
  });

  it('grants the one job only what publishing and code scanning need', () => {
    expect(jobs).toHaveLength(1);
    expect(job.permissions).toEqual({ contents: 'read', 'security-events': 'write', 'id-token': 'write' });
  });

  it('runs on a GitHub-hosted Ubuntu runner with no env, defaults, container, or services', () => {
    expect(job['runs-on']).toMatch(/^ubuntu-/);
    for (const key of ['env', 'defaults', 'container', 'services'] as const) expect(job[key], key).toBeUndefined();
  });

  it('uses only approved actions, each pinned by a full commit sha', () => {
    for (const step of job.steps) {
      const [name, ref] = (step.uses ?? '').split('@');
      expect(approved, step.uses).toContain(name);
      expect(ref, step.uses).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('publishes the results and uploads the SARIF to code scanning', () => {
    const scorecard = job.steps.find((s) => s.uses?.startsWith('ossf/scorecard-action@'));
    expect(scorecard?.with).toMatchObject({ publish_results: true, results_format: 'sarif' });
    const upload = job.steps.find((s) => s.uses?.startsWith('github/codeql-action/upload-sarif@'));
    expect(upload?.with?.sarif_file).toBe(scorecard?.with?.results_file);
  });

  it('checks out without keeping the token in the git config', () => {
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });
});

describe('the Scorecard badge', () => {
  it('sits on the README badge line and links to the Scorecard viewer', () => {
    const line = read('README.md').split('\n').find((l) => l.startsWith('[![Latest release]'));
    expect(line).toContain(
      '[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/kubemoot/vscode-crewforge?label=openssf%20scorecard)](https://scorecard.dev/viewer/?uri=github.com/kubemoot/vscode-crewforge)',
    );
  });
});
