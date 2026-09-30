import * as vscode from 'vscode';
import { dashboardBase, namespaceFilter, type Connection } from '../connection';
import { checkName } from '../k8s/paths';
import { ConnectionStatus, showConnectionInfo } from '../connectionInfo';
import type { CrewDetails } from '../crew/details';
import { KubeTools } from '../deploy/deployer';
import { liveDeployment, sourceForCrew } from '../deploy/liveCrew';
import { ControlsReader, RunControls, type FitnessActivity } from '../fitness/controls';
import { isRunning, listIterations, listRuns, type FitnessRun } from '../fitness/fitness';
import { listCrews, type CrewSummary } from '../k8s/crews';
import { DashboardApi } from '../kubemoot/dashboardApi';
import { devDeployment, type LoopMemory } from '../loop/state';
import { ChatPanel } from '../panels/chatPanel';
import type { Deployment } from '../source/deployments';
import { provenanceOf } from '../source/provenance';
import { errorText } from '../views/errors';
import type { Exec } from '../source/render';
import type { SourceEntry, SourceService } from '../source/service';
import { conversationStats } from '../store/stats';
import type { ConversationStore } from '../store/conversations';
import type { CrewNode } from '../views/crewTree';
import type { DeploymentNode, SourceNode, SourceTreeProvider } from '../views/sourceTree';
import { renderCrewPage } from './crewPage';
import { gatherVitals, parseHelmStatus, type CrewTarget, type CrewVitals, type VitalsDeps } from './crewVitals';
import { renderFitnessPage, type FitnessView } from './fitnessPage';
import { agentCounts, lastDeployOf, renderOverview, type OverviewRow } from './overview';
import { PagePanel, type PageModel } from './pagePanel';

export interface DashboardParts {
  extensionUri: vscode.Uri;
  crewforgeVersion: string;
  connect: () => Connection;
  sources: Pick<SourceTreeProvider, 'known' | 'loadDeployments'>;
  service: Pick<SourceService, 'located' | 'kinds'>;
  details: (crew: CrewSummary) => Promise<CrewDetails>;
  store: ConversationStore;
  memory: Pick<LoopMemory, 'devNamespace'>;
  exec: Exec;
  activity: FitnessActivity;
  api?: DashboardApi;
}

/** How often each page reads again while it is visible. */
export const REFRESH = { crew: 10_000, overview: 15_000, fitnessRunning: 3_000 } as const;

/** Opens the crew dashboard, the Crews Overview, and the fitness dashboard, and keeps the connection status bar item. */
export class Dashboards implements vscode.Disposable {
  readonly status: ConnectionStatus;
  private readonly api: DashboardApi;
  private readonly controls = new ControlsReader();
  private readonly runControls: RunControls;

  constructor(private readonly parts: DashboardParts) {
    this.status = new ConnectionStatus(parts.connect, parts.crewforgeVersion);
    this.api = parts.api ?? new DashboardApi();
    this.runControls = new RunControls(() => parts.connect().client, (client) => parts.service.kinds(client));
  }

  /** Opens the dashboard of a crew: a Crew Sources crew, a live crew, or the crew behind another node of either view. */
  openCrew(node?: SourceNode | CrewNode): PagePanel | undefined {
    const target = this.targetOf(node);
    if (!target) return undefined;
    const key = target.entry ? `crew:${target.entry.source.root}` : `crew:${target.crew?.namespace}/${target.crew?.name}`;
    return PagePanel.show(this.parts.extensionUri, key, new CrewDashboard(target, this));
  }

  openOverview(): PagePanel {
    return PagePanel.show(this.parts.extensionUri, 'overview', new CrewsOverview(this));
  }

  /** Opens the fitness dashboard of a deployment, showing one run when a run node is given. */
  openFitness(node?: SourceNode | CrewNode, run?: string): PagePanel | undefined {
    const at = this.fitnessTarget(node);
    if (!at) return undefined;
    const key = `fitness:${at.deployment.namespace}/${at.deployment.crew.name}`;
    const selected = run ?? (node?.kind === 'run' ? node.run.name : undefined);
    const existing = PagePanel.find(key)?.model as FitnessDashboard | undefined;
    existing?.select(selected);
    return PagePanel.show(this.parts.extensionUri, key, existing ?? new FitnessDashboard(at, this, selected));
  }

  async showConnection(): Promise<void> {
    await showConnectionInfo(await this.status.update());
  }

  private targetOf(node?: SourceNode | CrewNode): CrewTarget | undefined {
    if (node?.kind === 'crew') return { crew: node.crew, entry: sourceForCrew(node.crew, this.parts.sources.known) };
    if (node && 'entry' in node) return { entry: node.entry, crew: 'deployment' in node ? node.deployment.crew : undefined };
    return undefined;
  }

  private fitnessTarget(node?: SourceNode | CrewNode): { entry?: SourceEntry; deployment: Deployment } | undefined {
    if (node?.kind === 'crew') return { entry: sourceForCrew(node.crew, this.parts.sources.known), deployment: liveDeployment(node.crew) };
    if (node && 'deployment' in node) return { entry: node.entry, deployment: node.deployment };
    return undefined;
  }

  /** Where a crew dashboard reads from. */
  vitalsDeps(): VitalsDeps {
    const { parts } = this;
    return {
      context: () => parts.connect().context,
      deploymentOf: async (entry) => {
        const loaded = await parts.sources.loadDeployments(entry);
        const nodes = loaded.filter((n): n is DeploymentNode => n.kind === 'deployment');
        const failed = loaded.find((n) => n.kind === 'message' && n.icon !== 'circle-slash');
        if (!nodes.length && failed?.kind === 'message') throw new Error(failed.detail ?? failed.text);
        return devDeployment(nodes, parts.memory.devNamespace(entry.source.root));
      },
      liveCrew: async (namespace, name) => (await listCrews(parts.connect().client, [namespace])).find((c) => c.name === name),
      located: (entry) => parts.service.located(entry),
      liveDetails: parts.details,
      helm: async (release, namespace) => {
        const connection = parts.connect();
        const result = await new KubeTools(parts.exec, connection.source, connection.context).helm(['status', release, '--namespace', namespace, '-o', 'json']);
        return result.code === 0 ? parseHelmStatus(result.stdout) : undefined;
      },
      conversations: (context, namespace, crew) => conversationStats(parts.store, context, namespace, crew, ChatPanel.activeTurn(context, { namespace, name: crew })),
      kubemoot: (namespace, crew) => this.api.threads(parts.connect().client, namespace, crew),
      fitnessRunning: (namespace, crew) => parts.activity.isBusy(namespace, crew),
    };
  }

  /** One row of the overview. */
  async overviewRow(crew: CrewSummary, counts: Map<string, { ready: number; total: number }>, context: string): Promise<OverviewRow> {
    const count = counts.get(`${crew.namespace}/${crew.name}`);
    const stats = await conversationStats(this.parts.store, context, crew.namespace, crew.name, ChatPanel.activeTurn(context, crew)).catch(() => ({ errors: [], active: undefined }));
    return {
      crew,
      agentsReady: count?.ready,
      agentsTotal: count?.total ?? crew.agents,
      chartVersion: provenanceOf(crew).chartVersion,
      channel: liveDeployment(crew).channel,
      lastDeploy: lastDeployOf(crew),
      active: stats.active,
      problems: stats.errors.length,
      sourceOpen: sourceForCrew(crew, this.parts.sources.known) !== undefined,
    };
  }

  /** What the fitness dashboard shows for a deployment. */
  async fitnessView(at: { entry?: SourceEntry; deployment: Deployment }, selectedName?: string): Promise<FitnessView> {
    const { deployment } = at;
    const base: FitnessView = { crew: deployment.crew.name, namespace: deployment.namespace, runs: [], iterations: [], controls: { suspend: false, cancel: false } };
    base.cannotRun = at.entry ? undefined : 'No workspace source renders this crew, so CrewForge has no fitness definitions to run.';
    try {
      const { client } = this.parts.connect();
      const kinds = await this.parts.service.kinds(client);
      const runs = await listRuns(client, kinds, deployment.namespace, deployment.crew.name);
      this.parts.activity.record(deployment.namespace, deployment.crew.name, runs);
      const selected = runs.find((r) => r.name === selectedName) ?? runs[0];
      return { ...base, runs, selected, controls: await this.controls.read(client), ...(await this.suiteDetail(selected, kinds)) };
    } catch (err) {
      return { ...base, error: `Cannot read the fitness runs: ${errorText(err)}` };
    }
  }

  private async suiteDetail(run: FitnessRun | undefined, kinds: Awaited<ReturnType<SourceService['kinds']>>): Promise<Partial<FitnessView>> {
    if (run?.kind !== 'CrewFitnessSuite') return {};
    const { client } = this.parts.connect();
    const iterations = await listIterations(client, kinds, run.namespace, run.name).catch(() => []);
    const base = dashboardBase();
    const xlsxUrl = run.artifact && base ? `${base}/api/kubemoot/crewfitnesssuites/${checkName('namespace', run.namespace)}/${encodeURIComponent(run.name)}/artifact` : undefined;
    if (isRunning(run)) return { iterations, xlsxUrl };
    // The iterations still in the cluster come first; the dashboard's transcripts cover a run the operator has cleaned up.
    const [archived, scores] = await Promise.all([
      iterations.length ? undefined : this.api.iterations(client, run.namespace, run.name).then((r) => ('unavailable' in r ? r : (r.iterations ?? []))),
      run.phase === 'Cancelled' ? undefined : this.api.scores(client, run.namespace, run.name),
    ]);
    return { iterations, archived, scores, xlsxUrl };
  }

  get fitnessControls(): RunControls {
    return this.runControls;
  }

  get overviewParts(): { connect: () => Connection; kinds: SourceService['kinds'] } {
    return { connect: this.parts.connect, kinds: (client) => this.parts.service.kinds(client) };
  }

  dispose(): void {
    this.status.dispose();
  }
}

/** The crew dashboard: vitals and the lifecycle buttons, read again every few seconds while visible. */
class CrewDashboard implements PageModel {
  private vitals?: CrewVitals;

  constructor(
    private readonly target: CrewTarget,
    private readonly dashboards: Dashboards,
  ) {}

  title(): string {
    return `Crew ${this.vitals?.name ?? this.target.entry?.crewName ?? this.target.crew?.name ?? ''}`;
  }

  async render(): Promise<string> {
    this.vitals = await gatherVitals(this.target, this.dashboards.vitalsDeps());
    return renderCrewPage(this.vitals);
  }

  refreshMs(): number {
    return REFRESH.crew;
  }

  private get sourceNode(): SourceNode | undefined {
    return this.target.entry && { kind: 'source', entry: this.target.entry };
  }

  /** The deployment as the node the lifecycle commands take: a Crew Sources deployment with a source, else the live crew. */
  private get deploymentNode(): SourceNode | CrewNode | undefined {
    const deployment = this.vitals?.deployment;
    if (!deployment) return undefined;
    return this.target.entry ? { kind: 'deployment', entry: this.target.entry, deployment } : { kind: 'crew', crew: deployment.crew };
  }

  readonly actions: PageModel['actions'] = {
    deploy: () => run('crewforge.deployDev', this.sourceNode),
    redeploy: () => run('crewforge.redeployDev', this.sourceNode),
    undeploy: () => run('crewforge.removeDeployment', this.deploymentNode),
    ask: () => run('crewforge.askCrew', this.vitals?.deployment && { kind: 'crew', crew: this.vitals.deployment.crew }),
    fitness: () => run('crewforge.runFitness', this.deploymentNode),
    fitnessDashboard: async () => this.dashboards.openFitness(this.deploymentNode),
    lint: () => run('crewforge.lintCrew', this.sourceNode),
    yaml: () => this.showYaml(),
    refresh: async () => undefined,
  };

  private async showYaml(): Promise<void> {
    const at = this.vitals?.sourceAt;
    if (at) return run('vscode.open', vscode.Uri.file(at.file), { selection: new vscode.Range(at.line, 0, at.line, 0) });
    const crew = this.vitals?.deployment?.crew;
    if (crew) return run('crewforge.showLiveYaml', { kind: 'crew', crew });
  }
}

async function run(command: string, ...args: unknown[]): Promise<void> {
  if (args[0] === undefined) return;
  await vscode.commands.executeCommand(command, ...args);
}

/** Every deployed crew the kubeconfig can see, with what CrewForge is connected to on top. */
class CrewsOverview implements PageModel {
  private crews: CrewSummary[] = [];

  constructor(private readonly dashboards: Dashboards) {}

  title(): string {
    return 'Crews Overview';
  }

  async render(): Promise<string> {
    const connection = await this.dashboards.status.update();
    if (connection.unreachable) return renderOverview({ connection, rows: [] });
    const { connect, kinds } = this.dashboards.overviewParts;
    const { client, context } = connect();
    try {
      this.crews = await listCrews(client, namespaceFilter());
    } catch (err) {
      return renderOverview({ connection, rows: [], error: errorText(err) });
    }
    const counts = await agentCounts(client, await kinds(client).catch(() => new Map()), this.crews.map((c) => c.namespace));
    const rows = await Promise.all(this.crews.map((crew) => this.dashboards.overviewRow(crew, counts, context)));
    return renderOverview({ connection, rows });
  }

  refreshMs(): number {
    return REFRESH.overview;
  }

  readonly actions: PageModel['actions'] = {
    open: async (arg) => {
      const crew = this.crews.find((c) => `${c.namespace}/${c.name}` === arg);
      if (crew) this.dashboards.openCrew({ kind: 'crew', crew });
    },
    refresh: async () => undefined,
    connection: () => this.dashboards.showConnection(),
  };
}

/** The fitness runs of one deployment, with the selected run in detail; reads every few seconds while a run is going. */
class FitnessDashboard implements PageModel {
  private view?: FitnessView;

  constructor(
    private readonly at: { entry?: SourceEntry; deployment: Deployment },
    private readonly dashboards: Dashboards,
    private selectedName?: string,
  ) {}

  /** Shows this run in detail from the next render on; none keeps the one shown. */
  select(name?: string): void {
    if (name) this.selectedName = name;
  }

  title(): string {
    return `Fitness ${this.at.deployment.crew.name}`;
  }

  async render(): Promise<string> {
    this.view = await this.dashboards.fitnessView(this.at, this.selectedName);
    return renderFitnessPage(this.view);
  }

  refreshMs(): number | undefined {
    return this.view?.runs.some(isRunning) ? REFRESH.fitnessRunning : undefined;
  }

  private runNamed(name?: string): FitnessRun | undefined {
    return this.view?.runs.find((r) => r.name === name);
  }

  private get node(): SourceNode | CrewNode {
    const { entry, deployment } = this.at;
    return entry ? { kind: 'deployment', entry, deployment } : { kind: 'crew', crew: deployment.crew };
  }

  readonly actions: PageModel['actions'] = {
    select: async (arg) => this.select(arg),
    run: () => run('crewforge.runFitness', this.node),
    pause: async (arg) => this.control(arg, (r) => this.dashboards.fitnessControls.pause(r)),
    resume: async (arg) => this.control(arg, (r) => this.dashboards.fitnessControls.resume(r)),
    stop: async (arg) => this.control(arg, (r) => this.dashboards.fitnessControls.stop(r)),
    xlsx: async () => {
      if (this.view?.xlsxUrl) await vscode.env.openExternal(vscode.Uri.parse(this.view.xlsxUrl));
    },
    refresh: async () => undefined,
  };

  private async control(name: string | undefined, act: (run: FitnessRun) => Promise<void>): Promise<void> {
    const found = this.runNamed(name);
    if (found) await act(found);
  }
}
