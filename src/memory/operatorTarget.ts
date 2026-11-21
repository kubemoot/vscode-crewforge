import { resolveServiceTarget, type Target } from '../discussion/target';
import type { KubeTransport } from '../k8s/request';

/** The operator's report Service, which serves the memory export. */
export const REPORT_SERVICE = 'kubemoot-operator-report';
export const REPORT_PORT = 8082;
export const DEFAULT_OPERATOR_NAMESPACE = 'kubemoot';

/** Finds a ready pod behind the operator's report Service and the container port it serves on. */
export function resolveReportTarget(api: KubeTransport, operatorNamespace: string): Promise<Target> {
  return resolveServiceTarget(api, {
    namespace: operatorNamespace,
    service: REPORT_SERVICE,
    port: REPORT_PORT,
    missing: `The Kubemoot operator's report service ${operatorNamespace}/${REPORT_SERVICE} was not found. Check that Kubemoot is installed, and set crewforge.operatorNamespace if it is not in ${DEFAULT_OPERATOR_NAMESPACE}.`,
    notReady: 'Check that the Kubemoot operator is running.',
  });
}
