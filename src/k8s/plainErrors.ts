/** Which cluster a request went to, as the person knows it: the kubeconfig context and its server URL. */
export interface Where {
  context: string;
  server?: string;
}

const at = (w: Where) => (w.server ? `context ${w.context} at ${w.server}` : `context ${w.context}`);

/** Network error codes by what they mean for the person, each with the sentence that says it. */
const NETWORK: { codes: string[]; say: (w: Where) => string }[] = [
  { codes: ['ECONNREFUSED'], say: (w) => `No response from ${at(w)}. Is the cluster running?` },
  {
    codes: ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'],
    say: (w) => `No answer in time from ${at(w)}. Is the cluster running, and can this computer reach it (network, VPN)?`,
  },
  { codes: ['ENOTFOUND', 'EAI_AGAIN'], say: (w) => `Cannot find the server of ${at(w)}: its host name does not resolve. Check the kubeconfig's server address, or your DNS or VPN.` },
  { codes: ['ECONNRESET', 'EPIPE', 'ECONNABORTED'], say: (w) => `The connection to ${at(w)} was cut. The API server may be restarting; try again in a moment.` },
];

/** TLS verification failures: the server's certificate is not one the kubeconfig trusts. */
const CERTIFICATE = /^(CERT_|UNABLE_TO_(GET|VERIFY)|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT|ERR_SSL)/;

/** The error code Node gave a failed request, if it gave one. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * A request that failed on the wire, said plainly with the context and server it went to:
 * "No response from context docker-desktop at https://127.0.0.1:49681. Is the cluster
 * running?". Undefined for a failure this does not recognize.
 */
export function plainNetworkMessage(code: string | undefined, where: Where): string | undefined {
  if (!code) return undefined;
  const known = NETWORK.find((n) => n.codes.includes(code));
  if (known) return known.say(where);
  if (CERTIFICATE.test(code)) return `The server of ${at(where)} presented a certificate this kubeconfig does not trust. The kubeconfig may be for another cluster, or its CA data may be out of date.`;
  return undefined;
}

/** A failure on the wire this does not recognize, with the context, the server, and what Node said. */
export function unknownNetworkMessage(where: Where, said: string): string {
  return `Could not reach ${at(where)}: ${said}`;
}

/**
 * A refusal by status, said plainly with the context, for the statuses that mean the
 * credentials or the account; a 403 keeps what the cluster said, which names what was denied.
 */
export function plainStatusMessage(status: number, where: Where, said = ''): string | undefined {
  if (status === 401) return `Context ${where.context} did not accept your credentials. The token may have expired; get a fresh kubeconfig or log in again.`;
  if (status === 403) {
    const says = said ? ` The cluster says: ${said}` : '';
    return `Your account in context ${where.context} is not allowed to do this.${says}`;
  }
  return undefined;
}

/** Credentials the kubeconfig could not produce, such as an exec plugin that failed or is missing. */
export function plainCredentialsMessage(where: Where): string {
  return `CrewForge could not get credentials for ${at(where)} from the kubeconfig. If it runs a login plugin (such as gcloud, aws, or kubelogin), check that it is installed and logged in.`;
}
