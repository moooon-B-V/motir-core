# motir-sandbox: make the image's agent-config setup reachable from a shell that
# never went through the entrypoint (MOTIR-4959 / MOTIR-4956).
#
# SOURCED, never executed. The whole point is to put CLAUDE_CONFIG_DIR — and the
# codex / opencode equivalents — into THIS shell, and a child process cannot do
# that to its parent. Both hooks the Dockerfile installs source this one file:
# /etc/profile.d for a login shell, ~/.bashrc for an interactive non-login one.
#
# Deliberately POSIX `sh`: /etc/profile.d is read by dash as well as bash.
#
# Every line is best-effort. A shell that will not start is a far worse outcome
# than an agent without a code graph, so nothing here may fail or exit.

__motir_sandbox_agent_home="${HOME}/.motir-sandbox/agent-config"

# Run the setup ONCE PER CONTAINER. The sentinel lives in the container's
# writable layer and no recipe mounts over it, so a fresh container never has one
# and every shell after the first skips straight to the env file below.
#
# stdout is redirected because the CLI's delivery contract reserves it for the
# prompt alone; stderr is left alone on purpose — that is where this image puts
# every diagnostic, and the first shell of a container is exactly where somebody
# should see one.
if [ ! -e "${__motir_sandbox_agent_home}/.setup-done" ] &&
    command -v motir-sandbox-agent-config >/dev/null 2>&1; then
    motir-sandbox-agent-config >/dev/null || true
fi

# UNCONDITIONAL, and deliberately outside the guard above. A container that is
# stopped and STARTED again keeps its sentinel, so the setup does not re-run —
# and this is what still hands that container's shells the right
# CLAUDE_CONFIG_DIR.
if [ -r "${__motir_sandbox_agent_home}/env.sh" ]; then
    . "${__motir_sandbox_agent_home}/env.sh"
fi

unset __motir_sandbox_agent_home
