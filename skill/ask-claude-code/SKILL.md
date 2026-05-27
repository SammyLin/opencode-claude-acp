---
name: ask-claude-code
description: Delegate a self-contained coding or analysis subtask to Claude Code (Anthropic's agent) and get the result back — use to ask Claude Code to investigate, edit, or build something, to run a task through Claude Code via ACP, to continue a conversation with Claude Code or resume a Claude Code session across calls, or to get a second opinion from Claude on code.
---

# ask-claude-code

Bridge that lets opencode hand a task to Claude Code and receive the answer. opencode cannot speak ACP (Agent Client Protocol) itself, so this skill wraps a small CLI that acts as the ACP client driving the `claude-agent-acp` agent.

```
opencode (you)  ──runs──▶  acp-client.mjs (ACP client)  ──ACP──▶  claude-agent-acp (Claude Code)  ──result──▶  back to you
```

## Invoke

Run the CLI with the task as the prompt. Always pass `--cwd "$(pwd)"` so Claude Code edits the files in the current opencode project, not somewhere else.

```bash
__ACP_CLI__ --cwd "$(pwd)" "<task>"
```

The final answer prints to stdout. Exit code 0 means success; non-zero means error.

### Examples

Ask a question (read-only investigation):
```bash
__ACP_CLI__ --cwd "$(pwd)" \
  "Explain how auth tokens are refreshed in this codebase and where the logic lives."
```

Code task with live progress on stderr:
```bash
__ACP_CLI__ --cwd "$(pwd)" --stream \
  "Add input validation to the POST /users handler and update its tests."
```

Machine-readable output (parse the JSON):
```bash
__ACP_CLI__ --cwd "$(pwd)" --json \
  "Audit this repo for hardcoded secrets and list each finding." 
# stdout: { "text": "...", "stopReason": "...", "toolCalls": [...] }
```

For a long task text, omit the positional prompt and pipe it on STDIN instead.

## Multi-turn conversations (persistent sessions)

By default each call is an ephemeral one-shot — Claude Code does NOT remember earlier calls. To hold a multi-turn conversation or keep context across separate invocations, pass a STABLE `--session <name>` (one name per ongoing task/thread, e.g. `--session refactor-auth`). The first call with a name creates and saves the session; later calls with the same name RESUME it, so Claude Code remembers the earlier context. The `--cwd` is remembered per session.

Start a session:
```bash
__ACP_CLI__ --cwd "$(pwd)" --session refactor-auth \
  "Walk the auth module and outline a plan to split the token logic out of session.js."
```

Follow-up call that relies on remembered context:
```bash
__ACP_CLI__ --cwd "$(pwd)" --session refactor-auth \
  "Good. Now implement step 1 of that plan."
```

List stored sessions (name, id, cwd, last used, turn count):
```bash
__ACP_CLI__ --list-sessions
```

Every prompting run prints which session was used to STDERR:
```
[acp] session=refactor-auth id=<sessionId> (resumed)
```
With `--json`, the same info is in the output object as `sessionName`, `sessionId`, and `resumed` (alongside `text`, `stopReason`, `toolCalls`). Read either to report which session you used.

- Reuse the same `--session <name>` to continue a thread; pass `--new` to force-start a fresh session under that name (replacing the old thread) when you want to drop prior context.
- No `--session` at all is fine for one-off questions — the result just isn't saved.

## Options

- `--cwd <path>` — session working dir (default: current dir). Pass the project root. Remembered per named session.
- `--session <name>` — use a persistent named session. First use creates+saves it; later uses with the same name resume it. Omit for an ephemeral one-shot (not saved).
- `--new` — force-start a fresh session for the given `--session <name>`, replacing the old thread.
- `--list-sessions` — list stored sessions (name, id, cwd, last used, turn count); with `--json`, raw JSON. Exits without prompting.
- `--delete-session <name>` — forget a stored session.
- `--yolo` — auto-approve every tool permission with allow_always. Without it, each tool call is approved once (allow_once).
- `--stream` — echo Claude's thoughts and tool calls to stderr for progress visibility.
- `--json` — emit `{ "text", "stopReason", "toolCalls", "sessionId", "sessionName", "resumed" }` instead of plain text.
- `--timeout <seconds>` — default 600.
- `--agent-cmd <cmd>` — agent binary, default `claude-agent-acp`.

Sessions are persisted at `~/.config/opencode-claude-acp/sessions.json` (override with `OPENCODE_CLAUDE_ACP_STORE`) and resumed via ACP `session/load`.

## When to use

- Offload a self-contained coding, refactor, or analysis task to Claude Code.
- Get a second opinion from Claude on a design or a tricky bug.

## When not to use

- Trivial edits or lookups you can do yourself — don't round-trip them.
- Be aware: this consumes Claude / Anthropic credits and can take a while (tasks may run up to the timeout).

## File edits and `--yolo`

By default each tool permission is approved once per call. Pass `--yolo` to auto-approve everything (allow_always) so Claude Code can read and modify files unattended. Only suggest `--yolo` when the user explicitly wants Claude Code to make changes on its own; otherwise leave it off so edits surface for approval.

## Prerequisites

- `@agentclientprotocol/claude-agent-acp` available (the `claude-agent-acp` binary on PATH, or installed as a dependency of this tool). Install globally with `npm i -g @agentclientprotocol/claude-agent-acp` if missing.
- Claude authenticated locally. If you hit auth errors, the user should run `claude` once to log in.
