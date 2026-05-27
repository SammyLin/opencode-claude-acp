# opencode-claude-acp

Call **Claude Code** from **opencode** (or any shell) over the [Agent Client
Protocol (ACP)](https://agentclientprotocol.com), with **resumable named
sessions** so a conversation isn't lost between calls.

opencode can act as an ACP *server* but not an ACP *client*, so it can't drive
another ACP agent on its own. This project fills that gap: a tiny zero-dependency
ACP **client** CLI that spawns the `claude-agent-acp` agent, plus an opencode
skill that wires it in.

```
opencode (or your shell)
      │  runs
      ▼
opencode-claude-acp  ──ACP / JSON-RPC over stdio──▶  claude-agent-acp  ──▶  Claude Code
      ▲                                                                        │
      └──────────────────────  final answer / streamed updates  ◀─────────────┘
```

## Install

### Option A — npm (run anywhere)

```bash
# one-off, no install:
npx opencode-claude-acp "Summarize what this repo does"

# or install globally to get the `opencode-claude-acp` / `claude-acp` commands:
npm i -g opencode-claude-acp
```

Then install the opencode skill (so the opencode agent can call it automatically):

```bash
opencode-claude-acp-install            # → ~/.config/opencode/skills/ask-claude-code
opencode-claude-acp-install --claude   # → ~/.claude/skills
opencode-claude-acp-install --project  # → ./.opencode/skills (current repo)
```

### Option B — git checkout (no npm registry)

```bash
git clone git@github.com:SammyLin/opencode-claude-acp.git
cd opencode-claude-acp
./install.sh                # installs deps + the skill into ~/.config/opencode/skills
./install.sh --claude       # or into ~/.claude/skills
./install.sh --uninstall    # remove the skill
```

`install.sh` bundles the `claude-agent-acp` agent into the local `node_modules`,
and the CLI uses that bundled copy automatically when the agent isn't on PATH.

## Prerequisites

- **Node.js ≥ 18**.
- **Claude authenticated locally** — run `claude` once to log in. The agent uses
  your existing Claude credentials (no API key juggling).
- The `claude-agent-acp` agent. It's pulled in as a dependency by both install
  paths; install it standalone with `npm i -g @agentclientprotocol/claude-agent-acp`
  if you want it on PATH.

## Usage

```bash
opencode-claude-acp [options] [prompt]
```

The task is the positional `prompt` (or piped on STDIN). The final answer prints
to stdout; exit code 0 = success.

```bash
# ask a question
opencode-claude-acp --cwd "$(pwd)" "Where is auth-token refresh handled here?"

# a code task, streaming Claude's progress to stderr
opencode-claude-acp --cwd "$(pwd)" --stream \
  "Add input validation to the POST /users handler and update its tests."

# let Claude edit files unattended (auto-approve tool permissions)
opencode-claude-acp --cwd "$(pwd)" --yolo "Fix the failing test in cart.test.js"

# machine-readable result
opencode-claude-acp --cwd "$(pwd)" --json "Audit for hardcoded secrets" | jq .text

# long prompt on STDIN
cat task.md | opencode-claude-acp --cwd "$(pwd)"
```

## Persistent sessions

By default each call is a one-shot — Claude Code does **not** remember earlier
calls. Pass a stable `--session <name>` to keep context across separate
invocations (it resumes via ACP `session/load`):

```bash
# first call creates + saves the session
opencode-claude-acp --session refactor-auth "Outline a plan to split token logic out of session.js"

# later call (separate process) RESUMES it — Claude remembers the plan
opencode-claude-acp --session refactor-auth "Good. Implement step 1."

opencode-claude-acp --list-sessions          # name, id, cwd, last used, turns
opencode-claude-acp --delete-session refactor-auth
```

Every prompting run prints which session it used to stderr:

```
[acp] session=refactor-auth id=<sessionId> (resumed)
```

With `--json`, that's also in the output object (`sessionName`, `sessionId`,
`resumed`). Sessions are stored at `~/.config/opencode-claude-acp/sessions.json`
(override with `OPENCODE_CLAUDE_ACP_STORE`). The `--cwd` is remembered per
session — `session/load` requires the original cwd, handled automatically.

## Flags

| Flag | Description |
|---|---|
| `prompt` (positional) | Task text. If omitted, read from STDIN. |
| `--cwd <path>` | Working directory for the session. Default: current dir. Remembered per named session. |
| `--session <name>` | Use a persistent named session; resume it if it exists. Omit for an ephemeral one-shot. |
| `--new` | Force a fresh session for `--session <name>`, replacing the old thread. |
| `--list-sessions` | List stored sessions (`--json` for raw JSON). Exits without prompting. |
| `--delete-session <name>` | Forget a stored session. |
| `--yolo` | Auto-approve every tool permission (`allow_always`). Otherwise each is approved once. |
| `--stream` | Echo Claude's thoughts and tool calls to stderr. |
| `--json` | Emit `{ text, stopReason, toolCalls, sessionId, sessionName, resumed }`. |
| `--timeout <seconds>` | Overall timeout. Default: 600. |
| `--agent-cmd <cmd>` | Agent executable to spawn. Default: `claude-agent-acp`. |
| `--selftest` | Handshake-only smoke test (no tokens spent). |
| `-h`, `--help` | Show help. |

## Using it from opencode

Once the skill is installed, the opencode agent can trigger `ask-claude-code` on
its own when it decides to delegate to Claude Code, or you can ask it to. The
skill runs the CLI with `--cwd "$(pwd)"` so edits land in the right project and
reports which session it used.

## Troubleshooting

- **`Could not spawn agent "claude-agent-acp"`** — install it
  (`npm i -g @agentclientprotocol/claude-agent-acp`) or use the bundled copy via
  `install.sh` / `npm i -g opencode-claude-acp`.
- **Auth errors** — run `claude` once interactively to log in.
- **Nothing comes back / it hangs** — add `--stream` to watch progress and raise
  `--timeout`.
- **A resume fails** (stale/expired session id) — the CLI warns on stderr and
  automatically starts a fresh session. Use `--new` or `--delete-session` for a
  clean slate.

## How it works

The CLI speaks ACP (JSON-RPC 2.0 over newline-delimited JSON on the agent's
stdio): `initialize` → `session/new` (or `session/load` to resume) →
`session/prompt`. It handles the agent's reverse requests — permission prompts
and `fs/read_text_file` / `fs/write_text_file` — so Claude Code can actually read
and edit files in the working directory.

## License

MIT © Sammy Lin
