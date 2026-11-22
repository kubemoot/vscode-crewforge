/**
 * Shows an element's title as a tooltip when it gets keyboard focus. The browser shows a
 * title on hover only, so a person who tabs through the page would never read what a
 * button does. The bubble goes when focus leaves, on Escape, and on scroll.
 */
export function enableFocusTooltips(doc: Document): void {
  let bubble: HTMLElement | undefined;
  let owner: EventTarget | null = null;

  const hide = (): void => {
    bubble?.remove();
    bubble = undefined;
  };

  doc.addEventListener('focusin', (event) => {
    hide();
    owner = event.target;
    const found = tooltipFor(event.target as Element | null);
    if (!found) return;
    bubble = doc.createElement('div');
    bubble.className = 'focus-tip';
    bubble.setAttribute('role', 'tooltip');
    bubble.textContent = found.text;
    doc.body.append(bubble);
    place(bubble, found.target, doc.defaultView?.innerWidth ?? 800, doc.defaultView?.innerHeight ?? 600);
  });
  doc.addEventListener('focusout', (event) => {
    if (event.target === owner) hide();
  });
  doc.addEventListener('scroll', hide, true);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
}

/** Whether the element has focus the way a keyboard gives it; true where the browser cannot say. */
function keyboardFocused(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** The tooltip for a focused element: the title of it or its nearest ancestor that has one. */
function tooltipFor(focused: Element | null): { target: Element; text: string } | undefined {
  const target = focused?.closest?.('[title]');
  const text = target?.getAttribute('title');
  return focused && target && text && keyboardFocused(focused) ? { target, text } : undefined;
}

/**
 * Puts the bubble under the element, kept inside the page's width. For an item of a menu
 * it goes beside the menu, or under it when neither side has room, so it never covers the
 * items below. Near the bottom of the page it goes above the element.
 */
function place(bubble: HTMLElement, target: Element, width: number, height: number): void {
  const at = target.getBoundingClientRect();
  const room = bubble.getBoundingClientRect().width;
  const menu = target.closest('[role="menu"]')?.getBoundingClientRect();
  if (menu) {
    const beside = [menu.right + 6, menu.left - room - 6].find((x) => x >= 4 && x + room <= width - 4);
    bubble.style.left = `${beside ?? Math.max(4, Math.min(menu.left, width - room - 4))}px`;
    bubble.style.top = `${beside === undefined ? menu.bottom + 4 : at.top}px`;
    return;
  }
  bubble.style.left = `${Math.max(4, Math.min(at.left, width - room - 4))}px`;
  const tall = bubble.getBoundingClientRect().height;
  bubble.style.top = `${at.bottom + 4 + tall > height ? Math.max(4, at.top - tall - 4) : at.bottom + 4}px`;
}
