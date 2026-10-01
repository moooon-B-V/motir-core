#!/usr/bin/env python3
"""A STUB of `motir run <KEY> --run-id <id>` in AGENT MODE — what a card's run
session runs on the acceptance lane's fake agent machines (Story MOTIR-6864 ·
MOTIR-7031). TEST-ONLY: only the lane's terminal host (host.ts) hands it to the
REAL terminal server as the CLI its run session re-enters.

WHY A STUB. Everything around it is real: Motir's start, the launch job, the
orchestrator exec, the real `motir agent-terminal run` launcher writing the run
token into the run's 0700 state directory, the real server opening the run
session on a real PTY, the relay, the browser watching it. What the real
`motir run` would do INSIDE the session — clone the card's repositories from
GitHub, drive a real coding agent for minutes, push a branch — cannot happen in
this lane. So this plays the CLI's side of the run over the SAME `/api/v1`
ingest the real one uses, authenticated with the run's OWN token (read from
`$MOTIR_HOSTED_STATE/run.json`, which is where the launcher wrote it), and runs
the stub `claude -p` as its coding agent, echoing what it prints to the session
and into the run's log.

    adopt the run -> checkout_ready (no clone; see below) -> agent_started
    -> claude -p (its lines, live) -> agent_exited
    -> link the pull request the fake GitHub opened -> delivery_linked
    -> the card to Implemented -> close the run (drained)

The pull request's number is the content of the release file the spec writes
(paths.ts `runReleaseFile`) — the spec plays GitHub opening it. SIGTERM/SIGHUP
(Cancel run -> `motir agent-terminal stop`) stop the coding agent and exit.
"""
import json
import os
import signal
import subprocess
import sys
import urllib.error
import urllib.request

CHILD = None


def stop(signum, _frame):
    if CHILD is not None and CHILD.poll() is None:
        CHILD.terminate()
    print(f"\r\n[motir] run stopped (signal {signum})", flush=True)
    sys.exit(128 + signum)


def say(line):
    print(f"[motir] {line}", flush=True)


class Api:
    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self.token = token

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                raw = res.read().decode("utf-8")
                return res.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            return err.code, raw

    def must(self, method, path, body=None, ok=(200, 201, 204)):
        status, answer = self.call(method, path, body)
        if status not in ok:
            say(f"{method} {path} answered {status}: {str(answer)[:300]}")
            sys.exit(1)
        return answer

    def events(self, run_id, events):
        self.must("POST", f"/api/v1/dispatch-runs/{run_id}/events", {"events": events})

    def heartbeat(self, run_id):
        self.call("POST", f"/api/v1/dispatch-runs/{run_id}/heartbeat")


def main():
    global CHILD
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    args = sys.argv[1:]
    if len(args) < 4 or args[0] != "run" or args[2] != "--run-id":
        say(f"unexpected arguments: {args}")
        return 2
    key, run_id = args[1], args[3]
    state = os.environ.get("MOTIR_HOSTED_STATE", "")
    if os.environ.get("MOTIR_AGENT_RUN") != "1" or not state:
        say("not started as a run in an agent (MOTIR_AGENT_RUN / MOTIR_HOSTED_STATE unset)")
        return 2
    with open(os.path.join(state, "run.json"), encoding="utf-8") as fh:
        access = json.load(fh)
    api = Api(access["apiUrl"], access["token"])

    say(f"motir run {key} — agent mode, run {run_id}")
    api.must("GET", f"/api/v1/dispatch-runs/{run_id}")
    api.heartbeat(run_id)
    # The real CLI clones here, with the run's git credential. The lane cannot mint
    # a GitHub installation token, so the stub clones nothing and reads the
    # project's repository from the file the seed wrote (paths.ts
    # `runRepositoryFile`).
    e2e_dir = os.path.join(os.environ["HOME"], ".motir-e2e")
    with open(os.path.join(e2e_dir, "repository"), encoding="utf-8") as fh:
        repository = fh.read().strip()
    branch = f"motir/{key.lower()}"
    say(f"checked out {repository} on {branch}")
    api.events(
        run_id,
        [
            {
                "kind": "checkout_ready",
                "workItemKey": key,
                "data": {
                    "branch": branch,
                    "branches": [{"repository": repository, "branch": branch, "workBranch": branch}],
                },
            }
        ],
    )
    say("starting Claude Code")
    api.events(run_id, [{"kind": "agent_started", "workItemKey": key}])

    release = os.path.join(e2e_dir, f"release-{run_id}")
    env = dict(os.environ, MOTIR_E2E_RELEASE=release)
    CHILD = subprocess.Popen(
        ["claude", "-p", f"Work on {key}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    for line in CHILD.stdout:
        print(line, end="", flush=True)
        api.events(run_id, [{"kind": "log", "workItemKey": key, "body": line}])
        api.heartbeat(run_id)
    code = CHILD.wait()
    api.events(run_id, [{"kind": "agent_exited", "workItemKey": key, "exitCode": code}])
    if code != 0:
        say(f"Claude Code exited {code}")
        api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "halted"})
        return code

    with open(release, encoding="utf-8") as fh:
        number = int(fh.read().strip())
    api.must(
        "POST",
        f"/api/v1/work-items/{key}/pull-requests",
        {"repository": repository, "number": number, "headRef": branch, "baseRef": "main"},
    )
    api.events(run_id, [{"kind": "delivery_linked", "workItemKey": key, "data": {"repository": repository}}])
    say(f"opened pull request {repository}#{number}")
    api.must("POST", f"/api/v1/work-items/{key}/transitions", {"status": "implemented"})
    say(f"{key} is Implemented")
    api.must("POST", f"/api/v1/dispatch-runs/{run_id}/close", {"stopReason": "drained"})
    say("run closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
