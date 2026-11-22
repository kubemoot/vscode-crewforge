/** What a person can point at or tab to, and what names a term: each must carry a tooltip. */
const CONTROLS = 'button, a[id], a[href], summary, h1, h2, h3, th, dt, textarea, input, select, progress, [role="tab"], [role="separator"], [role="menuitem"], [data-action], .badge';

function visibleText(el: Element): string {
  return (el.textContent ?? '').replaceAll(/\s+/g, ' ').trim();
}

function describe(el: Element): string {
  return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> "${visibleText(el).slice(0, 40)}"`;
}

/** Why an icon-only control has no name, or undefined when it has text or an aria-label. */
function nameProblem(el: Element, text: string): string | undefined {
  const iconOnly = text === '' && el.matches('button, summary, a');
  return iconOnly && !(el.getAttribute('aria-label') ?? '').trim() ? `${describe(el)} is icon-only and has no aria-label` : undefined;
}

/** The problem with one control's tooltip and name, if it has one. */
function problemWith(el: Element): string | undefined {
  const title = (el.getAttribute('title') ?? '').trim();
  if (!title && !el.getAttribute('aria-describedby')) return `${describe(el)} has no tooltip`;
  const text = visibleText(el);
  if (title && text && title.toLowerCase() === text.toLowerCase()) return `${describe(el)} has a tooltip that only repeats its text`;
  return nameProblem(el, text);
}

/** Describes every control under `root` that has no tooltip, or whose tooltip only repeats its visible text, or that is an icon with no name. */
export function controlsWithoutTooltip(root: ParentNode): string[] {
  return [...root.querySelectorAll(CONTROLS)].map(problemWith).filter((p): p is string => p !== undefined);
}
