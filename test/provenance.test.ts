import { describe, expect, it } from 'vitest';
import type { CrewSummary } from '../src/k8s/crews';
import { ANNOTATIONS } from '../src/source/deployments';
import { fluxOwnerOf, provenanceFacts, provenanceOf, splitChart } from '../src/source/provenance';

const crew = (labels: Record<string, string> = {}, annotations: Record<string, string> = {}): CrewSummary => ({ name: 'lab', namespace: 'team-a', ready: true, phase: 'Ready', labels, annotations });

describe('splitChart', () => {
  it('splits a chart label at its version, prereleases included', () => {
    expect(splitChart('homelab-pilot-crew-0.45.1-rc.0')).toEqual({ chart: 'homelab-pilot-crew', version: '0.45.1-rc.0' });
    expect(splitChart('demo-v1.2.3')).toEqual({ chart: 'demo', version: 'v1.2.3' });
    expect(splitChart('no-version-here')).toEqual({ chart: 'no-version-here' });
    expect(splitChart(undefined)).toEqual({});
    expect(splitChart('')).toEqual({});
  });

  it('splits at the first hyphen a version follows, never at the first character, and not across a line break', () => {
    expect(splitChart('a-b-1.2-c-2.0.0-d-3.0.0')).toEqual({ chart: 'a-b-1.2-c', version: '2.0.0-d-3.0.0' });
    expect(splitChart('-1.2.3')).toEqual({ chart: '-1.2.3' });
    expect(splitChart('--1.2.3')).toEqual({ chart: '-', version: '1.2.3' });
    expect(splitChart('demo-vv1.2.3')).toEqual({ chart: 'demo-vv1.2.3' });
    expect(splitChart('demo-1.2.3\nx')).toEqual({ chart: 'demo-1.2.3\nx' });
  });

  it('takes linear time on a label of many hyphens', () => {
    const label = '-1.1'.repeat(50_000);
    const started = Date.now();
    expect(splitChart(label)).toEqual({ chart: label });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('fluxOwnerOf', () => {
  it('names the HelmRelease or Kustomization Flux labels point at', () => {
    expect(fluxOwnerOf({ 'helm.toolkit.fluxcd.io/name': 'lab', 'helm.toolkit.fluxcd.io/namespace': 'flux-system' })).toEqual({ kind: 'HelmRelease', name: 'lab', namespace: 'flux-system' });
    expect(fluxOwnerOf({ 'kustomize.toolkit.fluxcd.io/name': 'apps', 'kustomize.toolkit.fluxcd.io/namespace': 'flux-system' })).toEqual({ kind: 'Kustomization', name: 'apps', namespace: 'flux-system' });
    expect(fluxOwnerOf({ 'helm.toolkit.fluxcd.io/name': 'x' })).toEqual({ kind: 'HelmRelease', name: 'x', namespace: '' });
    expect(fluxOwnerOf({ 'kustomize.toolkit.fluxcd.io/name': 'y' })?.namespace).toBe('');
    expect(fluxOwnerOf({})).toBeUndefined();
  });
});

describe('provenanceOf and provenanceFacts', () => {
  it('reads a Flux-installed chart: chart, versions, release, and HelmRelease', () => {
    const p = provenanceOf(
      crew(
        { 'helm.sh/chart': 'lab-crew-0.4.0', 'app.kubernetes.io/version': '0.4.0', 'app.kubernetes.io/managed-by': 'Helm', 'helm.toolkit.fluxcd.io/name': 'lab', 'helm.toolkit.fluxcd.io/namespace': 'flux-system' },
        { 'meta.helm.sh/release-name': 'lab', 'meta.helm.sh/release-namespace': 'team-a' },
      ),
    );
    expect(p).toMatchObject({ channel: 'flux', chart: 'lab-crew', chartVersion: '0.4.0', appVersion: '0.4.0', release: 'lab', releaseNamespace: 'team-a' });
    expect(provenanceFacts(p).map((f) => `${f.label}: ${f.value}`)).toEqual([
      'Channel: GitOps (Flux)',
      'Chart: lab-crew 0.4.0',
      'App version: 0.4.0',
      'Helm release: team-a/lab',
      'Flux HelmRelease: flux-system/lab',
    ]);
    expect(provenanceFacts(p)[4].flux).toEqual({ kind: 'HelmRelease', name: 'lab', namespace: 'flux-system' });
  });

  it('reads what a CrewForge deploy recorded, and the crew-version label when there is no chart label', () => {
    const p = provenanceOf(
      crew({ 'kubemoot.ai/crew-version': '1.0.0_build.5' }, { [ANNOTATIONS.source]: 'github.com/k/crews//lab', [ANNOTATIONS.revision]: 'abc1234', [ANNOTATIONS.owner]: 'me@example.com', [ANNOTATIONS.deployedAt]: '2026-09-30T10:00:00Z', 'meta.helm.sh/release-name': 'lab' }),
    );
    expect(provenanceFacts(p).map((f) => `${f.label}: ${f.value}`)).toEqual([
      'Channel: kubectl apply (bundle)',
      'Chart: 1.0.0+build.5',
      'Helm release: lab',
      'Source: github.com/k/crews//lab',
      'Revision: abc1234',
      'Deployed by: me@example.com',
      'Deployed at: 2026-09-30T10:00:00Z',
    ]);
  });

  it('names another manager of a crew applied without Helm, and shows only the channel for a bare Crew', () => {
    expect(provenanceFacts(provenanceOf(crew({ 'app.kubernetes.io/managed-by': 'argocd' })))[0].value).toBe('managed by argocd');
    expect(provenanceFacts(provenanceOf(crew({ 'app.kubernetes.io/managed-by': 'Helm' })))[0].value).toBe('Helm');
    expect(provenanceFacts(provenanceOf({ name: 'x', namespace: 'n', ready: false, phase: 'Pending' }))).toEqual([{ label: 'Channel', value: 'kubectl apply (bundle)' }]);
  });
});
