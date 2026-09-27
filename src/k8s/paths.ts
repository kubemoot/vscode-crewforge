/** API server paths for Kubernetes resources CrewForge reads. */

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Returns value when it is a valid Kubernetes name (DNS label), else throws naming the kind. */
export function checkName(kind: string, value: string): string {
  if (!DNS_LABEL.test(value) || value.length > 63) {
    throw new Error(`${kind} "${value}" is not a valid Kubernetes name`);
  }
  return value;
}

/** Why value is not a valid Kubernetes name, or undefined when it is; for input validation. */
export function nameProblem(kind: string, value: string): string | undefined {
  try {
    checkName(kind, value.trim());
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Every Crew the credentials can list, across namespaces. */
export const CREWS_PATH = '/apis/kubemoot.ai/v1alpha1/crews';

/** Crews in one namespace. */
export function namespacedCrewsPath(namespace: string): string {
  return `/apis/kubemoot.ai/v1alpha1/namespaces/${checkName('namespace', namespace)}/crews`;
}
