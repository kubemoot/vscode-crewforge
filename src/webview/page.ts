/**
 * The script of CrewForge's dashboard pages (a crew, the crews overview, a fitness run).
 * The extension renders each page as HTML with every value escaped and posts it here;
 * this script only shows it and reports which button was pressed. It holds no state of
 * its own, so the extension stays the one place that decides what a button does.
 */
import type { PageHostMessage, PageMessage } from './pageProtocol';

interface VsCodeApi {
  postMessage(message: PageMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

// VS Code's host frame forwards each extension message with this page's own origin; a
// message from any other origin came from another window and is ignored.
globalThis.addEventListener('message', (event: MessageEvent<PageHostMessage>) => {
  if (event.origin !== globalThis.origin) return;
  const message = event.data;
  if (message?.type === 'render' && typeof message.html === 'string') root.innerHTML = message.html;
});

document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target || (target as HTMLButtonElement).disabled) return;
  event.preventDefault();
  vscode.postMessage({ type: 'action', action: target.dataset.action ?? '', arg: target.dataset.arg });
});

vscode.postMessage({ type: 'ready' });
