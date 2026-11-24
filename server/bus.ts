import { EventEmitter } from 'node:events';
import type { AgentEvent, ConvEvent, Conversation, Notice, Plan, Subtask, Task } from './db.ts';
import type { Usage } from './usage.ts';
import type { Consultation } from './consultations.ts';
import type { Job } from './deploy.ts';
import type { DevAppView } from './devapps.ts';
import type { OwnPr } from './git.ts';

export interface Approval {
  id: string;
  /** The card asking, or null when a Gudfadern conversation asks. */
  subtaskId: number | null;
  conversationId?: number;
  /** The card's team; empty for a conversation. */
  team: string;
  tool: string;
  /** What the agent wants to run, short enough to read on a phone. */
  summary: string;
  /** Rules proposed for "Tillåt alltid", from the command. */
  suggestedRules?: string[];
  at: string;
  /**
   * Claude Code already said no on its own (a hard rule or auto mode), so
   * nothing waits on this: a yes allows it for the card and tells the agent to
   * run it again. The reason as Claude Code gave it.
   */
  denied?: string;
}

/** What the browser hears about, pushed over the WebSocket as it happens. */
export type Broadcast =
  | { type: 'task'; task: Task }
  | { type: 'subtask'; subtask: Subtask }
  | { type: 'event'; event: AgentEvent }
  | { type: 'notice'; notice: Notice }
  | { type: 'own-prs'; team: string; prs: (OwnPr & { repo: string })[] }
  | { type: 'plan'; plan: Plan }
  | { type: 'usage'; account: string; usage: Usage }
  | { type: 'job'; job: Job }
  | { type: 'approval'; approval: Approval }
  /** A question to a consultant: started, a piece of its reasoning or answer, finished. */
  | { type: 'consultation'; consultation: Consultation }
  | { type: 'approval-done'; id: string }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conv-event'; event: ConvEvent }
  | { type: 'restart'; waitingFor: number | null }
  /** A project's local apps: started, stopped, someone waiting. */
  | { type: 'devapps'; team: string; apps: DevAppView[] }
  /** New output from a local app, for its open window. */
  | { type: 'devapp-log'; key: string; text: string }
  /** A project's files changed (an agent added, a logo): the page reloads the teams. */
  | { type: 'teams' };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const bus = {
  emit(message: Broadcast) {
    emitter.emit('message', message);
  },
  on(listener: (message: Broadcast) => void) {
    emitter.on('message', listener);
    return () => emitter.off('message', listener);
  },
};
