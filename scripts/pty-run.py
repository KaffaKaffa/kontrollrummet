# Runs a command in a pseudo-terminal and relays it over plain pipes, for
# commands that refuse to run without a terminal (claude mcp login). Used by
# server/mcp-login.ts:  python3 -I scripts/pty-run.py <command> [args...]
import os
import pty
import select
import sys

pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

inputs = [fd, 0]
while True:
    ready, _, _ = select.select(inputs, [], [])
    if fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 4096)
        if data:
            os.write(fd, data)
        else:
            inputs.remove(0)

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
