/** Escapes text for use inside HTML element content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** ` name="value"`, the value escaped, for appending to an element's opening tag. */
export function htmlAttribute(name: string, value: string): string {
  return ` ${name}="${escapeHtml(value)}"`;
}

/** Reports whether a link target is an http(s) or mailto URL, the only kinds rendered as links. */
export function isWebLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Just now", "5m ago", "3h ago", "2d ago", then the date. */
export function formatAgo(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

export const icons = {
  crew: '<svg width="26" height="26" viewBox="0 0 200 200" fill="currentColor"><circle cx="100" cy="100" r="40"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(0.000 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(51.429 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(102.857 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(154.286 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(205.714 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(257.143 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(308.571 100 100) translate(100 54)"/></svg>',
  crewLarge: '<svg width="56" height="56" viewBox="0 0 200 200" fill="currentColor"><circle cx="100" cy="100" r="40"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(0.000 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(51.429 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(102.857 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(154.286 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(205.714 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(257.143 100 100) translate(100 54)"/><path d="M0 0 C 11 -14, 11 -34, 0 -34 C -11 -34, -11 -14, 0 0 Z" transform="rotate(308.571 100 100) translate(100 54)"/></svg>',
  user: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M3 11V3a1 1 0 011-1h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  send: '<svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>',
  stop: '<svg class="send-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};
