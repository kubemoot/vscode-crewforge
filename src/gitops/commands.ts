import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import { listCrews } from '../k8s/crews';
import type { SourceNode } from '../views/sourceTree';
import { helmReleaseRef, readHelmRelease } from './flux';
import { followRollout, sleep, type FollowOutcome } from './follow';

const OUTCOMES: Record<FollowOutcome, string> = {
  done: 'rolled out; the crew is Ready.',
  failed: 'Flux reported a failure; see the HelmRelease.',
  suspended: 'the HelmRelease is suspended.',
  reconciling: 'still reconciling.',
  waiting: 'no new revision yet.',
  stopped: 'stopped following.',
  'gave-up': 'no new revision reached Flux within 30 minutes; check the release pipeline.',
};

/** Follows a Flux-managed crew from push to Ready: the HelmRelease picking up a new chart, then the crew coming Ready. */
export async function followRolloutCommand(node: SourceNode | undefined, afterChange: () => void, connectTo: () => Connection = () => connect(), intervalMs?: number): Promise<void> {
  if (node?.kind !== 'deployment') return;
  const { deployment } = node;
  const ref = helmReleaseRef(deployment.crew);
  if (deployment.channel !== 'flux' || !ref) {
    void vscode.window.showInformationMessage(`${deployment.crew.name} in ${deployment.namespace} is not managed by a Flux HelmRelease.`);
    return;
  }
  const { client } = connectTo();
  const title = `${deployment.crew.name} in ${deployment.namespace}`;
  const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
    const stop = new AbortController();
    token.onCancellationRequested(() => stop.abort());
    const deps = {
      readFlux: () => readHelmRelease(client, ref),
      crewReady: async () => (await listCrews(client, [deployment.namespace])).some((c) => c.name === deployment.crew.name && c.ready),
      sleep,
      report: (message: string) => progress.report({ message }),
    };
    return followRollout(deps, stop.signal, intervalMs);
  });
  afterChange();
  const text = `${title}: ${OUTCOMES[outcome]}`;
  if (outcome === 'failed') void vscode.window.showErrorMessage(text);
  else void vscode.window.showInformationMessage(text);
}
