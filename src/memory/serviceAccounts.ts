import type { KubeTransport } from '../k8s/request';
import { checkName } from '../k8s/paths';

/** The most ServiceAccounts looked at in one namespace, so a crowded namespace does not mean a slow page. */
export const MAX_ACCOUNTS_CHECKED = 50;

/** The setting that names the ServiceAccount a token is minted for. */
export const TOKEN_SETTING = 'crewforge.tokenServiceAccount';

interface NamedList {
  items?: { metadata?: { name?: string } }[];
}

interface AccessReview {
  status?: { allowed?: boolean };
}

async function namesIn(api: KubeTransport, namespace: string): Promise<string[]> {
  try {
    const list = JSON.parse(await api.request('GET', `/api/v1/namespaces/${checkName('namespace', namespace)}/serviceaccounts`)) as NamedList;
    return (list.items ?? []).map((i) => i.metadata?.name ?? '').filter((n) => n !== '').slice(0, MAX_ACCOUNTS_CHECKED);
  } catch {
    return [];
  }
}

/** Whether the caller may create a token for the ServiceAccount, as the cluster itself answers. */
async function mayMint(api: KubeTransport, namespace: string, name: string): Promise<boolean> {
  const review = {
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectAccessReview',
    spec: { resourceAttributes: { namespace, verb: 'create', group: '', resource: 'serviceaccounts', subresource: 'token', name } },
  };
  try {
    const answer = JSON.parse(await api.request('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', review)) as AccessReview;
    return answer.status?.allowed === true;
  } catch {
    return false;
  }
}

/**
 * The ServiceAccounts, as NAMESPACE/NAME, that the caller may create a token for in the
 * given namespaces: what the crewforge.tokenServiceAccount setting can name. A namespace
 * the caller cannot list is skipped.
 */
export async function mintableAccounts(api: KubeTransport, namespaces: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const namespace of [...new Set(namespaces)]) {
    const checked = await Promise.all((await namesIn(api, namespace)).map(async (name) => ((await mayMint(api, namespace, name)) ? `${namespace}/${name}` : undefined)));
    found.push(...checked.filter((a): a is string => a !== undefined));
  }
  return found;
}
