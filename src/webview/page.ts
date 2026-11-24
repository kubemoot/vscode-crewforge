/**
 * The script of CrewForge's dashboard pages (a crew, the crews overview, a fitness run).
 * The extension renders each page as HTML with every value escaped and posts it here;
 * this script only shows it and reports which button was pressed. It holds no state of
 * its own, so the extension stays the one place that decides what a button does.
 */
import type { PageHostMessage, PageMessage } from './pageProtocol';
import { reportErrors } from './reportErrors';
import { shownText } from './shown';
import { enableFocusTooltips } from './tooltip';

/** What the page keeps while its tab is hidden, when VS Code drops the page and builds it again on return. */
interface KeptState {
  scrollY?: number;
  /** Which of the page's own details sections (by position) the person had open. */
  open?: number[];
}

interface VsCodeApi {
  postMessage(message: PageMessage): void;
  getState?(): KeptState | undefined;
  setState?(state: KeptState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;
const status = document.getElementById('status');
// The script started, so the notice the page shows when it never does can go.
document.getElementById('stuck')?.remove();

/** The sections the person opened, as their positions among the page's own (not menu) details. */
function openSections(): number[] {
  return [...root.querySelectorAll<HTMLDetailsElement>('details:not(.menu)')].flatMap((d, i) => (d.open ? [i] : []));
}

function keep(): void {
  vscode.setState?.({ scrollY: globalThis.scrollY, open: openSections() });
}

/** Puts back what the person had open and where they had scrolled to. */
function restore(kept: KeptState): void {
  const sections = root.querySelectorAll<HTMLDetailsElement>('details:not(.menu)');
  for (const i of kept.open ?? []) if (sections[i]) sections[i].open = true;
  if (typeof kept.scrollY === 'number') globalThis.scrollTo(0, kept.scrollY);
}

/** What a render replaces: the page as it stood, so an unchanged page is left alone and a changed one keeps the place. */
let shownHtml: string | undefined;

function show(html: string): void {
  // The first render after the page was built again takes what was kept; later ones keep what is on screen.
  const kept: KeptState = shownHtml === undefined ? (vscode.getState?.() ?? {}) : { scrollY: globalThis.scrollY, open: openSections() };
  if (html !== shownHtml) {
    root.innerHTML = html;
    shownHtml = html;
    restore(kept);
  }
  vscode.postMessage({ type: 'shown', text: shownText(root) });
}
globalThis.addEventListener('scroll', keep);
root.addEventListener('toggle', keep, true);

reportErrors((message) => vscode.postMessage({ type: 'error', message }));

// VS Code's host frame forwards each extension message with this page's own origin; a
// message from any other origin came from another window and is ignored.
globalThis.addEventListener('message', (event: MessageEvent<PageHostMessage>) => {
  if (event.origin !== globalThis.origin) return;
  const message = event.data;
  if (message?.type === 'render' && typeof message.html === 'string') {
    show(message.html);
  } else if (message?.type === 'status' && typeof message.text === 'string' && status) {
    status.textContent = message.text;
    status.hidden = message.text === '';
  }
});

// A menu closes when an entry is chosen, when the page is clicked elsewhere, and on Escape.
function closeMenus(except?: HTMLElement): void {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) {
    if (!except || !menu.contains(except) || except.closest('.menu-item')) menu.open = false;
  }
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenus();
});

document.addEventListener('click', (event) => {
  closeMenus(event.target as HTMLElement);
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target || (target as HTMLButtonElement).disabled) return;
  event.preventDefault();
  vscode.postMessage({ type: 'action', action: target.dataset.action ?? '', arg: target.dataset.arg });
});

enableFocusTooltips(document);
vscode.postMessage({ type: 'ready' });
