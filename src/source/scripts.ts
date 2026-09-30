import * as path from 'node:path';

/** A loose fitness script: `<name>.adl` (ADL) or `<name>.md` (prose), but not a README. */
export function isScriptFile(file: string): boolean {
  const name = path.basename(file);
  return /\.(adl|md)$/.test(name) && name.toLowerCase() !== 'readme.md';
}

/** A script file's scenario name: its file name without the extension. */
export function scriptName(file: string): string {
  return path.basename(file).replace(/\.(adl|md)$/, '');
}

/** The form a script file is written in, by its extension. */
export function scriptForm(file: string): 'ADL' | 'prose' {
  return file.endsWith('.md') ? 'prose' : 'ADL';
}

/** The file name of a script in a form. */
export function scriptFile(name: string, form: 'ADL' | 'prose'): string {
  return `${name}.${form === 'ADL' ? 'adl' : 'md'}`;
}
