#!/usr/bin/env node
// install-skill.mjs — copy the `ask-claude-code` skill into a skills directory
// (opencode by default) and rewrite its CLI path to the installed location.
//
// Usage: opencode-claude-acp-install [options]
//   --claude            install into ~/.claude/skills instead of opencode
//   --agents            install into ~/.agents/skills
//   --project           install into ./.opencode/skills (current project)
//   --dir <path>        install into a custom skills directory
//   --uninstall         remove the installed skill instead
//   -h, --help          show this help

import { readFile, writeFile, mkdir, copyFile, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const SKILL_NAME = "ask-claude-code";
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_SRC = join(PKG_ROOT, "skill", SKILL_NAME);

const HELP = `Install the ${SKILL_NAME} skill into a skills directory.

Usage: opencode-claude-acp-install [options]
  --claude       install into ~/.claude/skills
  --agents       install into ~/.agents/skills
  --project      install into ./.opencode/skills (current directory)
  --dir <path>   install into a custom skills directory
  --uninstall    remove the installed skill
  -h, --help     show this help

Default target: ~/.config/opencode/skills`;

function parseArgs(argv) {
  const opts = { base: join(homedir(), ".config", "opencode", "skills"), uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--claude") opts.base = join(homedir(), ".claude", "skills");
    else if (a === "--agents") opts.base = join(homedir(), ".agents", "skills");
    else if (a === "--project") opts.base = join(process.cwd(), ".opencode", "skills");
    else if (a === "--dir") opts.base = argv[++i];
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else {
      console.error(`Unknown argument: ${a}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return opts;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function agentOnPath() {
  try {
    execSync("command -v claude-agent-acp", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const dest = join(opts.base, SKILL_NAME);

  if (opts.uninstall) {
    if (await exists(dest)) {
      await rm(dest, { recursive: true, force: true });
      console.log(`Removed ${dest}`);
    } else {
      console.log(`Nothing to remove at ${dest}`);
    }
    return;
  }

  // Copy the CLI and the human-facing README verbatim.
  await mkdir(dest, { recursive: true });
  const cliDest = join(dest, "acp-client.mjs");
  await copyFile(join(PKG_ROOT, "acp-client.mjs"), cliDest);
  await copyFile(join(SKILL_SRC, "README.md"), join(dest, "README.md"));

  // Rewrite the SKILL.md placeholder with the concrete invocation.
  const skillMd = await readFile(join(SKILL_SRC, "SKILL.md"), "utf8");
  const invocation = `node "${cliDest}"`;
  await writeFile(join(dest, "SKILL.md"), skillMd.replaceAll("__ACP_CLI__", invocation));

  console.log(`Installed skill "${SKILL_NAME}" to:\n  ${dest}`);
  console.log(`\nThe skill calls:\n  ${invocation} --cwd "$(pwd)" "<task>"`);

  if (!agentOnPath()) {
    const bundled = join(PKG_ROOT, "node_modules", ".bin", "claude-agent-acp");
    if (await exists(bundled)) {
      console.log(
        `\nNote: claude-agent-acp is not on PATH, but a bundled copy was found and will be used automatically.`,
      );
    } else {
      console.log(
        `\nWarning: the "claude-agent-acp" agent was not found.\n` +
          `  Install it with:  npm i -g @agentclientprotocol/claude-agent-acp\n` +
          `  And make sure Claude is authenticated (run \`claude\` once to log in).`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
