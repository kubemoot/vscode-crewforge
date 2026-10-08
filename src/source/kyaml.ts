/**
 * KYAML, the strict YAML subset `kubectl get -o kyaml` prints: every string value is
 * double-quoted, maps use `{ }` and lists `[ ]` with a trailing comma on each entry,
 * keys are quoted only when a YAML parser could read them as something other than a
 * string, and multi-line strings fold at their line breaks. The output is still YAML,
 * so every YAML parser reads it. This follows the encoder in sigs.k8s.io/yaml/kyaml.
 */

const INDENT = '  ';
const FOLD = '\\\n';

/** How a value's own characters are written: folded at line breaks, or on one line as in keys. */
const FOLDED_ESCAPES: Record<string, string> = { '\n': String.raw`\n${FOLD}`, '\t': '\t' };
const ONE_LINE_ESCAPES: Record<string, string> = { '\n': String.raw`\n`, '\t': String.raw`\t` };

/** YAML's named escapes for characters that do not print. */
const NAMED_ESCAPES: Record<string, string> = {
  '\x07': String.raw`\a`,
  '\b': String.raw`\b`,
  '\f': String.raw`\f`,
  '\n': String.raw`\n`,
  '\r': String.raw`\r`,
  '\t': String.raw`\t`,
  '\v': String.raw`\v`,
  '\0': String.raw`\0`,
  '\x1b': String.raw`\e`,
  '\x85': String.raw`\N`,
  '\xa0': String.raw`\_`,
  '\u2028': String.raw`\L`,
  '\u2029': String.raw`\P`,
};

/** One KYAML document: the `---` that marks it as YAML rather than JSON, the value, and a final newline. */
export function toKyaml(value: unknown): string {
  return `---\n${render(value, 0)}\n`;
}

function render(value: unknown, indent: number): string {
  if (Array.isArray(value)) return sequence(value, indent);
  if (isMap(value)) return mapping(value, indent);
  if (typeof value === 'string') return quote(value, indent + 1, false);
  if (typeof value === 'number') return number(value);
  if (typeof value === 'boolean') return String(value);
  return 'null';
}

/** A number as YAML writes it; NaN and the infinities have YAML names of their own. */
function number(n: number): string {
  if (Number.isNaN(n)) return '.nan';
  if (Number.isFinite(n)) return String(n);
  return n > 0 ? '.inf' : '-.inf';
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad(level: number): string {
  return INDENT.repeat(level);
}

/** A map; its keys come in the object's own order, which in JavaScript puts integer keys first. */
function mapping(map: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(map).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  const lines = entries.map(([k, v]) => `${pad(indent + 1)}${key(k)}: ${render(v, indent + 1)},\n`);
  return `{\n${lines.join('')}${pad(indent)}}`;
}

/** A list of maps or lists opens its first item on the bracket's line; any other list puts each item on its own line. */
function sequence(items: unknown[], indent: number): string {
  if (items.length === 0) return '[]';
  if (items.every((item) => Array.isArray(item) || isMap(item))) return `[${items.map((item) => render(item, indent)).join(', ')}]`;
  const lines = items.map((item) => `${pad(indent + 1)}${render(item, indent + 1)},\n`);
  return `[\n${lines.join('')}${pad(indent)}]`;
}

/** A map key, bare when no YAML parser could read it as anything but this string. */
function key(k: string): string {
  return k.includes('\n') || needsQuotes(k) ? quote(k, 0, true) : k;
}

/** A double-quoted string; a multi-line one folds at each line break, its lines indented to `indent`. */
function quote(value: string, indent: number, oneLine: boolean): string {
  if (oneLine || !value.includes('\n')) return `"${quotedBody(value, indent, oneLine ? ONE_LINE_ESCAPES : FOLDED_ESCAPES, '')}"`;
  const body = quotedBody(value, indent, FOLDED_ESCAPES, FOLD);
  return `"${body}${body.endsWith('\n') ? '' : FOLD}${pad(indent)}"`;
}

/** The escaped characters of a string; each folded line starts at `indent`, a leading space or tab escaped to keep it. */
function quotedBody(value: string, indent: number, escapes: Record<string, string>, start: string): string {
  let out = start;
  for (const ch of value) {
    if (out.endsWith('\n')) out += pad(indent) + (isSpace(ch) && ch !== '\n' ? '\\' : ' ');
    out += escapes[ch] ?? escaped(ch);
  }
  return out;
}

function isSpace(ch: string): boolean {
  return /^\s$/u.test(ch);
}

function escaped(ch: string): string {
  if (ch === '"' || ch === '\\') return `\\${ch}`;
  if (ch === ' ' || /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(ch)) return ch;
  const named = NAMED_ESCAPES[ch];
  if (named) return named;
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return String.raw`\x${hex(code, 2)}`;
  return code < 0x10000 ? String.raw`\u${hex(code, 4)}` : String.raw`\U${hex(code, 8)}`;
}

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, '0');
}

/** Characters a bare key may hold anywhere, and those it may hold only between its first and last. */
const BARE_ANYWHERE = /^[\p{L}\p{N}_]$/u;
const BARE_INSIDE = new Set(['-', '.', '/']);

/** Whether a key must be quoted: empty, read as another type, or holding a character a bare key may not. */
export function needsQuotes(s: string): boolean {
  if (s === '' || isTypeAmbiguous(s)) return true;
  const chars = [...s];
  return chars.some((ch, i) => !BARE_ANYWHERE.test(ch) && !(i > 0 && i < chars.length - 1 && BARE_INSIDE.has(ch)));
}

const NULLS = new Set(['null', '~']);
const BOOLEANS = new Set(['true', 'false', 't', 'f', '1', '0', 'y', 'yes', 'on', 'n', 'no', 'off']);
const INTEGER = /^[+-]?(0b[01]+|0o?[0-7]+|0x[\da-f]+|\d+)$/i;
const FLOAT_WORDS = /^[+-]?(inf|infinity|nan)$/i;
const HEX_FLOAT = /^[+-]?0x[\da-f.]+p[+-]?\d+$/i;
const SPECIAL_FLOATS = new Set(['.inf', '-.inf', '+.inf', '.nan']);
const SEXAGESIMAL = /^[+-]?[1-9][\d_]*(:[0-5]?\d)+(\.[\d_]*)?$/;
const DATE = /^(\d{4}-\d{1,2}-\d{1,2})([Tt ].+)?$/;
const TIME = /^[Tt ]\d{1,2}:\d{1,2}:\d{1,2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** Whether the string reads as a number: an integer in any base, a decimal or scientific float, or a named one. */
function isNumeric(s: string): boolean {
  if (INTEGER.test(s) || FLOAT_WORDS.test(s) || HEX_FLOAT.test(s)) return true;
  return s.trim() === s && s !== '' && !Number.isNaN(Number(s));
}

/** Whether the string reads as a date, or a date and time, as YAML timestamps are written. */
function isTimestamp(s: string): boolean {
  const match = DATE.exec(s);
  return match !== null && (match[2] === undefined || TIME.test(match[2]));
}

/** Whether a YAML parser could read the bare string as null, a boolean, a number, or a timestamp. */
export function isTypeAmbiguous(s: string): boolean {
  const lower = s.toLowerCase();
  if (NULLS.has(lower) || BOOLEANS.has(lower) || SPECIAL_FLOATS.has(lower)) return true;
  const digits = s.replaceAll('_', '');
  return isNumeric(digits) || SEXAGESIMAL.test(s) || isTimestamp(s);
}
