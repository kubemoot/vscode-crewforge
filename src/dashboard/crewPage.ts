import { GROUPS } from '../crew/groups';
import { chartVersionBanner } from '../source/normalize';
import { tabBar, type CrewTab } from './crewTabs';
import { agentsByRole, type CrewVitals } from './crewVitals';
import { badge, banner, buttons, escape, facts, note, section, SELECT_CONTEXT_BUTTON, table, readyTone, type ButtonSpec, type Shown } from './html';

/** The crew dashboard's page body: the header, the buttons, the tabs, and the shown tab (the overview unless `body` is given). */
export function renderCrewPage(v: CrewVitals, tab: CrewTab = 'overview', body?: string): string {
  const shown = body ?? [sourceSection(v), deploymentSection(v), contentsSection(v), agentsSection(v), statusSection(v), conversationsSection(v), kubemootSection(v)].join('');
  return [header(v), buttons(crewButtons(v)), tabBar(tab), shown].join('');
}

function header(v: CrewVitals): string {
  const state = v.deployment ? badge(v.deployment.crew.phase, readyTone(v.deployment.crew.ready)) : badge('not deployed');
  const where = v.deployment ? `${v.deployment.namespace} in ${v.context}` : `not deployed in ${v.context}`;
  const description = v.description ? `<p>${escape(v.description)}</p>` : '';
  const version = chartVersionBanner(v.source?.chart?.version, v.provenance?.chartVersion);
  return `<h1>${escape(v.name)} ${state}</h1><p class="muted">${escape(where)}</p>${description}${version ? banner(version) : ''}`;
}

/** The first reason that blocks a button, if any. */
const blocked = (...reasons: (string | undefined)[]) => reasons.find((r) => r !== undefined);

/** Why each kind of action does not apply to this crew now; undefined where it does. */
function reasons(v: CrewVitals): { noSource?: string; notDeployed?: string; flux?: string; running?: string; nothingToShow?: string } {
  return {
    noSource: v.source?.crewName ? undefined : 'No workspace source renders this crew; open its folder to deploy or lint it.',
    notDeployed: v.deployment ? undefined : `${v.name} is not deployed in ${v.context}.`,
    flux: v.deployment?.channel === 'flux' ? 'Flux manages this crew; change it through git.' : undefined,
    running: v.fitnessRunning ? 'A fitness run for this crew is in progress.' : undefined,
    nothingToShow: v.sourceAt || v.deployment ? undefined : 'Nothing to show yet.',
  };
}

/** The dashboard's buttons, each enabled only when it applies, with the reason as its tooltip when it does not. */
export function crewButtons(v: CrewVitals): ButtonSpec[] {
  const r = reasons(v);
  const deployed = v.deployment !== undefined;
  return [
    { action: 'deploy', label: 'Deploy to Namespace...', title: 'Deploy to a namespace you pick (helm upgrade --install, or kubectl apply for a bundle)', disabled: r.noSource, primary: !deployed },
    { action: 'redeploy', label: 'Redeploy', title: 'Redeploy from source to the namespace it was last deployed to (helm upgrade)', disabled: blocked(r.noSource, r.notDeployed, r.flux) },
    { action: 'undeploy', label: 'Undeploy', title: 'Remove the deployment (helm uninstall, or delete its Kubemoot objects)', disabled: blocked(r.notDeployed, r.flux) },
    { action: 'ask', label: 'Ask', title: 'Open the chat with this crew', disabled: r.notDeployed, primary: deployed },
    { action: 'fitness', label: 'Run Fitness', title: 'Run one of its fitness definitions', disabled: blocked(r.notDeployed, r.noSource, r.running) },
    { action: 'fitnessDashboard', label: 'Fitness Runs', title: 'Open the fitness dashboard for this deployment', disabled: r.notDeployed },
    { action: 'lint', label: 'Lint', title: 'Lint (helm lint and schema check)', disabled: r.noSource },
    { action: 'yaml', label: 'Show YAML', title: v.sourceAt ? "Open the Crew's source file at the Crew" : 'Show the live Crew YAML', disabled: r.nothingToShow },
    { action: 'refresh', label: 'Refresh', title: 'Read everything again' },
    ...(v.deploymentError ? [SELECT_CONTEXT_BUTTON] : []),
  ];
}

function sourceSection(v: CrewVitals): string {
  if (!v.source) return section('Source', note('No workspace source renders this crew. Open the folder that holds its chart or bundle.'));
  const { source, chart, error } = v.source;
  const rows: [string, Shown][] = [
    ['Path', source.root],
    ['Kind', source.kind === 'helm' ? 'Helm chart' : 'bundle of manifests'],
    ['Chart', chart?.name],
    ['Chart version', chart?.version],
    ['App version', chart?.appVersion],
    ['Render error', error],
  ];
  return section('Source', facts(rows));
}

function deploymentSection(v: CrewVitals): string {
  if (!v.deployment) {
    const why = v.deploymentError ? `Cannot tell where it is deployed: ${v.deploymentError}` : `Not deployed in ${v.context}.`;
    return section('Deployment', note(why));
  }
  return section('Deployment', facts([...whereRows(v), ...whenRows(v)]));
}

function whereRows(v: CrewVitals): [string, Shown][] {
  const d = v.deployment;
  return [
    ['Namespace', d?.namespace],
    ['Context', v.context],
    ['Channel', d?.channel],
    ['Helm release', d?.release],
    ['Chart version', v.provenance?.chartVersion],
    ['App version', v.provenance?.appVersion],
  ];
}

/** When it was deployed: the Helm release's first install and last upgrade, else the Crew's creation and CrewForge's stamp. */
function whenRows(v: CrewVitals): [string, Shown][] {
  const p = v.provenance;
  const helm = v.helm ?? {};
  return [
    ['First deployed', helm.firstDeployed ?? v.deployment?.crew.created],
    ['Last redeploy', helm.lastDeployed ?? p?.deployedAt],
    ['Helm revision', helm.revision],
    ['Deployed by', p?.owner],
    ['Source revision', p?.revision],
    ['CrewForge deploy', p?.deployedAt],
  ];
}

function agentsSection(v: CrewVitals): string {
  const from = { live: 'From the cluster.', source: 'Declared in the source; not deployed.', none: 'No agents found.' }[v.agentsFrom];
  const roles = agentsByRole(v.agents).map(([role, n]) => `${n} ${role}`).join(', ');
  const rows = v.agents.map((a) => [
    escape(a.name),
    escape(a.role ?? ''),
    escape(a.capabilities.join(', ') || 'none declared'),
    v.agentsFrom === 'live' ? agentState(a) : '',
  ]);
  const models = v.models.length ? `<p class="muted">Models the source declares: ${escape(v.models.map(modelLabel).join(', '))}</p>` : '';
  const error = v.agentsError ? note(`Cannot read the live agents: ${v.agentsError}`) : '';
  const summary = note(roles ? `${from} ${roles}.` : from);
  return section(`Agents (${v.agents.length})`, [summary, error, table(['Agent', 'Role', 'Capabilities', 'State'], rows, 'No agents.'), models].join(''));
}

function agentState(a: { ready?: boolean; phase?: string }): string {
  return badge(a.ready ? 'ready' : (a.phase ?? 'starting'), readyTone(a.ready));
}

function modelLabel(m: { name: string; model?: string }): string {
  return m.model ? `${m.name} (${m.model})` : m.name;
}

/** Every group of the crew with how many objects it holds, on one line; a group's name selects it in the tree. */
function contentsSection(v: CrewVitals): string {
  if (v.contentsFrom === 'none') return '';
  const from = v.contentsFrom === 'live' ? 'From the cluster; a group opens it in Deployed Crews.' : 'Declared in the source; a group opens it in Crew Sources.';
  const links = v.contents.map(({ group, count }) => {
    const label = GROUPS[group].label;
    const shown = group === 'deployment' && v.contentsFrom === 'live' ? label : `${label} ${count}`;
    return `<button type="button" class="link" data-action="group" data-arg="${group}" title="Show the ${escape(label)} group in the tree">${escape(shown)}</button>`;
  });
  return section('Contents', `<p>${links.join(' · ')}</p>${note(from)}`);
}

function statusSection(v: CrewVitals): string {
  if (!v.deployment) return '';
  const crew = v.deployment.crew;
  const conditions = (crew.conditions ?? []).map((c) => [escape(c.type), badge(c.status, c.status === 'True' ? 'good' : 'warn'), escape(c.reason ?? ''), escape(c.message ?? '')]);
  const head = facts([
    ['Phase', crew.phase],
    ['Ready', crew.ready ? 'yes' : 'no'],
    ['Agents the operator counts', crew.agents],
    ['Coordinator', crew.coordinator],
    ['Message', crew.message],
  ]);
  return section('Live status', head + table(['Condition', 'Status', 'Reason', 'Message'], conditions, 'No conditions reported.'));
}

function conversationsSection(v: CrewVitals): string {
  if (!v.deployment) return '';
  const c = v.conversations;
  const counts = facts([
    ['Conversations', c.total],
    ['Turns', c.turns],
    ['Answering now', c.active],
  ]);
  const errors = table(['When', 'Problem'], c.errors.map((e) => [escape(e.at), escape(e.text)]), 'No failed turns or agent failures saved.');
  return section("Conversations (CrewForge's, on this computer)", `${counts}<h3>Recent problems</h3>${errors}`);
}

function kubemootSection(v: CrewVitals): string {
  if (!v.deployment || !v.kubemoot) return '';
  if ('unavailable' in v.kubemoot) return section('Discussions (Kubemoot)', note(v.kubemoot.unavailable));
  const k = v.kubemoot;
  const counts = facts([
    ['Threads', k.threads],
    ['Agent failures', k.failures],
  ]);
  const failures = table(['Recent agent failures'], k.recentFailures.map((f) => [escape(f)]), 'None.');
  const kept = note(`From the newest ${k.messages} discussion messages the Kubemoot dashboard keeps.`);
  return section('Discussions (Kubemoot)', [counts, failures, kept].join(''));
}
