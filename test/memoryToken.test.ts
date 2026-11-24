import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDashboard } from '../src/dashboard/memoryDashboard';
import { renderMemoryPage } from '../src/dashboard/memoryPage';
import { KubeError, type KubeTransport } from '../src/k8s/request';
import type { MemoryConnection } from '../src/memory/connect';
import { explainStatus, MemoryError } from '../src/memory/relay';
import { CHECKS_AT_ONCE, findMintableAccounts, noAccountsMessage } from '../src/memory/serviceAccounts';
import { TOKEN_SECONDS } from '../src/discussion/gateway';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { recorded, resetFake } from './vscodeFake';

/** A cluster that lists ServiceAccounts per namespace and says which ones the caller may mint tokens for. */
class Accounts implements KubeTransport {
  calls: string[] = [];
  constructor(
    private readonly accounts: Record<string, string[]>,
    private readonly allowed: Set<string>,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<string> {
    this.calls.push(`${method} ${path}`);
    const list = /\/api\/v1\/namespaces\/([^/]+)\/serviceaccounts$/.exec(path);
    if (list) {
      const names = this.accounts[list[1]];
      if (!names) throw new KubeError('forbidden', 403);
      return JSON.stringify({ items: names.map((name) => ({ metadata: { name } })) });
    }
    const attrs = (body as { spec: { resourceAttributes: { namespace: string; name: string; verb: string; resource: string; subresource: string } } }).spec.resourceAttributes;
    expect(attrs).toMatchObject({ verb: 'create', resource: 'serviceaccounts', subresource: 'token' });
    return JSON.stringify({ status: { allowed: this.allowed.has(`${attrs.namespace}/${attrs.name}`) } });
  }

  stream(): Promise<void> {
    return Promise.resolve();
  }
}

describe('findMintableAccounts', () => {
  it('lists only the accounts the cluster says the caller may create a token for, across the namespaces', async () => {
    const api = new Accounts({ 'crew-demo': ['default', 'reader'], kubemoot: ['operator'] }, new Set(['crew-demo/reader', 'kubemoot/operator']));
    const found = await findMintableAccounts(api, ['crew-demo', 'kubemoot', 'crew-demo']);
    expect(found).toEqual({ accounts: ['crew-demo/reader', 'kubemoot/operator'], unreadable: [], unanswered: 0 });
    expect(api.calls.filter((c) => c.startsWith('GET'))).toHaveLength(2);
  });

  it('reports a namespace it may not list apart from none being allowed', async () => {
    const api = new Accounts({ kubemoot: ['operator', 'other'] }, new Set(['kubemoot/operator']));
    expect(await findMintableAccounts(api, ['hidden', 'kubemoot'])).toEqual({ accounts: ['kubemoot/operator'], unreadable: ['hidden'], unanswered: 0 });
    expect(await findMintableAccounts(new Accounts({ kubemoot: ['a'] }, new Set()), ['kubemoot'])).toEqual({ accounts: [], unreadable: [], unanswered: 0 });
    expect((await findMintableAccounts(new Accounts({}, new Set()), ['../x'])).unreadable).toEqual(['../x']);
  });

  it('counts the checks the cluster did not answer', async () => {
    const broken: KubeTransport = { request: (_m, path) => (path.includes('selfsubject') ? Promise.reject(new Error('down')) : Promise.resolve('{"items":[{"metadata":{"name":"a"}},{"metadata":{}}]}')), stream: () => Promise.resolve() };
    expect(await findMintableAccounts(broken, ['x'])).toEqual({ accounts: [], unreadable: [], unanswered: 1 });
    expect(await findMintableAccounts({ request: () => Promise.resolve('{}'), stream: () => Promise.resolve() }, ['x'])).toEqual({ accounts: [], unreadable: [], unanswered: 0 });
  });

  it('runs a few access checks at a time', async () => {
    let running = 0;
    let most = 0;
    const names = Array.from({ length: 12 }, (_, i) => ({ metadata: { name: `a${i}` } }));
    const api: KubeTransport = {
      request: async (method) => {
        if (method === 'GET') return JSON.stringify({ items: names });
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
        return '{"status":{"allowed":true}}';
      },
      stream: () => Promise.resolve(),
    };
    expect((await findMintableAccounts(api, ['x'])).accounts).toHaveLength(12);
    expect(most).toBe(CHECKS_AT_ONCE);
  });

  it('says why nothing was found', () => {
    const none = { accounts: [], unreadable: [], unanswered: 0 };
    expect(noAccountsMessage(none, ['a', 'b'])).toContain('lets you create tokens');
    expect(noAccountsMessage({ ...none, unreadable: ['a', 'b'] }, ['a', 'b'])).toContain('could not list the ServiceAccounts in a or b');
    expect(noAccountsMessage({ ...none, unreadable: ['a'] }, ['a', 'b'])).toContain('lets you create tokens');
    expect(noAccountsMessage({ ...none, unanswered: 1 }, ['a'])).toContain('did not answer 1 access check,');
    expect(noAccountsMessage({ ...none, unanswered: 3 }, ['a'])).toContain('3 access checks');
  });
});

describe('the token settings', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, { scope?: string; markdownDescription?: string }> } } };
  const props = manifest.contributes.configuration.properties;

  it('cannot be set by a workspace, which must not choose whose credentials mint a token', () => {
    expect(props['crewforge.tokenServiceAccount'].scope).toBe('machine');
    expect(props['crewforge.tokenAudiences'].scope).toBe('machine');
  });

  it('say the lifetime the code uses', () => {
    expect(props['crewforge.tokenServiceAccount'].markdownDescription).toContain(`${{ 10: 'ten' }[TOKEN_SECONDS / 60]}-minute`);
  });
});

describe('a 401 for a kubeconfig with no token', () => {
  const where = { namespace: 'crew-demo', crew: 'demo', context: 'lab', sentToken: false };

  it('says what to do in plain words, with no raw status in the message, and marks that a ServiceAccount fixes it', () => {
    const err = explainStatus(401, 'a valid bearer token is required', where);
    expect(err.needsToken).toBe(true);
    expect(err.message).toContain('Choose a ServiceAccount');
    expect(err.message).not.toMatch(/GET memory-export|401/);
  });

  it('does not offer a ServiceAccount when a token was sent or an account is already chosen', () => {
    expect(explainStatus(401, '', { ...where, sentToken: true }).needsToken).toBe(false);
    expect(explainStatus(401, '', { ...where, serviceAccount: 'ops/a' }).needsToken).toBe(false);
    expect(explainStatus(403, '', where).needsToken).toBe(false);
  });
});

describe('the memory page of a crew read with a certificate kubeconfig', () => {
  let failure: Error | undefined;
  let api: Accounts;
  const crew = { name: 'demo', namespace: 'crew-demo', ready: true, phase: 'Ready' } as never;
  const connect = (): MemoryConnection => ({
    context: 'lab',
    config: {} as never,
    client: api,
    operatorNamespace: 'kubemoot',
    relay: { read: () => Promise.reject(failure) } as never,
  });

  beforeEach(() => {
    resetFake();
    api = new Accounts({ 'crew-demo': ['reader'], kubemoot: [] }, new Set(['crew-demo/reader']));
    failure = explainStatus(401, 'a valid bearer token is required', { namespace: 'crew-demo', crew: 'demo', context: 'lab', sentToken: false });
  });

  it('offers to choose a ServiceAccount and to open the setting, and does not print the raw status', async () => {
    const html = await new MemoryDashboard(crew, connect).render();
    expect(html).toContain('data-action="chooseAccount"');
    expect(html).toContain('data-action="openTokenSetting"');
    expect(html).not.toContain('Details:');
    expect(html).not.toContain('GET memory-export');
  });

  it('offers neither for another failure', async () => {
    failure = new MemoryError('Reading the memory of crew demo needs get on the Crew demo.', 403, 'GET memory-export returned 403');
    const html = await new MemoryDashboard(crew, connect).render();
    expect(html).not.toContain('chooseAccount');
    expect(html).toContain('Details: GET memory-export returned 403');
  });

  it('keeps the account picked in the setting the chat uses, so the next read mints a token', async () => {
    const page = new MemoryDashboard(crew, connect);
    await page.render();
    recorded.quickPicks.push((items: unknown[]) => items[0]);
    await page.actions.chooseAccount();
    expect(recorded.settings.get('crewforge.tokenServiceAccount')).toBe('crew-demo/reader');
    expect(recorded.quickPickPlaceholders.at(-1)).toMatch(/ServiceAccount/);
  });

  it('changes nothing when the pick is dismissed, and says so when there is nothing to pick', async () => {
    const page = new MemoryDashboard(crew, connect);
    await page.render();
    recorded.quickPicks.push(undefined);
    await page.actions.chooseAccount();
    expect(recorded.settings.has('crewforge.tokenServiceAccount')).toBe(false);
    api = new Accounts({ 'crew-demo': [], kubemoot: [] }, new Set());
    await page.render();
    await page.actions.chooseAccount();
    expect(recorded.info.at(-1)).toContain('lets you create tokens');
    expect(recorded.info.at(-1)).toContain('crewforge.tokenServiceAccount');
  });

  it('says to read first when the page has not read yet', async () => {
    await new MemoryDashboard(crew, connect).actions.chooseAccount();
    expect(recorded.quickPickPlaceholders).toEqual([]);
    expect(recorded.info.at(-1)).toContain('has not read yet');
  });

  it('opens the setting', async () => {
    await new MemoryDashboard(crew, connect).actions.openTokenSetting();
    expect(recorded.executed.at(-1)).toMatchObject({ id: 'workbench.action.openSettings' });
  });
});

describe('renderMemoryPage', () => {
  it('shows the token buttons only when asked', () => {
    const base = { crew: 'demo', title: 'Demo', namespace: 'crew-demo', context: 'lab', error: 'x' };
    expect(renderMemoryPage({ ...base, needsToken: true })).toContain('Choose a ServiceAccount...');
    expect(renderMemoryPage(base)).not.toContain('Choose a ServiceAccount');
  });
});
