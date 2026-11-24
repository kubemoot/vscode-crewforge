import type { KubeTransport } from '../k8s/request';
import { checkName } from '../k8s/paths';

/** The most ServiceAccounts looked at in one namespace, so a crowded namespace does not mean a slow page. */
export const MAX_ACCOUNTS_CHECKED = 50;

/** How many access checks run at once. */
export const CHECKS_AT_ONCE = 5;

/** The setting that names the ServiceAccount a token is minted for. */
export const TOKEN_SETTING = 'crewforge.tokenServiceAccount';

interface NamedList {
  items?: { metadata?: { name?: string } }[];
}

interface AccessReview {
  status?: { allowed?: boolean };
}

/** What a look at the ServiceAccounts found, and what it could not look at. */
export interface AccountSearch {
  /** NAMESPACE/NAME of each account the caller may create a token for. */
  accounts: string[];
  /** The namespaces whose ServiceAccounts the caller may not list, or that could not be read. */
  unreadable: string[];
  /** How many access checks the cluster did not answer. */
  unanswered: number;
}

/** Runs `work` over `items`, `limit` at a time, keeping the order of the results. */
async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) results.push(...(await Promise.all(items.slice(i, i + limit).map(work))));
  return results;
}

async function namesIn(api: KubeTransport, namespace: string): Promise<string[] | undefined> {
  try {
    const list = JSON.parse(await api.request('GET', `/api/v1/namespaces/${checkName('namespace', namespace)}/serviceaccounts`)) as NamedList;
    return (list.items ?? []).map((i) => i.metadata?.name ?? '').filter((n) => n !== '').slice(0, MAX_ACCOUNTS_CHECKED);
  } catch {
    return undefined;
  }
}

/** Whether the caller may create a token for the ServiceAccount, as the cluster itself answers; undefined when it does not answer. */
async function mayMint(api: KubeTransport, namespace: string, name: string): Promise<boolean | undefined> {
  const review = {
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectAccessReview',
    spec: { resourceAttributes: { namespace, verb: 'create', group: '', resource: 'serviceaccounts', subresource: 'token', name } },
  };
  try {
    const answer = JSON.parse(await api.request('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', review)) as AccessReview;
    return answer.status?.allowed === true;
  } catch {
    return undefined;
  }
}

/**
 * The ServiceAccounts that the caller may create a token for in the given namespaces:
 * what the crewforge.tokenServiceAccount setting can name. A namespace that cannot be
 * listed, and a check the cluster does not answer, are reported apart from "none allowed".
 */
export async function findMintableAccounts(api: KubeTransport, namespaces: string[]): Promise<AccountSearch> {
  const search: AccountSearch = { accounts: [], unreadable: [], unanswered: 0 };
  for (const namespace of new Set(namespaces)) {
    const names = await namesIn(api, namespace);
    if (!names) {
      search.unreadable.push(namespace);
      continue;
    }
    const answers = await inBatches(names, CHECKS_AT_ONCE, (name) => mayMint(api, namespace, name));
    names.forEach((name, i) => {
      if (answers[i] === true) search.accounts.push(`${namespace}/${name}`);
      else if (answers[i] === undefined) search.unanswered++;
    });
  }
  return search;
}

/** Why a search found nothing, in plain words. */
export function noAccountsMessage(search: AccountSearch, namespaces: string[]): string {
  const where = [...new Set(namespaces)].join(' or ');
  if (search.unreadable.length === new Set(namespaces).size) return `CrewForge could not list the ServiceAccounts in ${where} (your account may not list them). Ask your cluster administrator for one you may create tokens for, then set ${TOKEN_SETTING} to NAMESPACE/NAME.`;
  if (search.unanswered > 0) return `The cluster did not answer ${search.unanswered} access ${search.unanswered === 1 ? 'check' : 'checks'}, so no ServiceAccount in ${where} could be offered. Try again, or set ${TOKEN_SETTING} to NAMESPACE/NAME.`;
  return `No ServiceAccount in ${where} lets you create tokens. Ask your cluster administrator for one, then set ${TOKEN_SETTING} to NAMESPACE/NAME.`;
}
