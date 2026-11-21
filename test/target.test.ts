import { describe, expect, it } from 'vitest';
import { KubeError } from '../src/k8s/request';
import { GATEWAY_PORT, resolveTarget } from '../src/discussion/target';
import { FakeTransport } from './fakes';

const service = (targetPort: number | string | undefined, selector: Record<string, string> | undefined = { app: 'gw', tier: 'x' }) =>
  JSON.stringify({ spec: { selector, ports: [{ port: GATEWAY_PORT, ...(targetPort === undefined ? {} : { targetPort }) }] } });

const pod = (name: string, ready: boolean, extra: object = {}) => ({
  metadata: { name },
  spec: { containers: [{ ports: [{ name: 'http', containerPort: 9000 }] }] },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
  ...extra,
});

describe('resolveTarget', () => {
  it('finds a ready pod and the Service target port, listing pods by the Service selector', async () => {
    const t = new FakeTransport();
    t.responses.push(service(8080), JSON.stringify({ items: [pod('b-0', false), pod('c-0', true), pod('a-0', true)] }));
    expect(await resolveTarget(t, 'team-a', 'lab-ops')).toEqual({ pod: 'a-0', port: 8080 });
    expect(t.calls.map((c) => c.path)).toEqual([
      '/api/v1/namespaces/team-a/services/lab-ops-discussion',
      '/api/v1/namespaces/team-a/pods?labelSelector=app%3Dgw%2Ctier%3Dx',
    ]);
  });

  it('maps a named target port through the pod, and defaults to the Service port', async () => {
    const t = new FakeTransport();
    t.responses.push(service('http'), JSON.stringify({ items: [pod('a', true)] }));
    expect((await resolveTarget(t, 'ns', 'c')).port).toBe(9000);
    t.responses.push(service(undefined), JSON.stringify({ items: [pod('a', true)] }));
    expect((await resolveTarget(t, 'ns', 'c')).port).toBe(GATEWAY_PORT);
  });

  it('refuses a pod that is deleting or not running, and says there is no ready pod', async () => {
    const t = new FakeTransport();
    const deleting = pod('d', true, { metadata: { name: 'd', deletionTimestamp: '2026-01-01T00:00:00Z' } });
    const pending = pod('p', true, { status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'True' }] } });
    t.responses.push(service(8080), JSON.stringify({ items: [deleting, pending] }));
    await expect(resolveTarget(t, 'ns', 'c')).rejects.toThrow(/no ready pod/);
  });

  it('fails clearly for a missing Service, a Service without a selector, an unknown port name, and no port 80', async () => {
    const t = new FakeTransport();
    t.responses.push(new KubeError('Not found', 404));
    await expect(resolveTarget(t, 'ns', 'c')).rejects.toThrow(/no discussion service c-discussion in namespace ns/);
    t.responses.push(service(8080, {}));
    await expect(resolveTarget(t, 'ns', 'c')).rejects.toThrow(/selects no pods/);
    t.responses.push(service('nope'), JSON.stringify({ items: [pod('a', true)] }));
    await expect(resolveTarget(t, 'ns', 'c')).rejects.toThrow(/no container port named nope/);
    t.responses.push(JSON.stringify({ spec: { selector: { a: 'b' }, ports: [{ port: 443 }] } }), JSON.stringify({ items: [pod('a', true)] }));
    await expect(resolveTarget(t, 'ns', 'c')).rejects.toThrow(/does not serve port 80/);
  });

  it('passes other failures through and rejects names that are not Kubernetes names', async () => {
    const t = new FakeTransport();
    t.responses.push(new KubeError('forbidden', 403));
    await expect(resolveTarget(t, 'ns', 'c')).rejects.toMatchObject({ status: 403 });
    await expect(resolveTarget(t, 'Bad NS', 'c')).rejects.toThrow(/namespace/);
    await expect(resolveTarget(t, 'ns', '../x')).rejects.toThrow(/crew/);
  });
});
