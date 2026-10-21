import * as vscode from 'vscode';
import { ABILITIES, isSize, SIZES } from '../crew/sizes';
import { splitList } from '../crew/values';
import type { Manifest } from './manifests';
import { describeNeeds, needsOf, phasesOf, ruleFor, type PhaseNeeds } from './schedulingNeeds';

/** A phase and the needs to state for it. */
export interface NeedsAnswer {
  phase: string;
  needs: PhaseNeeds;
}

/** Answers given instead of asking, as a script or a test does: the same words the questions take. */
export interface NeedsPreset {
  phase: string;
  capabilities: string | string[];
  /** small, medium, large, or empty for no size preference. */
  size: string;
  preferFaster: string;
}

const TOKEN = /^[A-Za-z0-9][\w./-]*$/;
const PHASE = /^[a-z][a-z0-9-]*$/;

/** Why a phase name is not one, or undefined. */
export const phaseProblem = (v: string): string | undefined => (PHASE.test(v.trim()) ? undefined : 'A phase is lowercase letters, digits, and hyphens, starting with a letter.');

/** Why a preferFaster answer is not one, or undefined. */
export const fasterProblem = (v: string): string | undefined => (/^\d{1,3}$/.test(v.trim()) && Number(v) <= 100 ? undefined : 'preferFaster is a whole number from 0 to 100; 0 turns it off.');

/** The needs a preset states, or why it cannot be taken. */
export function presetNeeds(preset: NeedsPreset): NeedsAnswer | { problem: string } {
  const capabilities = Array.isArray(preset.capabilities) ? preset.capabilities : splitList(preset.capabilities);
  const bad = capabilities.find((c) => !TOKEN.test(c));
  const problem =
    phaseProblem(preset.phase) ??
    (bad === undefined ? undefined : `"${bad}" is not an ability.`) ??
    (preset.size === '' || isSize(preset.size) ? undefined : `"${preset.size}" is not a size: small, medium, large, or empty.`) ??
    fasterProblem(preset.preferFaster);
  if (problem) return { problem };
  return { phase: preset.phase.trim(), needs: { capabilities, size: isSize(preset.size) ? preset.size : undefined, preferFaster: Number(preset.preferFaster) } };
}

/** The value of "Another phase...": not a phase name, which has no spaces. */
const ANOTHER = 'another phase';

/** Which phase to state needs for: the policy's phases with what each states now, or another one typed in. */
async function askPhase(policy: Manifest): Promise<string | undefined> {
  const items = phasesOf(policy).map((p) => ({ label: p, description: describeNeeds(needsOf(ruleFor(policy, p))), value: p }));
  items.push({ label: 'Another phase...', description: "a phase of the policy's archetype", value: ANOTHER });
  const choice = await vscode.window.showQuickPick(items, { title: 'Edit Scheduling Needs: phase', placeHolder: 'The discussion phase whose model needs to state' });
  if (choice?.value !== ANOTHER) return choice?.value;
  const typed = await vscode.window.showInputBox({ title: 'Edit Scheduling Needs: phase', prompt: "A phase of the policy's MootArchetype, such as synthesis.", validateInput: phaseProblem });
  return typed?.trim();
}

/** The abilities a model must have: the known ones and any the rule already requires, those it requires picked. */
async function askCapabilities(current: string[]): Promise<string[] | undefined> {
  const offered = [...new Set([...ABILITIES, ...current])];
  const chosen = await vscode.window.showQuickPick(
    offered.map((label) => ({ label, picked: current.includes(label) })),
    { title: 'Edit Scheduling Needs: required abilities', placeHolder: 'Abilities every model for this phase must have; none picked requires none', canPickMany: true },
  );
  return chosen?.map((c) => c.label);
}

/** The size the phase would rather have, or none. */
async function askSize(current: PhaseNeeds['size']): Promise<string | undefined> {
  const mark = (value: string) => (value === (current ?? '') ? ' (now)' : '');
  const items = [
    { label: 'No size preference', description: 'qualityBias leans by agent, when nothing else is preferred' + mark(''), value: '' },
    ...SIZES.map((s) => ({ label: s.size, description: s.covers + mark(s.size), value: s.size })),
  ];
  const choice = await vscode.window.showQuickPick(items, { title: 'Edit Scheduling Needs: preferred size', placeHolder: 'A preference, not a requirement: a cluster without that size still runs the crew' });
  return choice?.value;
}

/**
 * Asks for one phase's needs: the phase, the abilities it requires, the size it prefers,
 * and preferFaster; each offers what the policy states now. Undefined when cancelled.
 */
export async function askNeeds(policy: Manifest): Promise<NeedsAnswer | undefined> {
  const phase = await askPhase(policy);
  if (!phase) return undefined;
  const now = needsOf(ruleFor(policy, phase));
  const capabilities = await askCapabilities(now.capabilities);
  if (!capabilities) return undefined;
  const size = await askSize(now.size);
  if (size === undefined) return undefined;
  const faster = await vscode.window.showInputBox({
    title: 'Edit Scheduling Needs: preferFaster',
    prompt: 'Up to this many points, 0 to 100, for the model the cluster measured faster; 0 turns it off. A size or speed preference replaces qualityBias for this phase.',
    value: String(now.preferFaster),
    validateInput: fasterProblem,
  });
  if (faster === undefined) return undefined;
  const answer = presetNeeds({ phase, capabilities, size, preferFaster: faster });
  return 'problem' in answer ? undefined : answer;
}
