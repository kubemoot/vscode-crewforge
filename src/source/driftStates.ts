import type { DriftState } from './drift';

/** How each drift state is said and marked, the same in Crew Sources and on the crew dashboard. */
export const DRIFT_STATES: Record<DriftState, { text: string; tone: 'good' | 'warn' | 'bad'; icon: string; color: string }> = {
  'in-sync': { text: 'in sync', tone: 'good', icon: 'check', color: 'testing.iconPassed' },
  changed: { text: 'changed in source', tone: 'warn', icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  missing: { text: 'in source, not deployed', tone: 'bad', icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  extra: { text: 'deployed, not in source', tone: 'warn', icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' },
};
