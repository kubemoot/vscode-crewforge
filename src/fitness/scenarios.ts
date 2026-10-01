import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { nameProblem } from '../k8s/paths';
import type { ScenarioRef } from '../source/declared';
import { parseManifests } from '../source/manifests';
import { fitnessFolders, type SourceEntry } from '../source/service';
import { scenarioLine } from '../source/locate';
import { refuseIfDirty, renameWithEdit } from '../source/fsEdit';
import { listScripts } from '../source/nodeDeps';
import { scriptFile } from '../source/scripts';
import { escapeRegExp } from '../text';

export type ScenarioForm = 'ADL' | 'prose';

/** An ADL scenario in the shape of the kmctl starter suite's scripts. */
export function adlScript(name: string): string {
  return [
    `DESCRIPTION ${name}: what this scenario checks, in one line.`,
    'DEFINE CONST QUESTION AS "The question to ask the crew."',
    'DEFINE CONST MAX_DURATION AS 240 seconds',
    'ASSERT(POST to discussion endpoint returns 200 with conversationId)',
    'ASSERT(discussion completes with "done" event within MAX_DURATION)',
    'ASSERT(coordinator produces synthesis)',
    'ASSERT(synthesis is non-empty)',
    'ASSERT(DEFER synthesis REFLECTS "What a correct answer says, as the judge should read it.")',
    '',
  ].join('\n');
}

/** A prose scenario in the shape of the prose crews' `.md` scripts: title, question, assertions, and the reference answer. */
export function proseScript(name: string): string {
  return [
    `# ${name}: what this scenario checks, in one line.`,
    '',
    'The question to ask the crew.',
    '',
    '- POST to discussion endpoint returns 200 with conversationId',
    '- discussion completes with "done" event within 240 seconds',
    '- coordinator produces synthesis',
    '- synthesis is non-empty',
    '',
    '```reflects',
    'What a correct answer says, as the judge should read it.',
    '```',
    '',
  ].join('\n');
}

/** A one-scenario CrewFitnessSuite file, in the shape of the kmctl starter suite. */
export function suiteFile(crew: string, name: string, form: ScenarioForm): string {
  const script = (form === 'ADL' ? adlScript(name) : proseScript(name)).trimEnd();
  return [
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: CrewFitnessSuite',
    'metadata:',
    `  name: ${crew}-${name}`,
    '  labels:',
    `    kubemoot.ai/crew: ${crew}`,
    'spec:',
    `  crewRef: "${crew}"`,
    `  description: "${name}"`,
    '  iterations: 1',
    '  scripts:',
    `    - testRef: ${name}`,
    '      testContent: |',
    ...script.split('\n').map((l) => (l ? `        ${l}` : '')),
    '',
  ].join('\n');
}

/**
 * Where a new scenario goes: the source's fitness folder that exists (inside a kmctl
 * chart, or beside a bundle), else a new `fitness` folder inside it.
 */
export async function scenarioFolder(entry: SourceEntry): Promise<string> {
  for (const folder of fitnessFolders(entry.source)) if (await isDir(folder)) return folder;
  return path.join(entry.source.root, 'fitness');
}

/** Loose `.adl` and `.md` scripts in the folder mean scripts are files; otherwise scenarios are YAML suites. */
export async function folderLayout(folder: string): Promise<'scripts' | 'yaml'> {
  return (await listScripts(folder)).length ? 'scripts' : 'yaml';
}

/** The new scenario's file and text, in the folder's layout. */
export function newScenario(folder: string, layout: 'scripts' | 'yaml', crew: string, name: string, form: ScenarioForm): { file: string; text: string } {
  if (layout === 'yaml') return { file: path.join(folder, `${name}.yaml`), text: suiteFile(crew, name, form) };
  return { file: path.join(folder, scriptFile(name, form)), text: form === 'ADL' ? adlScript(name) : proseScript(name) };
}

/** A copy of a suite's text without the script named `ref`: from its `- testRef:` line to the next script or the end of the list. */
export function withoutScript(text: string, ref: string, start = 0): string {
  const lines = text.split('\n');
  const at = scenarioLine(text, start, ref);
  const first = lines[at] ?? '';
  if (!/^\s*-\s*testRef:/.test(first)) return text;
  const indent = first.length - first.trimStart().length;
  let end = at + 1;
  while (end < lines.length && !endsScript(lines[end], indent)) end++;
  return [...lines.slice(0, at), ...lines.slice(end)].join('\n');
}

function endsScript(line: string, indent: number): boolean {
  if (line.trim() === '') return false;
  const own = line.length - line.trimStart().length;
  return own < indent || (own === indent && line.trimStart().startsWith('-')) || line.startsWith('---');
}

/** The text with the `testRef` of a scenario renamed, on its own line. */
export function withRenamedScript(text: string, from: string, to: string, start = 0): string {
  const lines = text.split('\n');
  const at = scenarioLine(text, start, from);
  if (!/testRef:/.test(lines[at] ?? '')) return text;
  lines[at] = lines[at].replace(new RegExp(String.raw`(testRef:\s*["']?)${escapeRegExp(from)}(["']?\s*)$`), `$1${to}$2`);
  return lines.join('\n');
}

/** The text with the object's `metadata.name` renamed when it is the scenario's name or ends with `-<name>`. */
export function withRenamedName(text: string, from: string, to: string): string {
  return text.replace(new RegExp(String.raw`^(\s+name:\s*["']?)((?:[\w.-]*-)?)${escapeRegExp(from)}(["']?\s*)$`, 'm'), `$1$2${to}$3`);
}

/** Add, rename, and delete fitness scenario files; local file changes only, deletion to the trash after a confirmation. */
export class ScenarioFiles {
  /** Asks ADL or prose and a name, writes the scenario in the source's fitness folder, and opens it. */
  async add(entry: SourceEntry): Promise<string | undefined> {
    if (!entry.crewName) return undefined;
    const form = await vscode.window.showQuickPick(
      [
        { label: 'ADL', description: 'DESCRIPTION, DEFINE, and ASSERT statements', form: 'ADL' as const },
        { label: 'Prose', description: 'A Markdown question, assertions as a list, and the reference answer', form: 'prose' as const },
      ],
      { placeHolder: `New fitness scenario for ${entry.crewName}: ADL or prose?` },
    );
    if (!form) return undefined;
    const folder = await scenarioFolder(entry);
    const layout = await folderLayout(folder);
    const name = await askName('New scenario name', '', (n) => newScenario(folder, layout, entry.crewName!, n, form.form).file);
    if (!name) return undefined;
    const { file, text } = newScenario(folder, layout, entry.crewName, name, form.form);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    return file;
  }

  /** Renames a scenario: a script file is renamed; a suite script or CrewFitness gets a new testRef (and its file, when named after it). */
  async rename(scenario: ScenarioRef): Promise<void> {
    if (refuseIfDirty([scenario.file], 'renaming the scenario')) return;
    const target = (n: string) => (path.basename(scenario.file, path.extname(scenario.file)) === scenario.name ? path.join(path.dirname(scenario.file), `${n}${path.extname(scenario.file)}`) : scenario.file);
    const to = await askName(`Rename scenario ${scenario.name}`, scenario.name, (n) => (n === scenario.name ? scenario.file : target(n)), scenario.name);
    if (!to) return;
    const moved = target(to);
    const text = scenario.kind === 'script-file' ? undefined : withRenamedScript(await fs.readFile(scenario.file, 'utf8'), scenario.name, to);
    // Move first, so a failed move leaves the file as it was.
    if (moved !== scenario.file) await renameWithEdit(scenario.file, moved);
    if (text === undefined) return;
    // A CrewFitness, or a suite in a file of its own, is named after its scenario too.
    const renamed = scenario.kind === 'fitness' || moved !== scenario.file ? withRenamedName(text, scenario.name, to) : text;
    await fs.writeFile(moved, renamed, 'utf8');
  }

  /** Deletes a scenario after a confirmation: its file to the trash, or its script out of a suite that keeps others. */
  async delete(scenario: ScenarioRef): Promise<void> {
    if (refuseIfDirty([scenario.file], 'deleting the scenario')) return;
    const text = await fs.readFile(scenario.file, 'utf8');
    const plan = deletePlan(scenario, text);
    if ('refuse' in plan) {
      void vscode.window.showErrorMessage(`CrewForge: ${plan.refuse}`);
      return;
    }
    const detail = plan.trash ? `${scenario.file} moves to the trash.` : `Its script is removed from ${scenario.file}; the suite keeps its other scenarios.`;
    if ((await vscode.window.showWarningMessage(`Delete the fitness scenario ${scenario.name}?`, { modal: true, detail }, 'Delete')) !== 'Delete') return;
    if (plan.trash) await vscode.workspace.fs.delete(vscode.Uri.file(scenario.file), { useTrash: true });
    else await fs.writeFile(scenario.file, plan.text, 'utf8');
  }
}

/** How deleting a scenario changes its file: the whole file to the trash, a new text without its script, or a refusal. */
export function deletePlan(scenario: ScenarioRef, text: string): { trash: true } | { trash: false; text: string } | { refuse: string } {
  if (scenario.kind === 'script-file') return { trash: true };
  let objects: { kind: string; spec?: { scripts?: unknown[] } }[];
  try {
    objects = parseManifests(text) as never;
  } catch {
    return { refuse: `${scenario.file} does not parse as YAML; fix it first.` };
  }
  const scripts = scenario.kind === 'suite-script' ? (objects.find((o) => o.kind === 'CrewFitnessSuite')?.spec?.scripts?.length ?? 0) : 0;
  if (scripts > 1) return { trash: false, text: withoutScript(text, scenario.name) };
  if (objects.length === 1) return { trash: true };
  return { refuse: `${scenario.file} holds other objects too; remove ${scenario.name} from it by hand.` };
}

/** Asks for a scenario name; refuses the current name and one whose file already exists. */
async function askName(title: string, value: string, fileFor: (name: string) => string, current?: string): Promise<string | undefined> {
  const answer = await vscode.window.showInputBox({
    title,
    value,
    prompt: 'A scenario name: lowercase letters, digits, and hyphens.',
    validateInput: (v) => (v.trim() === current ? 'Enter a different name.' : nameProblem('scenario', v)),
  });
  const name = answer?.trim();
  if (!name) return undefined;
  const file = fileFor(name);
  if (file !== fileFor(current ?? '') && (await exists(file))) {
    void vscode.window.showErrorMessage(`CrewForge: ${file} already exists.`);
    return undefined;
  }
  return name;
}

async function isDir(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => undefined))?.isDirectory() ?? false;
}

async function exists(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => undefined)) !== undefined;
}
