import { ACTIONS, MEMORY_TOPIC, TERMS } from '../definitions';
import { actionBar, banner, heading, escape, moment, note, section, SELECT_CONTEXT_BUTTON, table } from './html';
import { groupByTopic, leftOutByReason, type ParsedExport, type SelectionReport } from '../memory/ompi';
import { META_SEPARATOR } from '../webview/render';

/** What the memory page shows. */
export interface MemoryView {
  crew: string;
  title: string;
  namespace: string;
  /** The context the memory was read through. */
  context: string;
  parsed?: ParsedExport;
  report?: SelectionReport;
  /** Why the memory could not be read, in plain words. */
  error?: string;
  /** Whether the failure suggests picking another context. */
  contextProblem?: boolean;
}

function when(iso: string, thread: string): string {
  if (!iso) return '<span class="muted">unknown</span>';
  const learned = thread ? ` title="Learned in the Moot ${escape(thread)}"` : '';
  return `<span${learned}>${escape(moment(iso))}</span>`;
}

function factRow(f: { key: string; value: string; learnedBy: string; learnedAt: string; thread: string }): string[] {
  return [escape(f.key), `<pre class="memory-value">${escape(f.value)}</pre>`, f.learnedBy ? escape(f.learnedBy) : '<span class="muted">unknown</span>', when(f.learnedAt, f.thread)];
}

function topics(parsed: ParsedExport): string {
  if (parsed.facts.length === 0) return note('This crew has learned no facts yet.');
  return groupByTopic(parsed.facts)
    .map((g) => section(`${g.topic || '(no topic)'} (${g.facts.length})`, table(['Key', 'Value', 'Learned by', 'When'], g.facts.map(factRow)), MEMORY_TOPIC))
    .join('');
}

/**
 * The entries the export left out, as reasons with counts. The report carries no fact text
 * and this page shows no key either: an entry whose key held a credential has only an opaque id.
 */
export function leftOutSection(parsed: ParsedExport, report: SelectionReport | undefined): string {
  const reasons = leftOutByReason(report);
  const total = report ? report.leftOut.length : parsed.manifest.skipped;
  if (total === 0) return note('Nothing was left out of the export.');
  const head = `${total} ${total === 1 ? 'entry' : 'entries'} left out of the export. Credentials are never exported as memory.`;
  if (reasons.length === 0) return note(head);
  return note(head) + table(['Reason', 'Entries'], reasons.map((r) => [escape(r.reason), String(r.count)]));
}

/** The memory page of one crew. Every value is escaped. */
export function renderMemoryPage(view: MemoryView): string {
  const head = heading('h1', `${escape(view.title)} memory`, TERMS.memory);
  const actions = actionBar([
    { action: 'exportZip', label: 'Export...', title: ACTIONS.exportMemory, disabled: view.parsed ? undefined : 'Nothing was read to export', primary: true },
    { action: 'refresh', label: 'Refresh', title: ACTIONS.refreshMemory, primary: true },
    ...(view.contextProblem ? [{ ...SELECT_CONTEXT_BUTTON, primary: true }] : []),
  ]);
  if (view.error || !view.parsed) return head + actions + banner(view.error ?? 'The memory could not be read.');
  const { manifest } = view.parsed;
  const count = `${view.parsed.facts.length} ${view.parsed.facts.length === 1 ? 'fact' : 'facts'}`;
  const detail = `${view.namespace}/${view.crew}, OMPI protocol ${manifest.protocolVersion || 'unknown'}, read through context ${view.context}`;
  const exported = moment(manifest.exportedAt) ?? 'at an unknown time';
  const line = [escape(count), 'read-only', `exported ${escape(exported)}`].join(META_SEPARATOR);
  const meta = `<p class="muted" title="${escape(detail)}">${line}</p>`;
  return head + actions + meta + topics(view.parsed) + section('Left out', leftOutSection(view.parsed, view.report));
}
