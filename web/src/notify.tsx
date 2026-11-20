import { useEffect, useRef, useState } from 'react';
import { nameOf, type Board, type Subtask } from './api.ts';

/**
 * System notifications when something needs the owner or is done: a card that
 * waits for him, finishes, opens a PR or fails; an approval; an agent's
 * notice; Gudfadern's answer. Kontrollrummet.app shows them as macOS
 * notifications (its "notify" message handler); a browser or an app window on
 * Windows uses the Notification API. Nothing while the owner is looking at
 * the window. A click opens what it is about.
 */

const KEY = 'kontrollrummet.notify';

// Font Awesome Pro 7.1.0, regular: bell and bell-slash (https://fontawesome.com/license, Commercial License).
const BELL = 'M320 64C306.7 64 296 74.7 296 88L296 97.7C214.6 109.3 152 179.4 152 264L152 278.5C152 316.2 142 353.2 123 385.8L101.1 423.2C97.8 429 96 435.5 96 442.2C96 463.1 112.9 480 133.8 480L506.2 480C527.1 480 544 463.1 544 442.2C544 435.5 542.2 428.9 538.9 423.2L517 385.7C498 353.1 488 316.1 488 278.4L488 263.9C488 179.3 425.4 109.2 344 97.6L344 87.9C344 74.6 333.3 63.9 320 63.9zM488.4 432L151.5 432L164.4 409.9C187.7 370 200 324.6 200 278.5L200 264C200 197.7 253.7 144 320 144C386.3 144 440 197.7 440 264L440 278.5C440 324.7 452.3 370 475.5 409.9L488.4 432zM252.1 528C262 556 288.7 576 320 576C351.3 576 378 556 387.9 528L252.1 528z';
const BELL_SLASH = 'M73 39.1C63.6 29.7 48.4 29.7 39.1 39.1C29.8 48.5 29.7 63.7 39 73.1L567 601.1C576.4 610.5 591.6 610.5 600.9 601.1C610.2 591.7 610.3 576.5 600.9 567.2L513.1 479.4C530.6 476.1 543.9 460.7 543.9 442.3C543.9 435.6 542.1 429 538.8 423.3L517 385.7C498 353.1 488 316.1 488 278.4L488 263.9C488 179.3 425.4 109.2 344 97.6L344 87.9C344 74.6 333.3 63.9 320 63.9C306.7 63.9 296 74.6 296 87.9L296 97.6C253.8 103.6 216.6 125.4 190.6 156.7L73 39.1zM224.8 190.9C246.7 162.4 281.2 144 320 144C386.3 144 440 197.7 440 264L440 278.5C440 324.7 452.3 370 475.5 409.9L488.4 432L465.8 432L224.7 190.9zM164.5 409.9C184 376.5 195.8 339.2 199.1 300.9L152.4 254.2C152.2 257.5 152.1 260.8 152.1 264.1L152.1 278.6C152.1 316.3 142.1 353.3 123.1 385.9L101.1 423.2C97.7 429 96 435.5 96 442.2C96 463.1 112.9 480 133.8 480L378.2 480L330.2 432L151.6 432L164.5 409.9zM252.1 528C262 556 288.7 576 320 576C351.3 576 378 556 387.9 528L252.1 528z';

function BellIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 640 640" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" d={off ? BELL_SLASH : BELL} />
    </svg>
  );
}

interface Note {
  title: string;
  body: string;
  /** The page's hash to open on a click. */
  href: string;
  /** One notification per thing: a newer one replaces it. */
  tag: string;
}

type Bridge = { webkit?: { messageHandlers?: { notify?: { postMessage: (n: Note) => void } } } };
const bridge = () => (window as Bridge).webkit?.messageHandlers?.notify;

function readEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
}

const supported = () => Boolean(bridge()) || 'Notification' in window;

function show(note: Note) {
  // The app decides itself whether its window is in front.
  const app = bridge();
  if (app) return app.postMessage(note);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const n = new Notification(note.title, { body: note.body, tag: note.tag, icon: '/icons/icon-192.png' });
  n.onclick = () => {
    window.focus();
    location.hash = note.href;
    n.close();
  };
}

const firstLine = (s: string | null | undefined, max = 180) => {
  const line = (s ?? '').split('\n').map((l) => l.replace(/[*`#>]/g, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a card's change means for the owner, or nothing. */
function cardNote(board: Board, s: Subtask, before: Subtask['status']): Note | null {
  if (s.status === before) return null;
  const team = board.teams.find((t) => t.id === s.team);
  const role = team?.roles.find((r) => r.id === s.agent);
  const who = `${nameOf(role) ?? s.agent} #${s.id}${team && board.teams.length > 1 ? ` · ${team.name}` : ''}`;
  const href = `#/${s.team}/office/card/${s.id}`;
  const tag = `card-${s.id}`;
  if (s.status === 'needs-you') return { title: `${who} behöver dig`, body: firstLine(s.ask?.question ?? s.summary ?? s.brief), href, tag };
  if (s.status === 'pr-open' && before !== 'pr-open') return { title: `${who}: PR${s.prNumber != null ? ` #${s.prNumber}` : ''} öppen`, body: firstLine(s.summary ?? s.brief), href, tag };
  if (s.status === 'done') return { title: `${who} är klar`, body: firstLine(s.summary ?? s.brief), href, tag };
  if (s.status === 'failed') return { title: `${who} gick inte`, body: firstLine(s.summary ?? s.brief), href, tag };
  return null;
}

/** Watches the board and notifies on what changed since the last look. The first look only remembers. */
export function useSystemNotifications(board: Board) {
  const seen = useRef<{ cards: Map<number, Subtask['status']>; approvals: Set<string>; notices: Set<number>; convs: Map<number, string> } | null>(null);
  useEffect(() => {
    if (!board.teams.length) return;
    const now = {
      cards: new Map(board.subtasks.map((s) => [s.id, s.status])),
      approvals: new Set(board.approvals.map((a) => a.id)),
      notices: new Set(board.notices.map((n) => n.id)),
      convs: new Map(board.conversations.map((c) => [c.id, c.status])),
    };
    const before = seen.current;
    seen.current = now;
    if (!before || !readEnabled() || !supported()) return;

    for (const s of board.subtasks) {
      const was = before.cards.get(s.id);
      if (was === undefined) continue;
      const note = cardNote(board, s, was);
      if (note) show(note);
    }
    for (const a of board.approvals) {
      if (before.approvals.has(a.id)) continue;
      const card = a.subtaskId != null ? board.subtasks.find((s) => s.id === a.subtaskId) : undefined;
      const role = card ? board.teams.find((t) => t.id === card.team)?.roles.find((r) => r.id === card.agent) : undefined;
      show({
        title: `${card ? `${nameOf(role) ?? card.agent} #${card.id}` : 'Gudfadern'} vill ha ditt godkännande`,
        body: firstLine(a.summary),
        href: card ? `#/${card.team}/office/card/${card.id}` : a.conversationId != null ? `#/gudfadern/${a.conversationId}` : '#/',
        tag: `approval-${a.id}`,
      });
    }
    for (const n of board.notices) {
      if (before.notices.has(n.id)) continue;
      const team = board.teams.find((t) => t.id === n.team);
      show({
        title: team ? `Kontrollrummet · ${team.name}` : 'Kontrollrummet',
        body: firstLine(n.text),
        href: n.subtaskId != null ? `#/${n.team}/office/card/${n.subtaskId}` : `#/${n.team}`,
        tag: `notice-${n.id}`,
      });
    }
    for (const c of board.conversations) {
      const was = before.convs.get(c.id);
      if (was === 'running' && c.status !== 'running') {
        show({ title: c.status === 'error' ? `Gudfadern: ${c.title} stannade` : `Gudfadern har svarat`, body: firstLine(c.title), href: `#/gudfadern/${c.id}`, tag: `conv-${c.id}` });
      }
    }
  }, [board]);
}

/** On or off, in the top bar; in a browser, turning it on asks for permission. */
export function NotifyToggle() {
  const [on, setOn] = useState(readEnabled);
  const [blocked, setBlocked] = useState(() => !bridge() && 'Notification' in window && Notification.permission === 'denied');
  // A browser needs permission once; asked for when it is on but not granted yet, on the first click.
  const needsPermission = !bridge() && 'Notification' in window && Notification.permission === 'default';
  if (!supported()) return null;
  return (
    <button
      type="button"
      className="icon-btn notify-toggle"
      aria-pressed={on && !needsPermission && !blocked}
      aria-label={blocked ? 'Notiser blockerade av webbläsaren' : on && !needsPermission ? 'Systemnotiser på' : 'Systemnotiser av'}
      title={blocked ? 'Webbläsaren blockerar notiser för sidan: tillåt dem i webbläsarens inställningar.' : on ? 'Systemnotiser är på. Klicka för att stänga av.' : 'Systemnotiser är av. Klicka för att slå på.'}
      onClick={async () => {
        if (needsPermission) {
          const p = await Notification.requestPermission();
          setBlocked(p === 'denied');
          writeEnabled(p === 'granted');
          setOn(p === 'granted');
          return;
        }
        writeEnabled(!on);
        setOn(!on);
      }}
    >
      <BellIcon off={!(on && !needsPermission) || blocked} />
    </button>
  );
}
