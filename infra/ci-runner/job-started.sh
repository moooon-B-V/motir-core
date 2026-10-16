#!/usr/bin/env bash
#
# The runner's job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED, set by
# `entrypoint.sh`). Whatever it prints lands in the JOB LOG, which is the only
# log a tenant or Motir can read from GitHub. It reports the dockerd storage
# outcome `start-dockerd.sh` recorded, so a Docker failure inside a job (MOTIR-8821)
# names its storage candidate and driver without anyone needing the Machine console.
#
# Informational only: it must never fail a job.

cat /run/motir-ci-runner-docker-storage 2>/dev/null \
  || echo "dockerd storage: not started (MOTIR_RUNNER_SKIP_DOCKER or a pre-start boot)"
exit 0
