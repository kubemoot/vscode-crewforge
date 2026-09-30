import { beforeEach, describe, expect, it } from 'vitest';
import type { CrewDetails } from '../src/crew/details';
import { liveDeployment, LiveCrewActions, noSource, sourceForCrew, type LiveCrewDeps } from '../src/deploy/liveCrew';
import type { CrewSummary } from '../src/k8s/crews';
import { ANNOTATIONS, type Deployment } from '../src/source/deployments';
import type { SourceEntry } from '../src/source/service';
import type { DeploymentNode } from '../src/views/sourceTree';
import { obj } from './fakeCluster';
import { recorded, resetFake } from './vscodeFake';

const entry = (id: string, crewName = 'lab-ops', root = `/w/${id}`): SourceEntry => ({ source: { kind: 'helm', root, label: id }, identity: { id }, crewName });

const crew = (labels: Record<string, string> = {}, annotations: Record<string, string> = {}): CrewSummary => ({ name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready', labels, annotations });
const HELM = { 'app.kubernetes.io/managed-by': 'Helm' };
const FLUX = { 'helm.toolkit.fluxcd.io/name': 'lab', 'helm.toolkit.fluxcd.io/namespace': 'flux-system' };

const DETAILS: CrewDetails = {
  crew: obj('Crew', 'lab-ops', 'team-a'),
  agents: [{ name: 'a', capabilities: [], ready: true, promptRefs: [], object: obj('Agent', 'a', 'team-a') }],
  skills: [],
  promptModules: [],
  mcpServers: [],
  tools: [],
  problems: [],
};

let calls: string[];
let nodes: DeploymentNode[];
let removed: { deployment: Deployment; objects: string[] }[];
let followed: Deployment[];
let sources: SourceEntry[];

function actions(): LiveCrewActions {
  const record = (name: string) => async (node?: unknown) => {
    calls.push(name);
    nodes.push(node as DeploymentNode);
  };
  const deps: LiveCrewDeps = {
    sources: async () => sources,
    deploy: {
      updateDeployment: record('update'),
      deployRevision: record('revision'),
      removeDeployment: record('remove'),
      removeUnsourced: async (deployment, objects) => {
        calls.push('removeUnsourced');
        removed.push({ deployment, objects: objects.map((o) => `${o.kind}/${o.metadata.name}`) });
      },
    },
    fitness: { runFitness: async (node) => void (await record('fitness')(node)) },
    details: async () => DETAILS,
    follow: async (deployment) => {
      followed.push(deployment);
    },
  };
  return new LiveCrewActions(deps);
}

beforeEach(() => {
  resetFake();
  calls = [];
  nodes = [];
  removed = [];
  followed = [];
  sources = [];
});

describe('liveDeployment', () => {
  it('reads the channel, release, and recorded source from the Crew', () => {
    const d = liveDeployment(crew(HELM, { 'meta.helm.sh/release-name': 'lab', [ANNOTATIONS.source]: 'src' }));
    expect(d).toMatchObject({ namespace: 'team-a', channel: 'helm', release: 'lab', linked: true });
    expect(liveDeployment(crew()).linked).toBe(false);
    expect(liveDeployment(crew(FLUX)).channel).toBe('flux');
  });
});

describe('sourceForCrew', () => {
  it('finds the source a crew names, else the only one of its name, without asking', () => {
    expect(sourceForCrew(crew({}, { [ANNOTATIONS.source]: 'b' }), [entry('a'), entry('b')])?.identity.id).toBe('b');
    expect(sourceForCrew(crew(), [entry('a'), entry('x', 'other')])?.identity.id).toBe('a');
    expect(sourceForCrew(crew(), [entry('a'), entry('b')])).toBeUndefined();
    expect(sourceForCrew(crew(), [])).toBeUndefined();
  });
});

describe('resolving a live crew to its source', () => {
  it('prefers the source the Crew names, over others that render the same name', async () => {
    sources = [entry('other'), entry('named'), entry('elsewhere', 'different')];
    await actions().update(crew(HELM, { [ANNOTATIONS.source]: 'named' }));
    expect(calls).toEqual(['update']);
    expect(nodes[0].entry.identity.id).toBe('named');
    expect(nodes[0].deployment).toMatchObject({ namespace: 'team-a', channel: 'helm', linked: true });
    expect(recorded.quickPicks).toEqual([]);
  });

  it('takes the one source of the crew name, unlinked, so the command can warn', async () => {
    sources = [entry('only'), entry('x', 'different')];
    await actions().deployRevision(crew());
    expect(calls).toEqual(['revision']);
    expect(nodes[0].deployment.linked).toBe(false);
  });

  it('asks which source when several render the crew, and stops quietly when cancelled', async () => {
    sources = [entry('one'), entry('two')];
    recorded.quickPicks.push((items: { entry: SourceEntry }[]) => items[1]);
    await actions().runFitness(crew());
    expect(nodes[0].entry.identity.id).toBe('two');
    recorded.quickPicks.push(undefined);
    await actions().runFitness(crew());
    expect(calls).toEqual(['fitness']);
    expect(recorded.info).toEqual([]);
  });

  it('says what to do when no source is known', async () => {
    sources = [entry('x', 'different')];
    await actions().update(crew());
    await actions().deployRevision(crew());
    await actions().runFitness(crew());
    expect(calls).toEqual([]);
    expect(recorded.info).toEqual([
      noSource(crew(), 'update it from its source'),
      noSource(crew(), 'deploy one of its revisions'),
      noSource(crew(), 'run the fitness its source defines'),
    ]);
    expect(recorded.info[0]).toBe(
      "CrewForge does not know the source of lab-ops in team-a, so it cannot update it from its source. Open the folder that holds the crew's Helm chart or bundle in this workspace; Crew Sources links it by the crew's name.",
    );
  });
});

describe('Flux-managed live crews', () => {
  it('points updates and rollbacks at git, and follows the rollout', async () => {
    sources = [entry('src')];
    const flux = crew(FLUX);
    await actions().update(flux);
    await actions().deployRevision(flux);
    await actions().remove(flux);
    expect(calls).toEqual([]);
    expect(recorded.info[0]).toContain('the HelmRelease lab manages lab-ops in team-a');
    expect(recorded.info[1]).toContain('revert the commit instead');
    expect(recorded.info[2]).toContain('removing it from git removes the crew');
    await actions().followRollout(flux);
    expect(followed.map((d) => d.channel)).toEqual(['flux']);
  });

  it('still runs fitness from the source', async () => {
    sources = [entry('src')];
    await actions().runFitness(crew(FLUX));
    expect(calls).toEqual(['fitness']);
  });
});

describe('removing a live crew', () => {
  it('goes through the source when it is known', async () => {
    sources = [entry('src')];
    await actions().remove(crew(HELM));
    expect(calls).toEqual(['remove']);
  });

  it('uninstalls a Helm crew without a source, and deletes the Kubemoot objects of any other', async () => {
    await actions().remove(crew(HELM, { 'meta.helm.sh/release-name': 'lab' }));
    await actions().remove(crew());
    expect(calls).toEqual(['removeUnsourced', 'removeUnsourced']);
    expect(removed[0]).toMatchObject({ deployment: { channel: 'helm', release: 'lab' }, objects: [] });
    expect(removed[1]).toMatchObject({ deployment: { channel: 'bundle' }, objects: ['Agent/a', 'Crew/lab-ops'] });
  });

  it('refuses a Helm crew that does not name its release, rather than guess it', async () => {
    await actions().remove(crew(HELM));
    expect(calls).toEqual([]);
    expect(recorded.info[0]).toContain('does not say which release installed it');
  });

  it('stops when the developer cancels the source pick', async () => {
    sources = [entry('one'), entry('two')];
    recorded.quickPicks.push(undefined);
    await actions().remove(crew());
    expect(calls).toEqual([]);
  });
});
