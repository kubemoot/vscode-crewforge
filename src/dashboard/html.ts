import { ACTIONS, COLUMNS, FACTS, HEADINGS, lookup } from '../definitions';
import type { CrewSummary } from '../k8s/crews';
import { canAnswer } from '../k8s/crewState';
import { SELECT_CONTEXT } from '../views/errors';
import { escapeHtml, formatTime, tipAttrs } from '../webview/render';

/** Markup built by this module, already escaped: a value a page shows as it is. */
export class Html {
  constructor(readonly html: string) {}
}

/** A value a page shows as text, or markup this module built. */
export type Shown = string | number | boolean | undefined | null | Html;

/** Escapes a value for HTML text or an attribute; undefined and null become empty, and built markup stays as it is. */
export function escape(value: Shown): string {
  if (value instanceof Html) return value.html;
  return value === undefined || value === null ? '' : escapeHtml(String(value));
}

/** A button the page reports by action name, with a tooltip saying what it does; disabled with the reason as its tooltip. */
export interface ButtonSpec {
  action: string;
  label: string;
  title: string;
  arg?: string;
  /** Why the button cannot be used now; it is shown disabled with this as its tooltip. */
  disabled?: string;
  primary?: boolean;
}

export function button(b: ButtonSpec, inMenu = false): string {
  const arg = b.arg === undefined ? '' : ` data-arg="${escape(b.arg)}"`;
  const disabled = b.disabled ? ' disabled' : '';
  const plain = b.primary ? 'btn primary' : 'btn';
  const cls = inMenu ? 'menu-item" role="menuitem' : plain;
  return `<button type="button" class="${cls}" data-action="${escape(b.action)}"${arg} title="${escape(b.disabled ?? b.title)}"${disabled}>${escape(b.label)}</button>`;
}

/** The button a page shows when it could not read the cluster: another context may help. */
export const SELECT_CONTEXT_BUTTON: ButtonSpec = { action: 'selectContext', label: SELECT_CONTEXT.title, title: ACTIONS.selectContext };

/** The button a page shows when no local source renders the crew. */
export const OPEN_SOURCE_FOLDER: ButtonSpec = { action: 'openSourceFolder', label: "Open the Crew's Source Folder...", title: ACTIONS.openSourceFolder, primary: true };

/** The button a page shows when the crew is not deployed and a source can deploy it. */
export const DEPLOY_TO_NAMESPACE: ButtonSpec = { action: 'deploy', label: 'Deploy to Namespace...', title: ACTIONS.deployShort, primary: true };

export function buttons(specs: ButtonSpec[]): string {
  return specs.length ? `<div class="actions">${specs.map((b) => button(b)).join('')}</div>` : '';
}

/**
 * The page's actions as the buttons that carry the page's main task (the specs marked
 * primary) and, for the rest, one "More" menu. A page with nothing else to offer shows
 * no menu.
 */
export function actionBar(specs: ButtonSpec[]): string {
  const main = specs.filter((b) => b.primary);
  const rest = specs.filter((b) => !b.primary);
  if (rest.length === 0) return buttons(main);
  const menu = `<details class="menu"><summary class="btn" title="${escape(ACTIONS.moreActions)}">More</summary><div class="menu-list" role="menu">${rest.map((b) => button(b, true)).join('')}</div></details>`;
  return `<div class="actions">${main.map((b) => button(b)).join('')}${menu}</div>`;
}

/**
 * A time as the person reads it: in their time zone and locale ("Nov 20, 10:00 AM", or
 * "10:00 AM" today), with the exact value as given in its tooltip. Text that is not a time is shown as it is.
 */
export function moment(iso: string | undefined, now = Date.now(), locale?: string): Html | undefined {
  if (!iso) return undefined;
  const shown = formatTime(iso, now, locale);
  return new Html(shown ? `<time datetime="${escape(iso)}" title="${escape(iso)}">${escape(shown)}</time>` : escape(iso));
}

/** A heading of a page or pane: its tag, its text, and the definition of its term as the tooltip. */
export function heading(tag: 'h1' | 'h2' | 'h3', content: string, tip: string | undefined): string {
  return `<${tag}${tipAttrs(tip)}>${content}</${tag}>`;
}

/** A titled section; `tip` defines its heading, else the heading's own text is looked up. `body` is HTML already escaped. */
export function section(title: string, body: string, tip?: string): string {
  return `<section>${heading('h2', escape(title), tip ?? lookup(HEADINGS, title))}${body}</section>`;
}

/** Label and value rows; rows without a value are left out. Values are escaped. */
export function facts(rows: [string, Shown][]): string {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (shown.length === 0) return '';
  return `<dl class="facts">${shown.map(fact).join('')}</dl>`;
}

function fact([label, value]: [string, Shown]): string {
  return `<dt${tipAttrs(lookup(FACTS, label))}>${escape(label)}</dt><dd>${escape(value)}</dd>`;
}

/** A table: header cells are escaped; body cells are HTML already escaped (use `escape` or `cell`). */
export function table(head: string[], rows: string[][], empty = 'None'): string {
  if (rows.length === 0) return `<p class="muted">${escape(empty)}</p>`;
  const th = head.map((h) => `<th${tipAttrs(lookup(COLUMNS, h))}>${escape(h)}</th>`).join('');
  const body = rows.map(tableRow).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function tableRow(cells: string[]): string {
  return `<tr>${cells.map(tableCell).join('')}</tr>`;
}

function tableCell(cell: string): string {
  return `<td>${cell}</td>`;
}

/** A status word with a color class (good, warn, bad, or plain); `title` says what the status describes. */
export function badge(text: string, tone: 'good' | 'warn' | 'bad' | 'plain', title: string): string {
  return `<span class="badge ${tone}"${tipAttrs(title)}>${escape(text)}</span>`;
}

/** A crew's phase as a badge: ready when it can take a question, with that as its tooltip. */
export function crewPhaseBadge(crew: CrewSummary): string {
  const ok = canAnswer(crew).ok;
  return badge(crew.phase, readyTone(ok), `The crew's phase in the cluster. ${ok ? 'It can take a question.' : 'It cannot take a question yet.'}`);
}

/** The tone of a readiness badge: good when ready, warn otherwise. */
export function readyTone(ready: boolean | undefined): 'good' | 'warn' {
  return ready ? 'good' : 'warn';
}

/** A line of muted text. */
export function note(text: string): string {
  return `<p class="muted">${escape(text)}</p>`;
}

/** A warning banner. */
export function banner(text: string): string {
  return `<p class="banner">${escape(text)}</p>`;
}

/** A duration in words: "42 s", "3 min 5 s". */
export function duration(ms?: number): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The time between two ISO times, or from `start` to now while running. */
export function between(start?: string, end?: string, now = Date.now()): string | undefined {
  const a = start ? Date.parse(start) : Number.NaN;
  const b = end ? Date.parse(end) : now;
  return Number.isNaN(a) || Number.isNaN(b) ? undefined : duration(b - a);
}
