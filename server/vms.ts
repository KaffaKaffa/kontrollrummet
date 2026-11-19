import { execFile } from './proc.ts';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { expandHome } from './config.ts';
import type { Team } from './roles.ts';

const run = promisify(execFile);

/**
 * Virtual machines a team can test on, such as the Parallels Windows VM. An
 * agent asks; the owner approves in the Inbox; the server wakes it and waits for
 * SSH. A VM the card woke goes back to sleep when the card's turn ends.
 */

export interface VmConfig {
  /** The name prlctl knows it by. */
  name: string;
  /** The .pvm bundle: opened when the VM is stopped, since Standard refuses prlctl start. */
  bundle?: string;
  /** Host that answers on port 22 once Windows is up. */
  sshHost?: string;
  /** For the agents' prompt: how to sign in once it is up. */
  sshUser?: string;
  sshKey?: string;
  sshHostKeyAlias?: string;
}

async function state(vm: VmConfig): Promise<string> {
  const { stdout } = await run('prlctl', ['list', '-a', '-o', 'status,name', '--no-header']);
  const line = stdout.split('\n').find((l) => l.trim().endsWith(vm.name));
  if (!line) throw new Error(`Parallels känner inte till "${vm.name}"`);
  return line.trim().split(/\s+/)[0];
}

function sshUp(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 22, timeout: 2000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Wakes the VM if it is not running. Returns whether this call woke it. */
export async function wakeVm(vm: VmConfig): Promise<{ woke: boolean; message: string }> {
  const before = await state(vm);
  let woke = false;
  if (before === 'suspended' || before === 'paused') {
    await run('prlctl', ['resume', vm.name]);
    woke = true;
  } else if (before === 'stopped') {
    if (!vm.bundle) throw new Error('VM:en är avstängd och inget bundle är angivet i team.json');
    // Parallels Standard refuses prlctl start; opening the bundle boots it in the app.
    await run('open', [expandHome(vm.bundle)]);
    woke = true;
  } else if (before !== 'running') {
    throw new Error(`VM:en är i läget ${before}`);
  }
  if (vm.sshHost) {
    const until = Date.now() + 4 * 60_000;
    while (Date.now() < until) {
      if (await sshUp(vm.sshHost)) return { woke, message: `${vm.name} är igång och svarar på SSH (${vm.sshHost}).` };
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { woke, message: `${vm.name} startades men svarar inte på SSH än. Försök igen om en stund.` };
  }
  return { woke, message: `${vm.name} är igång.` };
}

export async function sleepVm(vm: VmConfig): Promise<void> {
  if ((await state(vm)) === 'running') await run('prlctl', ['suspend', vm.name]);
}

export function vmFor(team: Team, id: string): VmConfig | undefined {
  return team.vms?.[id];
}
