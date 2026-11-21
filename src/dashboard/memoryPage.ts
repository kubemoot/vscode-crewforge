import { banner, buttons, escape, note, section, SELECT_CONTEXT_BUTTON, table } from './html';
import { groupByTopic, leftOutByReason, type ParsedExport, type SelectionReport } from '../memory/ompi';

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

function when(iso: string): string {
  return iso ? escape(iso.replace('T', ' ').replace(/:\d\dZ$/, 'Z')) : '<span class="muted">unknown</span>';
}

function factRow(f: { key: string; value: string; learnedBy: string; learnedAt: string; thread: string }): string[] {
  return [
    escape(f.key),
    `<pre class="memory-value">${escape(f.value)}</pre>`,
    f.learnedBy ? escape(f.learnedBy) : '<span class="muted">unknown</span>',
    when(f.learnedAt),
    f.thread ? `<code>${escape(f.thread)}</code>` : '<span class="muted">none</span>',
  ];
}

function topics(parsed: ParsedExport): string {
  if (parsed.facts.length === 0) return note('This crew has learned no facts yet.');
  return groupByTopic(parsed.facts)
    .map((g) => section(`${g.topic || '(no topic)'} (${g.facts.length})`, table(['Key', 'Value', 'Learned by', 'When', 'Thread'], g.facts.map(factRow))))
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
  const head = `${total} ${total === 1 ? 'entry was' : 'entries were'} left out of the export and are not shown here. Credentials are never exported as memory.`;
  if (reasons.length === 0) return note(head);
  return note(head) + table(['Reason', 'Entries'], reasons.map((r) => [escape(r.reason), String(r.count)]));
}

/** The memory page of one crew. Every value is escaped. */
export function renderMemoryPage(view: MemoryView): string {
  const head = `<h1>${escape(view.title)} memory</h1>`;
  const actions = buttons([
    { action: 'refresh', label: 'Refresh', title: 'Read the crew memory again' },
    { action: 'exportZip', label: 'Export to Folder...', title: 'Save the OMPI export as a zip in a folder you pick', disabled: view.parsed ? undefined : 'Nothing was read to export' },
    ...(view.contextProblem ? [SELECT_CONTEXT_BUTTON] : []),
  ]);
  if (view.error || !view.parsed) return head + actions + banner(view.error ?? 'The memory could not be read.');
  const { manifest } = view.parsed;
  const meta = note(`Read-only. ${view.parsed.facts.length} ${view.parsed.facts.length === 1 ? 'fact' : 'facts'} in ${view.namespace}/${view.crew}, from the crew's OMPI memory export (protocol ${manifest.protocolVersion || 'unknown'}, exported ${manifest.exportedAt || 'at an unknown time'}), read through context ${view.context}.`);
  return head + actions + meta + topics(view.parsed) + section('Left out', leftOutSection(view.parsed, view.report));
}
