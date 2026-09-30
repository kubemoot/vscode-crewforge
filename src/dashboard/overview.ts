import { connectionLines, type ConnectionInfo } from '../connectionInfo';
import { CREW_LABEL, toAgent } from '../crew/details';
import type { CrewSummary } from '../k8s/crews';
import type { KubeTransport } from '../k8s/request';
import { listKind, type KubemootKind } from '../source/live';
import { provenanceOf } from '../source/provenance';
import { badge, buttons, escape, note, section, table } from './html';

/** One deployed crew as the overview lists it. */
export interface OverviewRow {
  crew: CrewSummary;
  agentsReady?: number;
  agentsTotal?: number;
  chartVersion?: string;
  channel: string;
  lastDeploy?: string;
  /** The question of a turn running now in an open chat. */
  active?: string;
  /** How many problems CrewForge's recent saved turns with the crew hold. */
  problems: number;
  /** A workspace source renders this crew. */
  sourceOpen: boolean;
}

export interface OverviewView {
  connection: ConnectionInfo;
  rows: OverviewRow[];
  error?: string;
}

/** Ready and total agents per crew, by `namespace/crew`, one Agent list per namespace; undefined for a namespace that cannot be read. */
export async function agentCounts(client: KubeTransport, kinds: Map<string, KubemootKind>, namespaces: string[]): Promise<Map<string, { ready: number; total: number }>> {
  const counts = new Map<string, { ready: number; total: number }>();
  const kind = kinds.get('Agent');
  if (!kind) return counts;
  await Promise.all(
    [...new Set(namespaces)].map(async (namespace) => {
      const agents = await listKind(client, kind, namespace).catch(() => []);
      for (const a of agents) {
        const key = `${namespace}/${a.metadata.labels?.[CREW_LABEL] ?? ''}`;
        const c = counts.get(key) ?? { ready: 0, total: 0 };
        c.total++;
        if (toAgent(a).ready) c.ready++;
        counts.set(key, c);
      }
    }),
  );
  return counts;
}

/** When a crew was last deployed: CrewForge's stamp, else the operator's revision record, else its creation. */
export function lastDeployOf(crew: CrewSummary): string | undefined {
  return provenanceOf(crew).deployedAt ?? crew.revisions?.[0]?.deployedAt ?? crew.created;
}

export function renderOverview(v: OverviewView): string {
  const connection = `<div class="connection">${connectionLines(v.connection).map(escape).join('<br>')}</div>`;
  const top = buttons([
    { action: 'refresh', label: 'Refresh', title: 'Read every crew again' },
    { action: 'connection', label: 'Connection Info', title: 'Show the connection details, with Copy for a bug report' },
  ]);
  if (v.connection.unreachable) return `<h1>Crews Overview</h1>${connection}${top}${note(`Cannot reach the cluster, so no crews are listed: ${v.connection.unreachable}`)}`;
  const error = v.error ? `<p class="error">${escape(`Cannot list the crews: ${v.error}`)}</p>` : '';
  const rows = v.rows.map(rowCells);
  const head = ['Crew', 'Namespace', 'Phase', 'Agents ready', 'Chart', 'Channel', 'Last deploy', 'Answering now', 'Recent problems', 'Local source'];
  return `<h1>Crews Overview</h1>${connection}${top}${error}${section(`Deployed crews (${v.rows.length})`, table(head, rows, 'No deployed crews in the namespaces this kubeconfig can see.'))}`;
}

function rowCells(r: OverviewRow): string[] {
  const { crew } = r;
  const agents = r.agentsTotal === undefined ? '' : `${r.agentsReady ?? 0}/${r.agentsTotal}`;
  return [
    `<button type="button" class="link" data-action="open" data-arg="${escape(`${crew.namespace}/${crew.name}`)}" title="Open this crew's dashboard">${escape(crew.name)}</button>`,
    escape(crew.namespace),
    badge(crew.phase, crew.ready ? 'good' : 'warn'),
    escape(agents),
    escape(r.chartVersion ?? ''),
    escape(r.channel),
    escape(r.lastDeploy ?? ''),
    escape(r.active ?? ''),
    r.problems ? badge(String(r.problems), 'bad') : '',
    escape(r.sourceOpen ? 'open' : ''),
  ];
}
