#!/usr/bin/env python3
"""A real PTY for the acceptance lane's agent terminal (Story MOTIR-6861 · MOTIR-6943).

TEST-ONLY. The agent image compiles node-pty into /opt/motir-terminal
(docs/decisions/agent-terminal.md Q4); the CI runner has no such build, so the
lane's terminal host (host.ts) spawns this bridge instead: it forks the shell on
a real pseudo-terminal and pumps bytes between it and three pipes.

    argv   cols rows file [args...]
    fd 0   bytes typed into the terminal
    fd 1   bytes the terminal printed
    fd 3   control: one "cols rows" line per resize (TIOCSWINSZ, which also
           sends the shell's foreground group its SIGWINCH)

It exits with the shell's own exit code. SIGTERM hangs the shell up.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CONTROL_FD = 3


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)

    def set_size(c, r):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

    def hang_up(*_):
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    set_size(cols, rows)
    signal.signal(signal.SIGTERM, hang_up)
    readers = [master, 0, CONTROL_FD]
    control = b""
    while True:
        try:
            ready, _, _ = select.select(readers, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                out = os.read(master, 65536)
            except OSError:
                out = b""
            if not out:
                break
            write_all(1, out)
        if 0 in ready:
            typed = os.read(0, 65536)
            if typed:
                write_all(master, typed)
            else:
                readers.remove(0)
                hang_up()
        if CONTROL_FD in ready:
            chunk = os.read(CONTROL_FD, 4096)
            if not chunk:
                readers.remove(CONTROL_FD)
                continue
            control += chunk
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                parts = line.split()
                if len(parts) == 2:
                    set_size(int(parts[0]), int(parts[1]))
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    sys.exit(code if code >= 0 else 128 - code)


if __name__ == "__main__":
    main()
