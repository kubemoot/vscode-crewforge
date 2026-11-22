import type { DriftState } from './drift';

/** How each drift state is said and marked, the same in Crew Sources and on the crew dashboard. */
export const DRIFT_STATES: Record<DriftState, { text: string; tip: string; tone: 'good' | 'warn' | 'bad'; icon: string; color: string }> = {
  'in-sync': { text: 'in sync', tip: 'The deployed object matches what the source renders.', tone: 'good', icon: 'check', color: 'testing.iconPassed' },
  changed: { text: 'changed in source', tip: 'The source renders this object differently from the one deployed; a redeploy would change it.', tone: 'warn', icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  missing: { text: 'in source, not deployed', tip: 'The source renders this object but the cluster does not have it; a deploy would create it.', tone: 'bad', icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  extra: { text: 'deployed, not in source', tip: 'The cluster has this object but the source does not render it.', tone: 'warn', icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' },
};
