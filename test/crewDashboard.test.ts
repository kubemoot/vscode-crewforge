import { noRelated } from '../src/crew/related';
import type { Declarations } from '../src/source/declared';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toAgent } from '../src/crew/details';
import { crewButtons, renderCrewPage } from '../src/dashboard/crewPage';
import { agentsByRole, gatherVitals, parseHelmStatus, type CrewVitals, type VitalsDeps } from '../src/dashboard/crewVitals';
import type { CrewSummary } from '../src/k8s/crews';
import type { Located } from '../src/source/locate';
import type { SourceEntry } from '../src/source/service';
import { newConversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import { conversationStats } from '../src/store/stats';
import { obj } from './fakeCluster';

const entry: SourceEntry = { source: { kind: 'helm', root: '/w/demo', label: 'demo' }, identity: { id: 'local:demo' }, crewName: 'demo', chart: { name: 'demo', version: '0.2.2', appVersion: '1.0', description: 'chart text' } };
const crew = (over: Partial<CrewSummary> = {}): CrewSummary => ({
  name: 'demo',
  namespace: 'crew-demo',
  ready: true,
  phase: 'Ready',
  agents: 2,
  labels: { 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': 'demo-0.46.0-rc.0', 'app.kubernetes.io/version': '1.1' },
  annotations: { 'meta.helm.sh/release-name': 'demo', 'crewforge.kubemoot.ai/deployed-at': '2026-09-30T10:00:00Z', 'crewforge.kubemoot.ai/owner': 'me@example.com' },
  conditions: [{ type: 'Ready', status: 'True', reason: 'AgentsReady', message: 'all agents ready' }],
  created: '2026-09-29T10:00:00Z',
  ...over,
});

function agentObj(name: string, role: string, ready: boolean) {
  const a = obj('Agent', name, 'crew-demo', { discussRole: role, capabilities: ['tool-calling'] }, { 'kubemoot.ai/crew': 'demo' });
  a.status = { ready, phase: ready ? 'Running' : 'Pending' };
  return a;
}

const located: Located[] = [
  { manifest: obj('Crew', 'demo', 'default', { description: 'source text' }), file: '/w/demo/templates/crew.yaml', line: 0 },
  { manifest: agentObj('demo-coordinator', 'coordinator', false), file: '/w/demo/templates/agents.yaml', line: 0 },
  { manifest: obj('Model', 'qwen-8b', 'default', { model: 'qwen3:8b' }), line: 0 },
  { manifest: obj('Model', 'bare', 'default', {}), line: 0 },
  { manifest: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'x' } }, line: 0 },
];

function deps(over: Partial<VitalsDeps> = {}): VitalsDeps {
  return {
    context: () => 'lab',
    deploymentOf: async (e) => ({ kind: 'deployment', entry: e, deployment: { namespace: 'crew-demo', crew: crew(), channel: 'helm', release: 'demo', linked: true } }),
    liveCrew: async () => crew({ phase: 'Reconciling', ready: false }),
    located: async () => located,
    liveDetails: async () => ({ crew: obj('Crew', 'demo', 'crew-demo'), agents: [toAgent(agentObj('demo-coordinator', 'coordinator', true)), toAgent(agentObj('demo-tooler', 'tooler', false))], skills: [], promptModules: [], mcpServers: [], tools: [], related: noRelated(), problems: [] }),
    helm: async () => ({ firstDeployed: '2026-09-29T10:00:00Z', lastDeployed: '2026-09-30T10:00:00Z', revision: 3, status: 'deployed' }),
    conversations: async () => ({ total: 2, turns: 5, active: 'Which nodes?', errors: [{ at: '2026-09-30T10:05:00Z', text: 'Agent k8s failed' }] }),
    kubemoot: async () => ({ threads: 7, failures: 1, recentFailures: ['k8s: tool timed out'], messages: 120 }),
    fitnessRunning: () => false,
    ...over,
  };
}

describe('gatherVitals', () => {
  it('joins the source, the deployment Redeploy goes to, the live agents, Helm, conversations, and discussions', async () => {
    const v = await gatherVitals({ entry }, deps());
    expect(v).toMatchObject({ name: 'demo', description: 'source text', context: 'lab', agentsFrom: 'live', fitnessRunning: false, sourceAt: { file: '/w/demo/templates/crew.yaml', line: 0 } });
    expect(v.deployment?.namespace).toBe('crew-demo');
    expect(v.provenance).toMatchObject({ chartVersion: '0.46.0-rc.0', appVersion: '1.1', owner: 'me@example.com' });
    expect(v.helm?.revision).toBe(3);
    expect(v.models).toEqual([{ name: 'qwen-8b', model: 'qwen3:8b' }, { name: 'bare', model: undefined }]);
    expect(agentsByRole(v.agents)).toEqual([['coordinator', 1], ['tooler', 1]]);
    expect(v.conversations.turns).toBe(5);
    expect(v.kubemoot).toMatchObject({ threads: 7 });
  });

  it('shows what an undeployed source declares', async () => {
    const v = await gatherVitals({ entry }, deps({ deploymentOf: async () => undefined }));
    expect(v).toMatchObject({ description: 'source text', agentsFrom: 'source', conversations: { total: 0 } });
    expect(v.agents.map((a) => a.name)).toEqual(['demo-coordinator']);
    expect(v.deployment).toBeUndefined();
    const bare = await gatherVitals({ entry: { ...entry, crewName: undefined } }, deps({ deploymentOf: async () => undefined }));
    expect(bare).toMatchObject({ name: 'demo', agentsFrom: 'none', description: 'chart text' });
  });

  it('reads a live crew without a source again, falling back to the one given', async () => {
    const v = await gatherVitals({ crew: crew() }, deps());
    expect(v.deployment?.crew.phase).toBe('Reconciling');
    const gone = await gatherVitals({ crew: crew() }, deps({ liveCrew: async () => undefined }));
    expect(gone.deployment?.crew.phase).toBe('Ready');
    expect((await gatherVitals({}, deps())).name).toBe('');
  });

  it('says why a part cannot be read instead of failing the page', async () => {
    const v = await gatherVitals(
      { entry, crew: crew() },
      deps({
        deploymentOf: async () => {
          throw new Error('cluster down');
        },
        located: async () => {
          throw new Error('helm failed');
        },
        liveDetails: async () => {
          throw new Error('agents forbidden');
        },
        helm: async () => {
          throw new Error('no helm');
        },
        conversations: async () => {
          throw new Error('disk');
        },
        kubemoot: async () => {
          throw new Error('proxy');
        },
      }),
    );
    expect(v).toMatchObject({ deploymentError: 'cluster down', agentsError: 'agents forbidden', agentsFrom: 'none', helm: undefined, conversations: { total: 0 }, kubemoot: { unavailable: 'proxy' } });
    const noCrew = await gatherVitals(
      { entry },
      deps({
        deploymentOf: async () => {
          throw new Error('cluster down');
        },
      }),
    );
    expect(noCrew.deployment).toBeUndefined();
  });

  it('asks Helm only for a release, and counts agents without a role', async () => {
    let asked = 0;
    const helm = async () => void asked++;
    await gatherVitals({ entry }, deps({ helm, deploymentOf: async (e) => ({ kind: 'deployment', entry: e, deployment: { namespace: 'n', crew: crew(), channel: 'bundle', linked: true } }) }));
    await gatherVitals({ entry }, deps({ helm, deploymentOf: async (e) => ({ kind: 'deployment', entry: e, deployment: { namespace: 'n', crew: crew(), channel: 'helm', linked: true } }) }));
    expect(asked).toBe(0);
    expect(agentsByRole([toAgent(obj('Agent', 'a', 'n')), toAgent(obj('Agent', 'b', 'n'))])).toEqual([['no role', 2]]);
  });
});

describe('the Contents of a crew', () => {
  const declarations = async (): Promise<Declarations> => ({ sections: [{ section: 'agents', items: [{ label: 'a', tooltip: '', icon: 'x', line: 0 }] }, { section: 'models', items: [] }] });

  it("counts every group of the live crew, and links each to the tree", async () => {
    const v = await gatherVitals({ entry }, deps({ declarations }));
    expect(v.contentsFrom).toBe('live');
    expect(v.contents.map((c) => `${c.group}:${c.count}`)).toEqual(['agents:2', 'prompts:0', 'skills:0', 'models:0', 'rag:0', 'mcp:0', 'tools:0', 'policies:0', 'notifications:0', 'fitness:0', 'deployment:1']);
    const html = renderCrewPage(v);
    expect(html).toContain('<h2>Contents</h2>');
    expect(html).toContain('data-action="group" data-arg="rag" title="Show the RAG Sources group in the tree">RAG Sources 0</button>');
    expect(html).toContain('>Agents 2</button> · ');
    expect(html).toContain('>Deployment</button>');
    expect(html).toContain('From the cluster; a group opens it in Deployed Crews.');
  });

  it('counts what an undeployed source declares, and leaves the section out when nothing can be counted', async () => {
    const v = await gatherVitals({ entry }, deps({ declarations, deploymentOf: async () => undefined }));
    expect(v).toMatchObject({ contentsFrom: 'source', contents: [{ group: 'agents', count: 1 }, { group: 'models', count: 0 }] });
    expect(renderCrewPage(v)).toContain('Declared in the source; a group opens it in Crew Sources.');
    expect(renderCrewPage(v)).toContain('>Models 0</button>');
    const failed = await gatherVitals(
      { entry },
      deps({
        deploymentOf: async () => undefined,
        declarations: async () => {
          throw new Error('render failed');
        },
      }),
    );
    expect(failed).toMatchObject({ contentsFrom: 'none', contents: [] });
    expect(renderCrewPage(failed)).not.toContain('<h2>Contents</h2>');
    expect((await gatherVitals({ entry }, deps({ deploymentOf: async () => undefined }))).contentsFrom).toBe('none');
  });
});

describe('parseHelmStatus', () => {
  it('reads first and last deploy times, revision, and status', () => {
    expect(parseHelmStatus('{"version":3,"info":{"first_deployed":"a","last_deployed":"b","status":"deployed"}}')).toEqual({ firstDeployed: 'a', lastDeployed: 'b', revision: 3, status: 'deployed' });
    expect(parseHelmStatus('{}')).toEqual({ firstDeployed: undefined, lastDeployed: undefined, revision: undefined, status: undefined });
    expect(parseHelmStatus('not json')).toBeUndefined();
  });
});

describe('renderCrewPage', () => {
  const vitals = async (over: Partial<VitalsDeps> = {}) => gatherVitals({ entry }, deps(over));
  const enabled = (v: CrewVitals) => crewButtons(v).filter((b) => !b.disabled).map((b) => b.action);

  it('shows a deployed crew: status, deployment times, agents by role, conditions, conversations, and discussions', async () => {
    const v = await vitals();
    const html = renderCrewPage(v);
    for (const text of ['<h1>demo <span class="badge good">Ready</span></h1>', 'crew-demo in lab', 'Chart version differs: source 0.2.2, deployed 0.46.0-rc.0', '/w/demo', 'Helm chart', '2026-09-29T10:00:00Z', 'me@example.com', '1 coordinator, 1 tooler', 'AgentsReady', 'Which nodes?', 'Agent k8s failed', 'Threads', 'k8s: tool timed out', 'qwen-8b (qwen3:8b), bare']) {
      expect(html).toContain(text);
    }
    expect(enabled(v)).toEqual(['deploy', 'redeploy', 'undeploy', 'ask', 'fitness', 'fitnessDashboard', 'lint', 'yaml', 'refresh']);
  });

  it('offers Deploy for an undeployed source, and names why the other buttons are off', async () => {
    const v = await vitals({ deploymentOf: async () => undefined });
    const html = renderCrewPage(v);
    expect(html).toContain('not deployed in lab');
    expect(html).toContain('Declared in the source; not deployed.');
    expect(html).not.toContain('Live status');
    expect(enabled(v)).toEqual(['deploy', 'lint', 'yaml', 'refresh']);
    expect(crewButtons(v).find((b) => b.action === 'ask')?.disabled).toBe('demo is not deployed in lab.');
  });

  it('blocks Run Fitness while a run is going, and lifecycle buttons for a Flux crew', async () => {
    const running = await vitals({ fitnessRunning: () => true });
    expect(crewButtons(running).find((b) => b.action === 'fitness')?.disabled).toBe('A fitness run for this crew is in progress.');
    const flux = await vitals({ deploymentOf: async (e) => ({ kind: 'deployment', entry: e, deployment: { namespace: 'n', crew: crew({ labels: { 'helm.toolkit.fluxcd.io/name': 'demo' } }), channel: 'flux', linked: true } }) });
    expect(crewButtons(flux).find((b) => b.action === 'undeploy')?.disabled).toBe('Flux manages this crew; change it through git.');
  });

  it('shows a live crew without a source, and every failure as text', async () => {
    const v = await gatherVitals(
      { crew: crew({ ready: false, phase: 'Pending', message: '<script>alert(1)</script>', conditions: [{ type: 'Ready', status: 'False' }] }) },
      deps({
        liveCrew: async () => undefined,
        liveDetails: async () => {
          throw new Error('forbidden');
        },
        kubemoot: async () => ({ unavailable: 'No Kubemoot dashboard found.' }),
        conversations: async () => ({ total: 0, turns: 0, errors: [] }),
      }),
    );
    const html = renderCrewPage(v);
    expect(html).toContain('No workspace source renders this crew');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Cannot read the live agents: forbidden');
    expect(html).toContain('No Kubemoot dashboard found.');
    expect(html).toContain('No failed turns or agent failures saved.');
    expect(html).toContain('badge warn');
    expect(enabled(v)).toEqual(['undeploy', 'ask', 'fitnessDashboard', 'yaml', 'refresh']);
  });

  it('says when it cannot tell where the crew is deployed, and when the source failed to render', async () => {
    const v = await gatherVitals(
      { entry: { ...entry, error: 'helm template failed' } },
      deps({
        deploymentOf: async () => {
          throw new Error('cluster down');
        },
      }),
    );
    const html = renderCrewPage(v);
    expect(html).toContain('Cannot tell where it is deployed: cluster down');
    expect(html).toContain('helm template failed');
    const empty = renderCrewPage({ ...(await gatherVitals({ entry: { ...entry, crewName: undefined, chart: undefined } }, deps({ deploymentOf: async () => undefined }))), sourceAt: undefined });
    expect(empty).toContain('No agents found.');
  });
});

describe('conversationStats', () => {
  it('counts conversations and questions, and lists the newest saved problems', async () => {
    const store = new ConversationStore(fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-stats-')));
    const a = newConversation('lab', 'crew-demo', 'demo', new Date('2026-09-30T09:00:00Z'));
    a.messages.push({ role: 'user', content: 'q1', timestamp: '2026-09-30T09:00:00Z' }, { role: 'assistant', content: 'a1', timestamp: '2026-09-30T09:01:00Z', problems: ['Agent k8s failed', 'timed out'] });
    const b = newConversation('lab', 'crew-demo', 'demo', new Date('2026-09-30T10:00:00Z'));
    b.messages.push({ role: 'user', content: 'q2', timestamp: '2026-09-30T10:00:00Z' }, { role: 'system', content: 'Stopped.', timestamp: '2026-09-30T10:02:00Z', problems: ['stopped'] }, { role: 'user', content: 'q3', timestamp: '2026-09-30T10:03:00Z' });
    await store.save(a);
    await store.save(b);
    const stats = await conversationStats(store, 'lab', 'crew-demo', 'demo', 'q3');
    expect(stats).toEqual({
      total: 2,
      turns: 3,
      active: 'q3',
      errors: [
        { at: '2026-09-30T10:02:00Z', text: 'stopped' },
        { at: '2026-09-30T09:01:00Z', text: 'Agent k8s failed' },
        { at: '2026-09-30T09:01:00Z', text: 'timed out' },
      ],
    });
    fs.writeFileSync(store.file(a), JSON.stringify({ id: a.id, crewName: 'demo', title: 't', startedAt: a.startedAt }));
    expect((await conversationStats(store, 'lab', 'crew-demo', 'demo')).turns).toBe(2);
    expect(await conversationStats(store, 'lab', 'crew-demo', 'other')).toEqual({ total: 0, turns: 0, active: undefined, errors: [] });
  });
});
