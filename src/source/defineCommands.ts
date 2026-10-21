import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { specOf } from '../crew/values';
import { openAt, type SourceNode } from '../views/sourceTree';
import { DEFINITIONS, fileName, type DefineContext, type KindDefinition, type Question } from './defineKinds';
import { refuseIfDirty } from './fsEdit';
import type { Located } from './locate';
import { crewOf, isKubemoot, parseManifests, type Manifest } from './manifests';
import { askNeeds, presetNeeds, type NeedsAnswer, type NeedsPreset } from './needsQuestions';
import { referrersOf, removalPlan } from './removeObject';
import { setPhaseNeeds } from './schedulingNeeds';
import type { SourceEntry, SourceService } from './service';
import { labelsHelperIn, type Answers, type SourceStyle } from './templates';

export interface DefineDeps {
  service: Pick<SourceService, 'located'>;
  readText: (file: string) => Promise<string>;
  /** Loads Crew Sources again; resolves to the source nodes. */
  reload: () => Promise<SourceNode[]>;
  /** Selects the node that stands for a file in Crew Sources. */
  reveal: (file: string) => Promise<void>;
}

/** The source a Crew Sources node belongs to. */
const entryOf = (node?: SourceNode): SourceEntry | undefined => (node && 'entry' in node ? node.entry : undefined);

/** How a source writes its objects: a chart's labels helper, or the namespace a bundle's Crew names in its file. */
export async function styleOf(entry: SourceEntry, crew: string, located: Located[], readText: (file: string) => Promise<string>): Promise<SourceStyle> {
  if (entry.source.kind === 'bundle') return { kind: 'bundle', crew, namespace: await writtenNamespace(located, readText) };
  const helpers = await readText(path.join(entry.source.root, 'templates', '_helpers.tpl')).catch(() => '');
  return { kind: 'helm', crew, labelsHelper: labelsHelperIn(helpers) };
}

/** The namespace a bundle's Crew names as written in its file; a render puts every object in the namespace it renders for. */
async function writtenNamespace(located: Located[], readText: (file: string) => Promise<string>): Promise<string | undefined> {
  const file = located.find((l) => l.manifest.kind === 'Crew' && isKubemoot(l.manifest))?.file;
  if (!file) return undefined;
  try {
    return crewOf(parseManifests(await readText(file)))?.metadata.namespace;
  } catch {
    return undefined;
  }
}

/** Where a new object's file goes: a chart's templates folder, or the bundle's folder. */
export function folderFor(entry: SourceEntry): string {
  return entry.source.kind === 'helm' ? path.join(entry.source.root, 'templates') : entry.source.root;
}

/** The source's objects as rendered, where each starts in its files. */
async function locatedOf(deps: DefineDeps, entry: SourceEntry): Promise<Located[]> {
  return (await deps.service.located(entry)).filter((l) => isKubemoot(l.manifest));
}

/**
 * Add <Kind>... and Remove from Source, on the groups and objects of Crew Sources. They
 * change only files of the source; the cluster changes when the crew is deployed, and the
 * operator cleans up what a removed object made.
 */
export class SourceDefinitions {
  constructor(private readonly deps: DefineDeps) {}

  /**
   * Asks the kind's questions, writes the new object's file, opens it, shows it in the
   * tree, and lints the source. `preset` answers the questions instead, as a script or a
   * test does; they are checked the same way typed answers are.
   */
  async add(kind: string, node?: SourceNode, preset?: Answers): Promise<string | undefined> {
    const entry = entryOf(node);
    const definition = DEFINITIONS[kind];
    if (!entry?.crewName || !definition) return undefined;
    const located = await locatedOf(this.deps, entry);
    const context: DefineContext = { crew: entry.crewName, objects: located.map((l) => l.manifest) };
    const refusal = definition.refuse?.(context);
    if (refusal) {
      void vscode.window.showErrorMessage(`CrewForge: ${refusal}`);
      return undefined;
    }
    const answers = await answersFor(definition, context, preset);
    if (!answers) return undefined;
    const file = path.join(folderFor(entry), fileName(kind, String(answers.name)));
    const text = definition.yaml(await styleOf(entry, entry.crewName, located, this.deps.readText), answers);
    try {
      await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      const why = (err as NodeJS.ErrnoException).code === 'EEXIST' ? `${file} already exists` : String(err);
      void vscode.window.showErrorMessage(`CrewForge: cannot add ${kind} ${String(answers.name)}: ${why}.`);
      return undefined;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    await this.afterChange(entry, file);
    return file;
  }

  /**
   * Edit Scheduling Needs: states what the crew needs for one phase (required abilities,
   * a preferred size, preferFaster) in its CrewSchedulingPolicy, from which the cluster's
   * model catalog supplies the models. A crew without a policy is offered Add
   * CrewSchedulingPolicy first. `preset` answers instead of asking, as a script or a test does.
   */
  async editNeeds(node?: SourceNode, preset?: NeedsPreset, offerPolicy = true): Promise<string | undefined> {
    const entry = entryOf(node);
    if (!entry?.crewName) return undefined;
    const policy = (await locatedOf(this.deps, entry)).find((l) => l.manifest.kind === 'CrewSchedulingPolicy' && specOf(l.manifest).crewRef === entry.crewName);
    if (!policy) return offerPolicy && !preset ? this.addPolicyFirst(node, entry.crewName) : needsError(`${entry.crewName} has no CrewSchedulingPolicy in this source.`);
    if (!policy.file) return needsError(`CrewSchedulingPolicy ${policy.manifest.metadata.name} is not in a file of this source.`);
    if (refuseIfDirty([policy.file], 'editing the scheduling needs')) return undefined;
    const answer = await needsAnswer(policy.manifest, preset);
    return answer && this.writeNeeds(entry, { ...policy, file: policy.file }, answer);
  }

  /** Writes one phase's needs into the policy's file, opens it at the rule, and lints the source. */
  private async writeNeeds(entry: SourceEntry, policy: Located & { file: string }, answer: NeedsAnswer): Promise<string | undefined> {
    const edit = setPhaseNeeds(await fs.readFile(policy.file, 'utf8'), policy.line, answer.phase, answer.needs);
    if ('refuse' in edit) return needsError(`cannot edit ${path.basename(policy.file)} here: ${edit.refuse}.`);
    await fs.writeFile(policy.file, edit.text, 'utf8');
    const open = openAt(policy.file, edit.line);
    await vscode.commands.executeCommand(open.command, ...(open.arguments ?? []));
    await this.afterChange(entry, policy.file);
    return policy.file;
  }

  /** Offers to add the crew's CrewSchedulingPolicy, then edits its needs. */
  private async addPolicyFirst(node: SourceNode | undefined, crew: string): Promise<string | undefined> {
    const add = 'Add CrewSchedulingPolicy';
    const choice = await vscode.window.showInformationMessage(`${crew} has no CrewSchedulingPolicy to state its scheduling needs in. Add one first?`, add);
    if (choice !== add || !(await this.add('CrewSchedulingPolicy', node))) return undefined;
    return this.editNeeds(node, undefined, false);
  }

  /** Removes a declared object after a confirmation: its file to the trash, or its document out of a file that holds others. */
  async remove(node?: SourceNode): Promise<void> {
    const target = removable(node);
    if (!target || refuseIfDirty([target.file], `removing ${target.kind} ${target.name}`)) return;
    const { entry, file, kind, name } = target;
    const plan = removalPlan(await fs.readFile(file, 'utf8'), kind, name);
    if ('refuse' in plan) {
      void vscode.window.showErrorMessage(`CrewForge: cannot remove it here: ${plan.refuse}`);
      return;
    }
    const detail = removeDetail(file, plan.trash, referrersOf((await locatedOf(this.deps, entry)).map((l) => l.manifest), kind, name));
    if ((await vscode.window.showWarningMessage(`Remove ${kind} ${name} from the source?`, { modal: true, detail }, 'Remove')) !== 'Remove') return;
    if (plan.trash) await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
    else await fs.writeFile(file, plan.text, 'utf8');
    await this.afterChange(entry);
  }

  /** Loads the sources again, selects what changed, and lints the source so a mistake shows at once. */
  private async afterChange(entry: SourceEntry, file?: string): Promise<void> {
    const nodes = await this.deps.reload();
    if (file) await this.deps.reveal(file);
    const source = nodes.find((n) => n.kind === 'source' && n.entry.source.root === entry.source.root);
    if (source) await vscode.commands.executeCommand('crewforge.lintCrew', source);
  }
}

/** A declared object that is in a file of the source, which Remove from Source can take out. */
function removable(node?: SourceNode): { entry: SourceEntry; file: string; kind: string; name: string } | undefined {
  if (node?.kind !== 'declared' || !node.item.object || !node.item.file) return undefined;
  return { entry: node.entry, file: node.item.file, ...node.item.object };
}

/** What the confirmation says: where the object goes, what still names it, and that the cluster changes only on a deploy. */
export function removeDetail(file: string, trash: boolean, referrers: string[]): string {
  const where = trash ? `${file} moves to the trash.` : `Its document is removed from ${file}; the file keeps the others.`;
  const still = referrers.length ? ` ${referrers.join(', ')} still name it; change them too.` : '';
  return `${where}${still} Nothing in the cluster changes until the crew is deployed again; the operator cleans up after it.`;
}

/** Says why the scheduling needs were not edited; undefined, for the command to return. */
function needsError(message: string): undefined {
  void vscode.window.showErrorMessage(`CrewForge: ${message}`);
  return undefined;
}

/** The needs to write: the preset checked (saying why one is refused), or asked for. */
async function needsAnswer(policy: Manifest, preset?: NeedsPreset): Promise<NeedsAnswer | undefined> {
  if (!preset) return askNeeds(policy);
  const answer = presetNeeds(preset);
  return 'problem' in answer ? needsError(answer.problem) : answer;
}

/** A kind's answers: the preset checked, or the questions asked after an advanced kind's warning is accepted. */
async function answersFor(definition: KindDefinition, context: DefineContext, preset?: Answers): Promise<Answers | undefined> {
  if (preset) return checked(definition.questions, preset, context);
  if (definition.advanced && !(await confirmAdvanced(definition.advanced))) return undefined;
  return ask(definition.questions, context);
}

/** Whether the person goes on with an advanced action after reading its warning. */
async function confirmAdvanced(advanced: NonNullable<KindDefinition['advanced']>): Promise<boolean> {
  return (await vscode.window.showWarningMessage(advanced.title, { modal: true, detail: advanced.detail }, advanced.action)) === advanced.action;
}

/** Preset answers when every text answer passes its question's check; else undefined, after saying which failed. */
export function checked(questions: Question[], preset: Answers, context: DefineContext): Answers | undefined {
  for (const q of questions) {
    const problem = presetProblem(q, preset[q.key], context);
    if (problem) {
      void vscode.window.showErrorMessage(`CrewForge: ${q.title}: ${problem}`);
      return undefined;
    }
  }
  return preset;
}

/** Why a preset answer is not one the question would take: a text that fails its check, or a choice it does not offer. */
export function presetProblem(q: Question, answer: string | string[] | undefined, context: DefineContext): string | undefined {
  if (q.type === 'text') return typeof answer === 'string' ? q.check(answer, context) : 'Enter one line of text.';
  const offered: string[] = q.type === 'pick' ? q.items(context).map((i) => i.value) : q.items(context);
  const given = Array.isArray(answer) ? answer : [answer ?? ''];
  if (q.type === 'pick' && (Array.isArray(answer) || given.length !== 1)) return 'Choose one of the offered answers.';
  const bad = given.find((g) => !offered.includes(g));
  return bad === undefined ? undefined : `"${bad}" is not one of: ${offered.join(', ')}.`;
}

/** Asks each question in turn; undefined when the person cancels one. */
export async function ask(questions: Question[], context: DefineContext): Promise<Answers | undefined> {
  const answers: Answers = {};
  for (const q of questions) {
    const answer = await askOne(q, context);
    if (answer === undefined) return undefined;
    answers[q.key] = answer;
  }
  return answers;
}

async function askOne(q: Question, context: DefineContext): Promise<string | string[] | undefined> {
  if (q.type === 'text') {
    const prompt = typeof q.prompt === 'string' ? q.prompt : q.prompt(context);
    const value = await vscode.window.showInputBox({ title: q.title, prompt, value: q.value?.(context) ?? '', validateInput: (v) => q.check(v, context) });
    return value?.trim();
  }
  if (q.type === 'pick') {
    const choice = await vscode.window.showQuickPick(q.items(context), { title: q.title, placeHolder: q.title });
    return choice?.value;
  }
  const items = q.items(context);
  if (items.length === 0) return [];
  const chosen = await vscode.window.showQuickPick(
    items.map((label) => ({ label })),
    { title: q.title, placeHolder: `${q.title} (choose any)`, canPickMany: true },
  );
  return chosen?.map((c) => c.label);
}
