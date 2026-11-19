import { bus } from './bus.ts';
import { createSubtask, createTask, getPlan, listSubtasks, updatePlan, type Plan, type Subtask, type Task } from './db.ts';
import { ANY_PR_URL } from './git.ts';
import { tick } from './orchestrator.ts';
import { getTeam } from './roles.ts';
import { OWNER } from './owner.ts';

/** Things the owner does, from the board or from a desk session in the Claude app. */

const firstLine = (s: string) => s.split('\n')[0].slice(0, 120);

export function submitTask(teamId: string, text: string, agent?: string): { task: Task; subtask: Subtask } {
  const team = getTeam(teamId);
  if (!team) throw new Error(`okänt team ${teamId}`);
  // Everything goes to the team leader unless a specific teammate is named.
  const role = agent ? team.roles.find((r) => r.id === agent) : (team.roles.find((r) => r.kind === 'lead') ?? team.roles[0]);
  if (!role) throw new Error(`okänd agent ${agent} i ${team.name}`);
  const task = createTask(team.id, firstLine(text), text);
  bus.emit({ type: 'task', task });
  const subtask = createSubtask(task, role.id, text);
  bus.emit({ type: 'subtask', subtask });
  tick();
  return { task, subtask };
}

/**
 * A PR the owner is asked to review, handed to the team leader: does it break
 * anything in what the owner is responsible for, and what was done, so he
 * knows. The lead never approves in his name on its own: the card stops on
 * him with the summary, and approving is his click. One card per PR.
 */
export function delegateReview(teamId: string, url: string, title?: string): Subtask {
  const team = getTeam(teamId);
  if (!team) throw new Error(`okänt team ${teamId}`);
  const pr = [...url.matchAll(ANY_PR_URL)][0]?.[0];
  if (!pr || pr !== url.trim()) throw new Error('det är ingen PR-länk');
  const open = listSubtasks().find((s) => s.team === teamId && s.brief.includes(pr) && s.status !== 'done' && s.status !== 'failed');
  if (open) return open;
  const me = team.people.find((p) => p.name.toLowerCase().startsWith(OWNER.toLowerCase()));
  const brief = `Granska PR ${pr}${title ? ` (”${title}”)` : ''} åt ${OWNER}.

${OWNER} är ombedd att granska den. Oftast är det för att den rör det ${OWNER} ansvarar för${me?.does ? ` (${me.does})` : ''}, och då vill ${OWNER} veta två saker, i den här ordningen:
1. Förstör den något i ${OWNER}s delar? Läs diffen (gh pr diff, eller az repos pr för Azure DevOps), och bygg eller testa det som rör dem om det går. Låt en agent i teamet som kan delen bättre titta, om det behövs.
2. Vad har gjorts? En kort sammanfattning, så att ${OWNER} vet vad som ändrats i det ${OWNER} ansvarar för.

Granska inte i ${OWNER}s namn och godkänn inte på egen hand. Avsluta med report needs-you: question = sammanfattningen och din bedömning (vad som ändrats, risker för ${OWNER}s delar, eventuella frågor till författaren); options = "Godkänn PR:en", "Skriv kommentarerna till författaren", "Jag tittar själv". Väljer ${OWNER} att godkänna: godkänn med gh pr review --approve (Azure DevOps: az repos pr set-vote --vote approve) och en kort kommentar om vad som granskats. Kommentarer skrivs på PR:en med det ${OWNER} godkänt.`;
  return submitTask(teamId, brief).subtask;
}

export type PlanAction = 'implement' | 'park' | 'unpark' | 'discard';

export function planAction(id: number, action: PlanAction): Plan {
  const p = getPlan(id);
  if (!p) throw new Error('planen finns inte');
  let updated: Plan;
  if (action === 'implement') {
    if (p.status === 'implementing') throw new Error('planen genomförs redan');
    const brief = `Genomför plan #${p.id}: ${p.title}\n\nArkitekten har tagit fram planen och ${OWNER} har valt att genomföra den. Dela ut den enligt stegen.\n\n${p.body}`;
    const { task } = submitTask(p.team, brief);
    updated = updatePlan(p.id, { status: 'implementing', taskId: task.id });
  } else {
    const status = ({ park: 'parked', unpark: 'ready', discard: 'discarded' } as const)[action];
    updated = updatePlan(p.id, { status });
  }
  bus.emit({ type: 'plan', plan: updated });
  return updated;
}
