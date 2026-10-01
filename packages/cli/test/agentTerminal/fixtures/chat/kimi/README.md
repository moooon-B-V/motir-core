# kimi chat fixtures (MOTIR-7034)

**These streams are CONSTRUCTED, not recorded.** No `kimi` binary was installed
where the adapter was written, and no model was called. Each file is built from:

- the real `kimi-code` **2.1.1** capture recorded in
  `docs/decisions/agent-chat.md` Q1 (the version `packages/cli/sandbox/install-agent.sh`
  installed on 2026-09-30): the `{"role":"meta","type":"system.version"}` banner,
  assistant lines with `content` and OpenAI-shaped `tool_calls`
  (`function.arguments` a JSON string), `{"role":"tool","tool_call_id","content"}`
  results, and the `session.resume_hint` meta line that ends a turn;
- Q1's observed Stop (SIGINT: exit 130, the partial reply flushed, no resume
  hint);
- kimi's documented `--output-format stream-json` message shape
  (https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html).

What is NOT from the capture, and should be replaced by a real recording from the
pinned version when one is taken:

- the tool names other than `Bash` (`ReadFile`, `StrReplaceFile`) and their
  argument shapes (`path`, `edit: { old, new }`);
- the `<system>…</system>` notes in a tool result, and `ERROR: … exit code: N`
  as the failure signal;
- `session_index.jsonl`'s row shape (`session_id`, `work_dir`, `title`,
  `updated_at`). The adapter reads several field names for each, tolerantly.

Every stream file's first line is a header, `{"fixture", "cli", "source", "exit",
"stop"?, "session"?}`, naming the CLI version. The test strips it before replay
and uses `exit` as the fake process's exit code, `stop` to send a Stop before
exiting, and `session` to replay the turn as a resume.
