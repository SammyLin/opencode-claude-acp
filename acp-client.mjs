#!/usr/bin/env node
// acp-client.mjs — a zero-dependency ACP (Agent Client Protocol) client.
//
// Spawns the `claude-agent-acp` agent as a child process and drives it over
// stdio using newline-delimited JSON-RPC 2.0. Sends initialize → session/new →
// session/prompt, handles the agent's reverse requests (permissions, fs reads
// and writes) and notifications (message/thought chunks, tool calls), then
// prints the assembled agent message to stdout.
//
// Usage: node acp-client.mjs [options] [prompt]
//   prompt                  task text; if absent, read full prompt from STDIN
//   --cwd <path>            working directory for the session (default: cwd)
//   --agent-cmd <cmd>       agent executable to spawn (default: claude-agent-acp)
//   --yolo                  auto-pick "allow_always" permission options
//   --stream                echo progress (thoughts, tool calls, chunks) to STDERR
//   --json                  print JSON result to stdout
//   --timeout <seconds>     overall timeout (default: 600)
//   --selftest              handshake-only smoke test (initialize + session/new)
//   --session <name>        use a persistent named session (resume if it exists)
//   --new                   force a fresh session even if --session <name> exists
//   --list-sessions         print the stored sessions and exit
//   --delete-session <name> remove a stored session and exit
//   -h, --help              show usage

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PROTOCOL_VERSION = 1;

// Resolve the agent executable. If the caller kept the default and it is not on
// PATH, fall back to a copy bundled in this package's node_modules (the case
// when installed locally via install.sh rather than `npm i -g`).
function resolveAgentCmd(cmd) {
  if (cmd !== "claude-agent-acp") return cmd;
  const bundled = join(
    dirname(fileURLToPath(import.meta.url)),
    "node_modules",
    ".bin",
    "claude-agent-acp",
  );
  return existsSync(bundled) ? bundled : cmd;
}

// Persistent named-session store. Tool-owned location, independent of where
// the skill is installed; override with OPENCODE_CLAUDE_ACP_STORE.
const STORE_PATH =
  process.env.OPENCODE_CLAUDE_ACP_STORE ||
  join(homedir(), ".config", "opencode-claude-acp", "sessions.json");

// Read the session store, tolerating a missing or corrupt file (→ empty).
async function readStore() {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Write the session store atomically (temp file + rename).
async function writeStore(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await rename(tmp, STORE_PATH);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    cwd: process.cwd(),
    agentCmd: "claude-agent-acp",
    yolo: false,
    stream: false,
    json: false,
    timeout: 600,
    selftest: false,
    help: false,
    prompt: undefined,
    session: undefined,
    forceNew: false,
    listSessions: false,
    deleteSession: undefined,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--cwd":
        opts.cwd = argv[++i];
        break;
      case "--agent-cmd":
        opts.agentCmd = argv[++i];
        break;
      case "--yolo":
        opts.yolo = true;
        break;
      case "--stream":
        opts.stream = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--timeout":
        opts.timeout = Number(argv[++i]);
        break;
      case "--selftest":
        opts.selftest = true;
        break;
      case "--session":
        opts.session = argv[++i];
        break;
      case "--new":
        opts.forceNew = true;
        break;
      case "--list-sessions":
        opts.listSessions = true;
        break;
      case "--delete-session":
        opts.deleteSession = argv[++i];
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    opts.prompt = positionals.join(" ");
  }
  return opts;
}

const USAGE = `Usage: node acp-client.mjs [options] [prompt]

Drives the claude-agent-acp agent over stdio via the Agent Client Protocol.

Arguments:
  prompt              Task text. If absent, the full prompt is read from STDIN.

Options:
  --cwd <path>        Working directory for the ACP session (default: cwd).
  --agent-cmd <cmd>   Agent executable to spawn (default: claude-agent-acp).
  --yolo              Auto-pick "allow_always" permission options.
  --stream            Echo progress (thoughts, tool calls, chunks) to STDERR.
  --json              Print final JSON result to stdout.
  --timeout <seconds> Overall timeout in seconds (default: 600).
  --selftest          Handshake-only smoke test (initialize + session/new).
  --session <name>    Use a persistent named session; resume it if it exists.
  --new               Force a fresh session even if --session <name> exists.
  --list-sessions     Print the stored sessions and exit (--json for raw JSON).
  --delete-session <name>
                      Remove the named session from the store and exit.
  -h, --help          Show this help.

Persistent sessions are stored in:
  ~/.config/opencode-claude-acp/sessions.json
  (override with the OPENCODE_CLAUDE_ACP_STORE env var)

Exit status: 0 on a normal stop (end_turn), non-zero on error or timeout.`;

// ---------------------------------------------------------------------------
// ACP client — wraps the child process and the JSON-RPC plumbing
// ---------------------------------------------------------------------------

class AcpClient {
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.stdoutBuf = "";
    this.sessionId = null;

    // Assembled output and progress accounting.
    this.assembledText = "";
    this.toolCalls = 0;
  }

  log(...args) {
    if (this.opts.stream) process.stderr.write(args.join(" ") + "\n");
  }

  // Spawn the agent. Rejects with a friendly message if the binary is missing.
  spawnAgent() {
    return new Promise((resolve, reject) => {
      const child = spawn(resolveAgentCmd(this.opts.agentCmd), [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      child.on("error", (err) => {
        if (err.code === "ENOENT") {
          reject(
            new Error(
              `Could not spawn agent "${this.opts.agentCmd}". Is it installed and on PATH?\n` +
                `Install it with: npm i -g @agentclientprotocol/claude-agent-acp`,
            ),
          );
        } else {
          reject(err);
        }
      });

      // Pipe the agent's stderr through to ours for debugging.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));

      // Parse incoming NDJSON from the agent's stdout.
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.onStdoutChunk(chunk));

      this.child = child;
      // spawn() is synchronous enough that if no error fired immediately the
      // process is up; resolve on next tick after wiring listeners.
      process.nextTick(resolve);
    });
  }

  // Buffer stdout and dispatch each complete newline-delimited JSON message.
  onStdoutChunk(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.log(`[warn] failed to parse line: ${line}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  // Route a single JSON-RPC message.
  dispatch(msg) {
    // Response to one of our requests: has id and (result|error), no method.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        this.log(`[warn] response for unknown id ${msg.id}`);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(
          Object.assign(new Error(msg.error.message || "RPC error"), {
            rpcError: msg.error,
          }),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Request FROM the agent: has id and method → we must respond.
    if (msg.id !== undefined && msg.method !== undefined) {
      this.handleAgentRequest(msg);
      return;
    }

    // Notification: method but no id.
    if (msg.method !== undefined) {
      this.handleNotification(msg);
      return;
    }

    this.log(`[warn] unrecognized message: ${JSON.stringify(msg)}`);
  }

  // Send a JSON-RPC request and return a promise for its result.
  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(payload);
    });
  }

  // Send a response to an agent-originated request.
  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  // -------------------------------------------------------------------------
  // Incoming notifications (session/update)
  // -------------------------------------------------------------------------

  handleNotification(msg) {
    if (msg.method !== "session/update") {
      this.log(`[notify] ${msg.method}`);
      return;
    }
    const update = msg.params?.update;
    if (!update) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") {
          this.assembledText += update.content.text;
        }
        break;
      case "agent_thought_chunk":
        if (update.content?.type === "text") {
          this.log(`[thought] ${update.content.text}`);
        }
        break;
      case "tool_call":
        this.toolCalls++;
        this.log(
          `[tool_call] ${update.title ?? ""} (kind=${update.kind ?? "?"}, status=${update.status ?? "?"})`,
        );
        break;
      case "tool_call_update":
        this.log(
          `[tool_call_update] ${update.title ?? ""} (status=${update.status ?? "?"})`,
        );
        break;
      case "plan":
        this.log(`[plan] ${JSON.stringify(update.entries ?? update)}`);
        break;
      default:
        this.log(`[update] ${update.sessionUpdate}`);
    }
  }

  // -------------------------------------------------------------------------
  // Incoming requests from the agent
  // -------------------------------------------------------------------------

  async handleAgentRequest(msg) {
    try {
      switch (msg.method) {
        case "session/request_permission":
          return this.respond(msg.id, this.choosePermission(msg.params));
        case "fs/read_text_file":
          return this.respond(msg.id, await this.fsRead(msg.params));
        case "fs/write_text_file":
          return this.respond(msg.id, await this.fsWrite(msg.params));
        default:
          this.log(`[warn] unhandled agent request: ${msg.method}`);
          // -32601 = method not found.
          return this.respondError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      // -32603 = internal error.
      this.respondError(msg.id, -32603, err.message || String(err));
    }
  }

  // Pick a permission option per the selection policy.
  choosePermission(params) {
    const options = params?.options ?? [];
    const wantKind = this.opts.yolo ? "allow_always" : "allow_once";

    let chosen =
      options.find((o) => o.kind === wantKind) ??
      options.find((o) => typeof o.kind === "string" && o.kind.startsWith("allow"));

    if (chosen) {
      this.log(`[permission] selected "${chosen.name ?? chosen.optionId}" (${chosen.kind})`);
      return { outcome: { outcome: "selected", optionId: chosen.optionId } };
    }
    this.log("[permission] no allow option found → cancelled");
    return { outcome: { outcome: "cancelled" } };
  }

  async fsRead(params) {
    const { path, line, limit } = params;
    const content = await readFile(path, "utf8");
    if (line === undefined && limit === undefined) {
      return { content };
    }
    const lines = content.split("\n");
    const start = line ? line - 1 : 0; // line is 1-based
    const end = limit ? start + limit : lines.length;
    return { content: lines.slice(start, end).join("\n") };
  }

  async fsWrite(params) {
    const { path, content } = params;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return {}; // null/empty result is fine
  }

  // -------------------------------------------------------------------------
  // Handshake helpers
  // -------------------------------------------------------------------------

  async initialize() {
    return this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
  }

  async newSession(cwd = this.opts.cwd) {
    const result = await this.request("session/new", {
      cwd,
      mcpServers: [],
    });
    this.sessionId = result.sessionId;
    return result;
  }

  // Resume an existing session. The cwd MUST match the one the session was
  // created with, or the load fails. Replayed session/update notifications
  // flow in normally and are harmless (handled by handleNotification).
  async loadSession(sessionId, cwd) {
    await this.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
    this.sessionId = sessionId;
    return { sessionId };
  }

  async prompt(text) {
    return this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  // Gracefully shut down the child.
  shutdown() {
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin.end();
      } catch {}
      this.child.kill("SIGTERM");
    }
  }
}

// ---------------------------------------------------------------------------
// STDIN reader (used when no positional prompt is given)
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(err.message + "\n\n" + USAGE + "\n");
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }

  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
    process.stderr.write("--timeout must be a positive number of seconds\n");
    process.exit(2);
  }

  // --list-sessions: print the store and exit, no agent needed.
  if (opts.listSessions) {
    const store = await readStore();
    if (opts.json) {
      process.stdout.write(JSON.stringify(store, null, 2) + "\n");
    } else {
      const names = Object.keys(store);
      if (names.length === 0) {
        process.stdout.write("(no stored sessions)\n");
      } else {
        const rows = names.map((name) => {
          const e = store[name] ?? {};
          const id = e.sessionId ? String(e.sessionId) : "";
          const shortId = id.length > 20 ? id.slice(0, 17) + "..." : id;
          return {
            name,
            id: shortId,
            cwd: e.cwd ?? "",
            lastUsedAt: e.lastUsedAt ?? "",
            turns: String(e.turns ?? 0),
          };
        });
        const cols = ["name", "id", "cwd", "lastUsedAt", "turns"];
        const headers = { name: "NAME", id: "SESSION", cwd: "CWD", lastUsedAt: "LAST USED", turns: "TURNS" };
        const width = {};
        for (const c of cols) {
          width[c] = headers[c].length;
          for (const r of rows) width[c] = Math.max(width[c], r[c].length);
        }
        const fmt = (r) => cols.map((c) => r[c].padEnd(width[c])).join("  ");
        process.stdout.write(fmt(headers) + "\n");
        for (const r of rows) process.stdout.write(fmt(r) + "\n");
      }
    }
    process.exit(0);
  }

  // --delete-session: remove the entry from the store and exit.
  if (opts.deleteSession !== undefined) {
    const store = await readStore();
    if (Object.prototype.hasOwnProperty.call(store, opts.deleteSession)) {
      delete store[opts.deleteSession];
      await writeStore(store);
      process.stderr.write(`[acp] deleted session "${opts.deleteSession}"\n`);
    } else {
      process.stderr.write(`[acp] no stored session named "${opts.deleteSession}"\n`);
    }
    process.exit(0);
  }

  const client = new AcpClient(opts);

  // Overall timeout: rejects the whole run.
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timed out after ${opts.timeout}s`));
    }, opts.timeout * 1000);
  });

  const run = async () => {
    await client.spawnAgent();

    const initResult = await client.initialize();
    client.log(`[init] agent capabilities: ${JSON.stringify(initResult.agentCapabilities ?? {})}`);
    const authMethods = initResult.authMethods ?? [];
    if (authMethods.length > 0) {
      client.log(`[init] auth methods offered: ${JSON.stringify(authMethods)}`);
    }

    const caps = initResult.agentCapabilities ?? {};
    const canLoad = caps.loadSession === true;

    // Resolve the session: persistent named (resume/new) or ephemeral.
    let sessionName = null; // null → ephemeral
    let resumed = false;
    let sessionCwd = opts.cwd;
    let store = null;
    let storeEntry = null;

    if (opts.session !== undefined) {
      sessionName = opts.session;
      store = await readStore();
      storeEntry = store[sessionName];

      const wantResume = storeEntry && storeEntry.sessionId && !opts.forceNew;
      if (wantResume) {
        sessionCwd = storeEntry.cwd ?? opts.cwd;
        if (!canLoad) {
          client.log(
            `[warn] agent does not support session/load (loadSession!=true); starting a new session`,
          );
          const r = await client.newSession(sessionCwd);
          storeEntry = { ...storeEntry, sessionId: r.sessionId };
        } else {
          try {
            await client.loadSession(storeEntry.sessionId, sessionCwd);
            resumed = true;
          } catch (err) {
            process.stderr.write(
              `[acp] session/load failed for "${sessionName}" (${err.message}); starting a new session\n`,
            );
            const r = await client.newSession(sessionCwd);
            storeEntry = { ...storeEntry, sessionId: r.sessionId };
          }
        }
      } else {
        // No stored entry, or --new forces a fresh session. Overwrite.
        const r = await client.newSession(sessionCwd);
        storeEntry = {
          sessionId: r.sessionId,
          cwd: sessionCwd,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          turns: 0,
        };
      }
      store[sessionName] = storeEntry;
    } else {
      // Ephemeral: new session, never persisted.
      await client.newSession(sessionCwd);
    }

    client.log(`[session] sessionId=${client.sessionId}`);

    // Selftest: prove framing + spawn without spending tokens on a prompt.
    if (opts.selftest) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            sessionId: client.sessionId,
            agentCapabilities: caps,
            authMethods,
          },
          null,
          2,
        ) + "\n",
      );
      return { selftest: true };
    }

    // Resolve the prompt: positional arg, else STDIN.
    let promptText = opts.prompt;
    if (promptText === undefined) {
      promptText = (await readStdin()).trim();
    }
    if (!promptText) {
      throw new Error("No prompt provided (give a positional arg or pipe via STDIN).");
    }

    // After a resume the agent replays prior history as session/update
    // notifications; discard anything assembled so far so the output only
    // reflects the upcoming prompt's response.
    if (resumed) {
      client.assembledText = "";
      client.toolCalls = 0;
    }

    // Surface which session is in use on every prompting run.
    process.stderr.write(
      `[acp] session=${sessionName ?? "ephemeral"} id=${client.sessionId} (${resumed ? "resumed" : "new"})\n`,
    );

    const promptResult = await client.prompt(promptText);

    // Persist the named session: bump lastUsedAt and turn count.
    if (sessionName !== null) {
      storeEntry.lastUsedAt = new Date().toISOString();
      storeEntry.turns = (storeEntry.turns ?? 0) + 1;
      store[sessionName] = storeEntry;
      await writeStore(store);
    }

    return {
      stopReason: promptResult?.stopReason,
      sessionId: client.sessionId,
      sessionName,
      resumed,
    };
  };

  let exitCode = 0;
  try {
    const result = await Promise.race([run(), timeoutPromise]);
    clearTimeout(timeoutHandle);

    if (result.selftest) {
      // Already printed.
    } else {
      const stopReason = result.stopReason;
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            text: client.assembledText,
            stopReason: stopReason ?? null,
            toolCalls: client.toolCalls,
            sessionId: result.sessionId ?? client.sessionId,
            sessionName: result.sessionName ?? null,
            resumed: result.resumed ?? false,
          }) + "\n",
        );
      } else {
        process.stdout.write(client.assembledText);
        if (!client.assembledText.endsWith("\n")) process.stdout.write("\n");
      }
      // Non-end_turn stops (cancelled, refusal, max_tokens, etc.) are errors.
      if (stopReason !== "end_turn") {
        process.stderr.write(`Agent stopped with reason: ${stopReason}\n`);
        exitCode = 1;
      }
    }
  } catch (err) {
    clearTimeout(timeoutHandle);
    process.stderr.write(`Error: ${err.message}\n`);
    if (err.rpcError) {
      process.stderr.write(`RPC error detail: ${JSON.stringify(err.rpcError)}\n`);
    }
    exitCode = 1;
  } finally {
    client.shutdown();
  }

  // Give stdout a tick to flush, then exit.
  process.exitCode = exitCode;
}

main();
