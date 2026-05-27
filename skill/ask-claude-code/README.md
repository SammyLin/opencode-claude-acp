# ask-claude-code

An [opencode](https://opencode.ai) skill that lets opencode delegate tasks to **Claude Code** (Anthropic's coding agent) over [ACP](https://agentclientprotocol.com) (Agent Client Protocol) and get the result back.

opencode itself cannot act as an ACP client. This skill ships a small CLI (`acp-client.mjs`) that *is* the ACP client: it launches the `claude-agent-acp` agent, drives a session, and returns Claude Code's final answer.

## Architecture

```
opencode (agent)
   │  runs CLI
   ▼
acp-client.mjs  (ACP client)
   │  ACP over stdio
   ▼
claude-agent-acp  (ACP server exposing Claude Code)
   │  result
   ▼
back to opencode
```

## Install / prerequisites

1. **The ACP adapter**, installed globally:
   ```bash
   npm i -g @agentclientprotocol/claude-agent-acp
   ```
   This provides the `claude-agent-acp` binary (on this machine: `/opt/homebrew/bin/claude-agent-acp`).

2. **Claude authenticated locally.** Run `claude` once and log in.

3. **Node.js** (to run `acp-client.mjs`).

The skill lives at `~/.config/opencode/skills/ask-claude-code/` and opencode picks it up automatically as a global skill.

## Usage

Invoke the CLI directly:

```bash
node ~/.config/opencode/skills/ask-claude-code/acp-client.mjs [options] [prompt]
```

- `prompt` is the task text. If omitted, it is read from STDIN.
- Always pass `--cwd "$(pwd)"` so Claude Code operates on the intended project.
- The final answer prints to stdout. Exit 0 on success, non-zero on error.

### Examples

Ask a question:
```bash
node acp-client.mjs --cwd "$(pwd)" \
  "Where is rate limiting implemented and what's the limit?"
```

Run a code task and watch progress:
```bash
node acp-client.mjs --cwd "$(pwd)" --stream \
  "Refactor utils/date.js to use date-fns and update callers."
```

Let Claude Code edit files unattended:
```bash
node acp-client.mjs --cwd "$(pwd)" --yolo \
  "Fix the failing tests in the billing module."
```

Machine-readable output:
```bash
node acp-client.mjs --cwd "$(pwd)" --json \
  "List every TODO comment with file and line." 
# stdout: { "text": "...", "stopReason": "...", "toolCalls": [...] }
```

Long prompt via STDIN:
```bash
cat task.md | node acp-client.mjs --cwd "$(pwd)"
```

## Persistent sessions

By default every invocation is an **ephemeral one-shot**: Claude Code starts fresh and remembers nothing from earlier calls. To carry a conversation across separate invocations, give it a **named session** with `--session <name>`.

How it works:

- The first call with a given name creates the session and saves it.
- Later calls with the **same** name **resume** it via ACP `session/load`, so Claude Code still has the earlier context (the prior turns, files it read, decisions it made).
- Sessions are stored in `~/.config/opencode/skills/ask-claude-code/sessions.json` (name → session id, cwd, last used, turn count).
- The `--cwd` is recorded per session and must match on resume; the CLI handles this for you by reusing the stored cwd.
- Each prompting run prints which session it used to stderr:
  ```
  [acp] session=refactor-auth id=<sessionId> (resumed)
  ```
  (`new` instead of `resumed` on the first call). With `--json`, the same info appears as `sessionName`, `sessionId`, and `resumed` in the output object.

Start (or continue) a named session:
```bash
node acp-client.mjs --cwd "$(pwd)" --session refactor-auth \
  "Outline a plan to split the token logic out of session.js."

# follow-up — Claude Code remembers the plan above
node acp-client.mjs --cwd "$(pwd)" --session refactor-auth \
  "Now implement step 1 of that plan."
```

Force a fresh thread under the same name (drop prior context):
```bash
node acp-client.mjs --cwd "$(pwd)" --session refactor-auth --new \
  "Start over — propose a different approach."
```

List stored sessions (add `--json` for raw JSON):
```bash
node acp-client.mjs --list-sessions
```

Forget a session:
```bash
node acp-client.mjs --delete-session refactor-auth
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `prompt` (positional) | STDIN | Task text. Read from STDIN if omitted. |
| `--cwd <path>` | current dir | Working directory for the session. Pass the project root. Remembered per named session. |
| `--session <name>` | off (ephemeral) | Use a persistent named session. First use creates+saves it; later uses resume it. Omit for a one-shot that isn't saved. |
| `--new` | off | Force-start a fresh session for the given `--session <name>`, replacing the old thread. |
| `--list-sessions` | — | List stored sessions (name, id, cwd, last used, turn count). With `--json`, raw JSON. Exits without prompting. |
| `--delete-session <name>` | — | Forget a stored session. |
| `--agent-cmd <cmd>` | `claude-agent-acp` | Agent binary to launch. |
| `--yolo` | off | Auto-approve all tool permissions (`allow_always`). Otherwise `allow_once` per call. |
| `--stream` | off | Echo Claude's thoughts and tool calls to stderr for progress. |
| `--json` | off | Emit `{ "text", "stopReason", "toolCalls", "sessionId", "sessionName", "resumed" }` JSON instead of plain text. |
| `--timeout <seconds>` | `600` | Max run time. |

## Troubleshooting

- **`claude-agent-acp` not found / spawn error** — the adapter isn't installed globally. Run `npm i -g @agentclientprotocol/claude-agent-acp`. Or point at a custom path with `--agent-cmd`.
- **Authentication errors** — Claude isn't logged in. Run `claude` once interactively and complete login, then retry.
- **Nothing returned / appears to hang** — add `--stream` to see Claude's thoughts and tool calls on stderr, and confirm it's making progress. If it's a big task, raise `--timeout`.
- **Edits not landing in the right place** — make sure `--cwd` points at the project root (`--cwd "$(pwd)"`).
- **Resume failed / "session not found"** — if a stored session id is stale or expired, the CLI warns on stderr and automatically falls back to starting a new session (it then continues normally). If you want a clean slate yourself, use `--new` or `--delete-session <name>`.

## Notes

Running a task consumes Claude / Anthropic credits and can take a while. Reserve this for self-contained subtasks or second opinions rather than trivial work.
