// npm run dev on macOS and Windows alike: the server with --watch and Vite, side by side,
// both stopped with Ctrl+C. (A shell's "a & b; wait" does not run in cmd.exe.)
import { spawn } from 'node:child_process';

const windows = process.platform === 'win32';
const children = [
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch-path=server', '--watch-path=roles', 'server/main.ts', '--dev'], { stdio: 'inherit' }),
  // npx is a .cmd on Windows, which only starts through a shell.
  spawn(windows ? 'npx.cmd' : 'npx', ['vite', '--config', 'web/vite.config.ts'], { stdio: 'inherit', shell: windows }),
];
const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
