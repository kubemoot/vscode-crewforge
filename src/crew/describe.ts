import type { AgentInfo, PromptModuleInfo } from './details';

/** The given lines that have text, one per line: a tooltip. */
export const lines = (...parts: (string | false | undefined)[]): string => parts.filter(Boolean).join('\n');

export { text } from './values';

export const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);

/** An agent's capabilities as one phrase; they say what it asks the scheduler for, never a model. */
export function capabilityText(a: Pick<AgentInfo, 'capabilities'>): string {
  return a.capabilities.length ? a.capabilities.join(', ') : 'no capabilities declared';
}

/** "coordinator · tool-calling, reasoning": an agent's role and capabilities, in the live and source trees alike. */
export function agentLine(a: Pick<AgentInfo, 'role' | 'capabilities'>): string {
  return `${a.role ?? 'no role'} · ${capabilityText(a)}`;
}

/** "1 agent", "3 agents": how many agents compose a PromptModule. */
export function usersText(m: Pick<PromptModuleInfo, 'usedBy'>): string {
  return m.usedBy.length === 1 ? '1 agent' : `${m.usedBy.length} agents`;
}

/** "order 10 · ADL · 2 agents": a PromptModule's place in the composition, its form, and its users. */
export function promptLine(m: Pick<PromptModuleInfo, 'order' | 'form' | 'usedBy'>): string {
  return `order ${m.order} · ${m.form} · ${usersText(m)}`;
}

/** An agent's tooltip in either tree; `state` is its readiness, which only a live agent has. */
export function agentTooltip(a: Pick<AgentInfo, 'name' | 'role' | 'capabilities' | 'description' | 'promptRefs'>, state?: string): string {
  return lines(
    `Agent ${a.name}`,
    `Role: ${a.role ?? 'not set'}`,
    `Capabilities: ${capabilityText(a)}`,
    state && `State: ${state}`,
    a.description,
    a.promptRefs.length > 0 && `PromptModules: ${a.promptRefs.join(', ')}`,
  );
}

/** A PromptModule's tooltip in either tree, with a closing note such as that other crews share it. */
export function promptTooltip(m: Pick<PromptModuleInfo, 'name' | 'order' | 'form' | 'usedBy'>, note?: string | false): string {
  const users = m.usedBy.length ? `Used by: ${m.usedBy.join(', ')}` : 'No agent composes it.';
  return lines(`PromptModule ${m.name}`, `Order: ${m.order}`, `Form: ${m.form}`, users, note);
}

/** The tooltip of a PromptModule an agent names that is not there; `why` says where it is missing. */
export function missingPromptTooltip(m: Pick<PromptModuleInfo, 'name' | 'usedBy'>, why: string): string {
  return `PromptModule ${m.name} is named by ${m.usedBy.join(', ')} but ${why}.`;
}
