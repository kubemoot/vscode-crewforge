import { canAnswer, capacityLine, retentionLines } from '../k8s/crewState';
import type { CrewSummary } from '../k8s/crews';
import { GROUPS } from '../crew/groups';
import { ACTIONS, HEADINGS, TERMS } from '../definitions';
import { chartVersionBanner } from '../source/normalize';
import { META_SEPARATOR } from '../webview/render';
import { tabBar, type CrewTab } from './crewTabs';
import { agentsByRole, type CrewVitals } from './crewVitals';
import { actionBar, badge, banner, crewPhaseBadge, escape, facts, heading, moment, note, section, SELECT_CONTEXT_BUTTON, table, readyTone, type ButtonSpec, type Shown } from './html';

/** The crew dashboard's page body: the header, the buttons, the tabs, and the shown tab (the overview unless `body` is given). */
export function renderCrewPage(v: CrewVitals, tab: CrewTab = 'overview', body?: string): string {
  const shown = body ?? [sourceSection(v), deploymentSection(v), contentsSection(v), agentsSection(v), statusSection(v), conversationsSection(v)].join('');
  return [header(v), actionBar(crewButtons(v)), tabBar(tab), shown].join('');
}

function header(v: CrewVitals): string {
  const state = v.deployment ? crewPhaseBadge(v.deployment.crew) : badge('not deployed', 'plain', 'No deployment of this crew was found in the namespaces CrewForge reads.');
  const place = v.deployment ? `${v.deployment.namespace} in ${v.context}` : `not deployed in ${v.context}`;
  const where = v.title === v.name ? place : `${v.name} · ${place}`;
  const description = v.description ? `<p>${escape(v.description)}</p>` : '';
  const version = chartVersionBanner(v.source?.chart?.version, v.provenance?.chartVersion);
  const title = heading('h1', `${escape(v.title)} ${state}`, TERMS.crew);
  return `${title}<p class="muted">${escape(where)}</p>${description}${version ? banner(version) : ''}`;
}

/** The first reason that blocks a button, if any. */
const blocked = (...reasons: (string | undefined)[]) => reasons.find((r) => r !== undefined);

/** Why each kind of action does not apply to this crew now; undefined where it does. */
function reasons(v: CrewVitals): { noSource?: string; notDeployed?: string; flux?: string; running?: string; nothingToShow?: string } {
  return {
    noSource: v.source?.crewName ? undefined : 'No workspace source renders this crew; open its folder to deploy or lint it.',
    notDeployed: v.deployment ? undefined : `${v.title} is not deployed in ${v.context}.`,
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
    { action: 'deploy', label: 'Deploy to Namespace...', title: ACTIONS.deploy, disabled: r.noSource, primary: !deployed },
    { action: 'redeploy', label: 'Redeploy', title: ACTIONS.redeploy, disabled: blocked(r.noSource, r.notDeployed, r.flux) },
    { action: 'undeploy', label: 'Undeploy', title: ACTIONS.undeploy, disabled: blocked(r.notDeployed, r.flux) },
    { action: 'ask', label: 'Ask', title: ACTIONS.ask, disabled: r.notDeployed, primary: deployed },
    { action: 'fitness', label: 'Run Fitness', title: ACTIONS.fitness, disabled: blocked(r.notDeployed, r.noSource, r.running) },
    { action: 'fitnessDashboard', label: 'Fitness Runs', title: ACTIONS.fitnessDashboard, disabled: r.notDeployed },
    { action: 'lint', label: 'Lint', title: ACTIONS.lint, disabled: r.noSource },
    { action: 'yaml', label: 'Show YAML', title: v.sourceAt ? ACTIONS.yamlSource : ACTIONS.yamlLive, disabled: r.nothingToShow },
    { action: 'refresh', label: 'Refresh', title: ACTIONS.refreshPage },
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
    ['First deployed', moment(helm.firstDeployed ?? v.deployment?.crew.created)],
    ['Last redeploy', moment(helm.lastDeployed ?? p?.deployedAt)],
    ['Helm revision', helm.revision],
    ['Deployed by', p?.owner],
    ['Source revision', p?.revision],
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
  return badge(a.ready ? 'ready' : (a.phase ?? 'starting'), readyTone(a.ready), a.ready ? 'The agent is running and can take part in a moot.' : 'The agent is not ready to take part in a moot yet.');
}

function modelLabel(m: { name: string; model?: string }): string {
  return m.model ? `${m.name} (${m.model})` : m.name;
}

/** Every group of the crew with how many objects it holds, on one line; a group's name selects it in the tree. */
function contentsSection(v: CrewVitals): string {
  if (v.contentsFrom === 'none') return '';
  const from = v.contentsFrom === 'live' ? 'From the cluster' : 'Declared in the source';
  const links = v.contents.map(({ group, count }) => {
    const label = GROUPS[group].label;
    const shown = group === 'deployment' && v.contentsFrom === 'live' ? label : `${label} ${count}`;
    return `<button type="button" class="link" data-action="group" data-arg="${group}" title="Show the ${escape(label)} group in the tree">${escape(shown)}</button>`;
  });
  return section('Contents', `<p title="${escape(from)}; a group opens it in the tree">${links.join(META_SEPARATOR)}</p>`);
}

function statusSection(v: CrewVitals): string {
  if (!v.deployment) return '';
  const crew = v.deployment.crew;
  const conditions = (crew.conditions ?? []).map((c) => [escape(c.type), badge(c.status, c.status === 'True' ? 'good' : 'warn', c.status === 'True' ? 'This condition holds.' : 'This condition does not hold.'), escape(c.reason ?? ''), escape(c.message ?? '')]);
  const head = facts([
    ['Phase', crew.phase],
    ['Reconciled', crew.ready ? 'yes' : 'no'],
    ['Can answer', answerText(crew)],
    ['Capacity', capacityLine(crew)?.replace('Capacity: ', '')],
    ['Generation observed', crew.observedGeneration === undefined ? undefined : `${crew.observedGeneration} of ${crew.generation ?? crew.observedGeneration}`],
    ...retentionLines(crew).map((l): [string, string] => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
    ['Agents the operator counts', crew.agents],
    ['Coordinator', crew.coordinator],
    ['Message', crew.message],
  ]);
  return section('Live status', head + table(['Condition', 'Status', 'Reason', 'Message'], conditions, 'No conditions reported.'));
}

function answerText(crew: CrewSummary): string {
  const answer = canAnswer(crew);
  return answer.ok ? 'yes' : `no, ${answer.reason}`;
}

function conversationsSection(v: CrewVitals): string {
  if (!v.deployment) return '';
  const c = v.conversations;
  const counts = facts([
    ['Conversations', c.total],
    ['Turns', c.turns],
    ['Answering now', c.active],
  ]);
  const errors = table(['When', 'Problem'], c.errors.map((e) => [escape(moment(e.at)), escape(e.text)]), 'No failed turns or agent failures saved.');
  return section('Conversations', `${note('Saved by CrewForge on this computer.')}${counts}${heading('h3', 'Recent problems', HEADINGS['Recent problems'])}${errors}`);
}
