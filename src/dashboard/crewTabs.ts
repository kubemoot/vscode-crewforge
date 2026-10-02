import type { CrewVitals } from './crewVitals';
import type { ResourceDrift } from '../source/drift';
import { lineDiff, type DiffLine } from '../source/lineDiff';
import type { Located } from '../source/locate';
import { dumpYaml, type Manifest } from '../source/manifests';
import { normalizedYaml } from '../source/normalize';
import { DRIFT_STATES } from '../source/driftStates';
import { badge, buttons, DEPLOY_TO_NAMESPACE, escape, note, OPEN_SOURCE_FOLDER, section, SELECT_CONTEXT_BUTTON, type ButtonSpec } from './html';

/** The crew dashboard's tabs: the vitals, then the crew as the source declares it, as it runs, and how the two differ. */
export type CrewTab = 'overview' | 'source' | 'live' | 'diff';

export const TABS: { tab: CrewTab; label: string; title: string }[] = [
  { tab: 'overview', label: 'Overview', title: 'Where the crew runs, its agents, and its conversations' },
  { tab: 'source', label: 'Source', title: 'The objects the local source renders, each openable at its place' },
  { tab: 'live', label: 'Live', title: 'The objects running in the cluster' },
  { tab: 'diff', label: 'Diff', title: 'Each object changed, missing, or extra between source and cluster' },
];

/** Whether a page argument names a tab. */
export function isTab(value: string | undefined): value is CrewTab {
  return TABS.some((t) => t.tab === value);
}

/** The row of tabs, the shown one marked; each reports the `tab` action with its name. */
export function tabBar(active: CrewTab): string {
  const tabs = TABS.map((t) => {
    const selected = t.tab === active;
    return `<button type="button" class="tab${selected ? ' selected' : ''}" role="tab" aria-selected="${selected}" data-action="tab" data-arg="${t.tab}" title="${escape(t.title)}">${escape(t.label)}</button>`;
  });
  return `<nav class="tabs" role="tablist">${tabs.join('')}</nav>`;
}

/** What a tab shows when its side of the crew is missing: why, and the action that brings it. */
export interface Missing {
  why: string;
  action?: ButtonSpec;
}

function missing(m: Missing): string {
  return `${note(m.why)}${m.action ? buttons([m.action]) : ''}`;
}

/** The Source tab: the rendered objects grouped by kind; each opens its file at the object. */
export function renderSourceTab(located: Located[] | Missing): string {
  if (!Array.isArray(located)) return missing(located);
  if (located.length === 0) return note('The source renders no objects.');
  const groups = groupBy(located.map((l, index) => ({ l, index })), ({ l }) => l.manifest.kind);
  const body = groups.map(([kind, items]) => section(`${kind} (${items.length})`, `<ul class="objects">${items.map(({ l, index }) => sourceRow(l, index)).join('')}</ul>`));
  return `${note('As the source renders them. Click an object to open its file there.')}${body.join('')}`;
}

function sourceRow(l: Located, index: number): string {
  const where = l.file ? `${l.file}:${l.line + 1}` : 'not in a file';
  const title = `Open ${where}`;
  const name = l.file ? `<button type="button" class="link" data-action="openAt" data-arg="${index}" title="${escape(title)}">${escape(l.manifest.metadata.name)}</button>` : escape(l.manifest.metadata.name);
  return `<li>${name} <span class="muted">${escape(where)}</span></li>`;
}

/** The Live tab: each live object's YAML, normalized unless raw is asked for, with the toggle. */
export function renderLiveTab(objects: Manifest[] | Missing, raw: boolean): string {
  if (!Array.isArray(objects)) return missing(objects);
  const toggle = buttons([{ action: 'raw', label: raw ? 'Show Normalized' : 'Show Raw', title: raw ? 'Leave out status and the metadata the cluster and tools add' : 'Everything the API server holds, status and all' }]);
  if (objects.length === 0) return `${toggle}${note('No live objects of this crew.')}`;
  const what = raw ? 'Raw: everything the API server holds.' : 'Normalized: status and the metadata the cluster, Helm, Flux, the operator, and CrewForge add are left out; keys are sorted.';
  const body = groupBy(objects, (m) => m.kind).map(([kind, items]) => section(`${kind} (${items.length})`, items.map((m) => liveObject(m, raw)).join('')));
  return `${toggle}${note(what)}${body.join('')}`;
}

function liveObject(m: Manifest, raw: boolean): string {
  return `<details><summary>${escape(m.metadata.name)}</summary><pre class="yaml">${escape(raw ? dumpYaml(m) : normalizedYaml(m))}</pre></details>`;
}

/** The Diff tab: each object that differs, with the normalized diff inline (live, then source) and a button for the diff editor. */
export function renderDiffTab(drift: ResourceDrift[] | Missing): string {
  if (!Array.isArray(drift)) return missing(drift);
  const differing = drift.filter((d) => d.state !== 'in-sync');
  const inSync = drift.length - differing.length;
  const summary = note(`${differing.length} of ${drift.length} objects differ; ${inSync} in sync. Lines marked - are live only, + are source only.`);
  if (differing.length === 0) return `${summary}${note('The deployment matches its source.')}`;
  return `${summary}${differing.map(diffItem).join('')}`;
}

function diffItem(d: ResourceDrift): string {
  const { text: label, tone } = DRIFT_STATES[d.state];
  const id = `${d.kind}/${d.name}`;
  const open = buttons([{ action: 'openDiff', arg: id, label: 'Open in Diff Editor', title: 'Compare live with source in the diff editor' }]);
  const lines = lineDiff(d.live ? normalizedYaml(d.live) : '', d.rendered ? normalizedYaml(d.rendered) : '');
  const paths = d.paths.length ? note(`Changed: ${d.paths.join(', ')}`) : '';
  return `<section><h3>${escape(id)} ${badge(label, tone)}</h3>${paths}${open}<pre class="diff">${lines.map(diffLine).join('')}</pre></section>`;
}

function diffLine(l: DiffLine): string {
  const cls = { ' ': 'same', '-': 'removed', '+': 'added' }[l.op];
  const text = `${l.op} ${l.text}`;
  return `<span class="${cls}">${escape(text)}</span>\n`;
}

function groupBy<T>(items: T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.entries()];
}

/** Where the Source and Live tabs read from. */
export interface TabReads {
  located(entry: NonNullable<CrewVitals['source']>): Promise<Located[]>;
  /** The crew's live objects when no source says which they are. */
  crewObjects(namespace: string, crew: string): Promise<Manifest[]>;
}

/** Why there is no deployment to show: it could not be read, or there is none. */
function notDeployed(v: CrewVitals): Missing {
  if (v.deploymentError) return { why: `Cannot tell where ${v.title} is deployed: ${v.deploymentError}`, action: { ...SELECT_CONTEXT_BUTTON, primary: true } };
  return { why: `${v.title} is not deployed in ${v.context}.`, action: v.source?.crewName ? DEPLOY_TO_NAMESPACE : undefined };
}

const NO_SOURCE: Missing = { why: 'No local source is open for this crew, so there is nothing to show from it.', action: OPEN_SOURCE_FOLDER };

/** The body of a tab other than the overview, read for the crew as the vitals found it. */
export async function tabBody(tab: Exclude<CrewTab, 'overview'>, v: CrewVitals, reads: TabReads, raw: boolean): Promise<string> {
  if (tab === 'source') return renderSourceTab(v.source?.crewName ? await reads.located(v.source) : NO_SOURCE);
  if (tab === 'live') return renderLiveTab(v.deployment ? await liveObjectsOf(v, v.deployment, reads) : notDeployed(v), raw);
  return renderDiffTab(diffOf(v));
}

async function liveObjectsOf(v: CrewVitals, d: NonNullable<CrewVitals['deployment']>, reads: TabReads): Promise<Manifest[]> {
  if (v.drift) return v.drift.flatMap((r) => (r.live ? [r.live] : []));
  return reads.crewObjects(d.namespace, d.crew.name);
}

function diffOf(v: CrewVitals): ResourceDrift[] | Missing {
  if (!v.source?.crewName) return NO_SOURCE;
  if (!v.deployment) return notDeployed(v);
  if (v.driftError || !v.drift) return { why: `Cannot compare the source with the deployment: ${v.driftError ?? 'the comparison did not run'}` };
  return v.drift;
}
