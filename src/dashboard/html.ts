import { SELECT_CONTEXT } from '../views/errors';
import { escapeHtml } from '../webview/render';

/** Escapes any value for HTML text or an attribute; undefined and null become empty. */
export function escape(value: unknown): string {
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

export function button(b: ButtonSpec): string {
  const arg = b.arg === undefined ? '' : ` data-arg="${escape(b.arg)}"`;
  const disabled = b.disabled ? ' disabled' : '';
  const cls = b.primary ? 'btn primary' : 'btn';
  return `<button type="button" class="${cls}" data-action="${escape(b.action)}"${arg} title="${escape(b.disabled ?? b.title)}"${disabled}>${escape(b.label)}</button>`;
}

/** The button a page shows when it could not read the cluster: another context may help. */
export const SELECT_CONTEXT_BUTTON: ButtonSpec = { action: 'selectContext', label: SELECT_CONTEXT.title, title: 'Pick another context from the kubeconfig' };

export function buttons(specs: ButtonSpec[]): string {
  return specs.length ? `<div class="actions">${specs.map(button).join('')}</div>` : '';
}

/** A titled section. `body` is HTML already escaped. */
export function section(title: string, body: string): string {
  return `<section><h2>${escape(title)}</h2>${body}</section>`;
}

/** Label and value rows; rows without a value are left out. Values are escaped. */
export function facts(rows: [string, unknown][]): string {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (shown.length === 0) return '';
  return `<dl class="facts">${shown.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl>`;
}

/** A table: header cells are escaped; body cells are HTML already escaped (use `escape` or `cell`). */
export function table(head: string[], rows: string[][], empty = 'None'): string {
  if (rows.length === 0) return `<p class="muted">${escape(empty)}</p>`;
  const th = head.map((h) => `<th>${escape(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

/** A status word with a color class: good, warn, bad, or plain. */
export function badge(text: string, tone: 'good' | 'warn' | 'bad' | 'plain' = 'plain'): string {
  return `<span class="badge ${tone}">${escape(text)}</span>`;
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
  const a = start ? Date.parse(start) : NaN;
  const b = end ? Date.parse(end) : now;
  return Number.isNaN(a) || Number.isNaN(b) ? undefined : duration(b - a);
}
