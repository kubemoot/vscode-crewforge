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
  if (target.matches('h1, h2, h3')) {
    placeByHeading(bubble, target, at, room, width);
    return;
  }
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

/**
 * A heading's bubble goes beside the heading, on one line when the room allows, and under
 * the paragraphs that follow the heading when it would be taller than the heading, so it
 * never hides the page's own text.
 */
function placeByHeading(bubble: HTMLElement, heading: Element, at: DOMRect, room: number, width: number): void {
  const left = at.right + 8;
  const free = width - left - 4;
  if (free >= Math.min(room, 160)) {
    bubble.style.maxWidth = `${free}px`;
    if (bubble.getBoundingClientRect().height <= at.height + 6) {
      bubble.style.left = `${left}px`;
      bubble.style.top = `${at.top}px`;
      return;
    }
  }
  bubble.style.maxWidth = '';
  bubble.style.left = `${Math.max(4, Math.min(at.left, width - room - 4))}px`;
  bubble.style.top = `${Math.max(at.bottom, bottomOfParagraphsAfter(heading)) + 4}px`;
}

/** The bottom edge of the run of paragraphs right after an element, or 0 when none follows. */
function bottomOfParagraphsAfter(el: Element): number {
  let bottom = 0;
  for (let next = el.nextElementSibling; next?.matches('p'); next = next.nextElementSibling) bottom = next.getBoundingClientRect().bottom;
  return bottom;
}
