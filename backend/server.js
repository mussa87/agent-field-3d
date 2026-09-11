// agent-field-3d backend
//
// Read-only, local-only service that surfaces real Claude Code subagent
// activity for the agent-field-3d Three.js visualization, by reading:
//   - ~/.claude/projects/**/<sessionId>/subagents/agent-<id>.meta.json
//     -> one per spawned subagent: agentType, task description, spawn depth
//   - ~/.claude/projects/**/<sessionId>/subagents/agent-<id>.jsonl
//     -> that subagent's own transcript, tailed to infer status
//   - ~/.claude/sessions/<pid>.json
//     -> used only to check whether the PARENT session that spawned a given
//        subagent is still alive (a dead parent means an orphaned subagent
//        can't still be "running" no matter what its transcript last shows)
//
// This is a direct port/adaptation of the read-only logic in the reference
// implementation at C:\Users\it4\Source\Repos\AgentViewer\backend\server.js
// (not required or depended on at runtime — this file is fully
// self-contained). Two changes from that reference:
//   1. Results are filtered to agent-field-3d's own agent roster (see
//      AGENT_TYPE_ALLOWLIST below) instead of surfacing every agentType
//      string found on disk.
//   2. A best-effort "source" field is added per agent (see the comment
//      above deriveSource() for exactly what it does and does not tell you).
//
// IMPORTANT — deliberately NOT read/exposed:
//   - ~/.claude/ide/*.lock (contains a live IDE bridge authToken)
//   - the `messagingSocketPath` field found in sessions/*.json
//   - tool_use INPUTS or tool_result CONTENTS from any transcript. Only
//     structural fields are ever read out of a transcript (message type,
//     tool NAME, timestamps) — never argument/result bodies, which can
//     carry real secrets.
// This service never touches those, and never binds beyond 127.0.0.1 — it is
// a personal local tool, not something meant to be reachable over a network.
//
// The on-disk schema this relies on is an undocumented internal format and
// can change between Claude Code versions without notice. All parsing here
// is best-effort/heuristic — see deriveSubagentStatus() and deriveSource().

import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import chokidar from "chokidar";

const PORT = 8420;
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const TAIL_BYTES = 64 * 1024; // enough to see the last few turns of a transcript

// agent-field-3d's real agent roster. Anything spawned with an agentType NOT
// in this list (e.g. "test-echo-agent", "Explore", "Plan", "claude",
// "general-purpose", "claude-code-guide" — all of which have been observed
// as real agentType values on this machine) is deliberately excluded from
// every response this server returns.
const AGENT_TYPE_ALLOWLIST = [
  "auditor",
  "backend-dotnet",
  "chat",
  "frontend-ux-ui",
  "orchestrator",
  "sql",
  "tester",
];
const AGENT_TYPE_ALLOWSET = new Set(AGENT_TYPE_ALLOWLIST);

// ASSUMPTION: when a subagent's parent session file is no longer in
// ~/.claude/sessions (already cleaned up) we can't check liveness directly,
// so we fall back to "no transcript write in this long => treat it as
// ended". 10 minutes is a guess carried over from the reference
// implementation, not a value re-measured for this project.
// This assumption should be validated before relying on "ended" status.
const SUBAGENT_STALE_MS = 10 * 60 * 1000;

// A subagent counts as "recent" (for the per-type summary in /api/agents)
// if its last known activity was within this window, regardless of whether
// it has since been marked completed/ended.
const RECENT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// low-level helpers

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Walks ~/.claude/projects/<project>/<sessionId>/subagents/agent-<id>.meta.json
// looking for every subagent ever spawned (across all projects/sessions).
// Rebuilt on every call since new ones can appear/disappear at any moment.
function findAllSubagents() {
  const found = []; // { metaPath, jsonlPath, sessionId, agentId }
  if (!fs.existsSync(PROJECTS_DIR)) return found;

  for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    let sessionEntries;
    try {
      sessionEntries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of sessionEntries) {
      // session transcripts live one level up as `<sessionId>.jsonl`; only
      // the per-session directories (named after the sessionId) can contain
      // a `subagents/` folder — non-session dirs (e.g. a `memory/` folder)
      // simply won't have one, so no extra filtering is needed here.
      if (!entry.isDirectory()) continue;
      const subagentsDir = path.join(projectPath, entry.name, "subagents");
      if (!fs.existsSync(subagentsDir)) continue;

      for (const file of fs.readdirSync(subagentsDir)) {
        if (!file.endsWith(".meta.json")) continue;
        const agentId = file.slice("agent-".length, -".meta.json".length);
        const jsonlPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
        if (!fs.existsSync(jsonlPath)) continue;
        found.push({
          metaPath: path.join(subagentsDir, file),
          jsonlPath,
          sessionId: entry.name,
          agentId,
        });
      }
    }
  }
  return found;
}

// First parsed JSON line of a file (used for a subagent's startedAt/cwd) —
// small transcripts, so a single small read from byte 0 is enough.
function firstJsonLine(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
    return JSON.parse(firstLine);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Read the last chunk of a (possibly large) JSONL file and return complete,
// parsed JSON lines only (the first, possibly-truncated line is dropped).
function tailJsonLines(filePath, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter(Boolean);
    // drop a possibly-partial first line when we didn't start at byte 0
    const usable = start > 0 ? lines.slice(1) : lines;
    return usable
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Currently-alive PIDs on this machine, via `tasklist` (Windows).
function getAlivePids() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(new Set());
      const pids = new Set();
      for (const line of stdout.split("\n")) {
        const fields = line.split('","').map((f) => f.replace(/"/g, "").trim());
        const pid = Number(fields[1]);
        if (Number.isInteger(pid)) pids.add(pid);
      }
      resolve(pids);
    });
  });
}

// ---------------------------------------------------------------------------
// status derivation (heuristic — see file header)
//
// Only ever looks at: entry `type`, presence/name of a tool_use block, and
// whether a text block is non-empty. Never reads tool_use.input or a text
// block's actual content — see the file-header note on secrets.

function deriveSubagentStatus(parsedLines) {
  const convo = parsedLines.filter((l) => l.type === "user" || l.type === "assistant");

  if (convo.length === 0) {
    return { status: "unknown", lastActivityAt: null, currentTool: null };
  }

  const last = convo[convo.length - 1];
  const lastActivityAt = last.timestamp ?? null;
  const content = Array.isArray(last.message?.content) ? last.message.content : [];

  if (last.type === "assistant") {
    const toolUse = content.find((c) => c.type === "tool_use");
    if (toolUse) {
      return { status: "running_tool", lastActivityAt, currentTool: toolUse.name ?? null };
    }
    const hasText = content.some((c) => c.type === "text" && c.text && c.text.trim());
    if (hasText) {
      // final answer, no follow-up tool call queued — the subagent is done.
      return { status: "completed", lastActivityAt, currentTool: null };
    }
    return { status: "thinking", lastActivityAt, currentTool: null };
  }

  // last.type === "user": either the initial task handoff, or a tool result
  // just came back — either way there's more work queued for the subagent.
  return { status: "thinking", lastActivityAt, currentTool: null };
}

// ---------------------------------------------------------------------------
// "source" proxy — see Step 2 investigation notes below for how this was
// decided.
//
// WHAT WAS INVESTIGATED: real files on this machine were sampled — 161
// subagent agent-*.meta.json files and all 3 existing ~/.claude/sessions/
// <pid>.json files that exist on this machine. The only field in a session
// file that looks like it could describe "where a session came from" is
// `entrypoint`. Across every real session file found, `entrypoint` only ever
// took the values "claude-desktop" or "claude-vscode" (and `kind` was always
// "interactive"). No value resembling "claude.ai", "api", or a literal "cli"
// designation was ever observed.
//
// CONCLUSION: entrypoint does NOT cleanly distinguish the 4 categories the
// user originally wanted (project / claude.ai / Claude Code CLI / API) —
// on the real data available here it only distinguishes which *client
// application* hosted the session (the desktop app vs. the VS Code
// extension), and only 2 such values have ever been observed, from a sample
// of just 3 session files total. This is too small a sample to claim
// anything general about entrypoint's full value space.
//
// PROXY IMPLEMENTED INSTEAD: a `source` object combining two REAL, actually
// observed fields:
//   - `client`: the parent session's raw `entrypoint` value verbatim (e.g.
//     "claude-desktop", "claude-vscode"), or null if the parent session
//     file is gone/unavailable. This tells you which client app the
//     top-level session ran in — nothing about project vs. claude.ai vs.
//     CLI vs. API.
//   - `project`: the last path segment of the subagent's working directory
//     (parent session's `cwd` if available, else the subagent transcript's
//     own first-line `cwd`), e.g. ".claude" or "Operana". This is a real,
//     always-present field and is the most reliable "what was this agent
//     working on" signal available, but it is a folder name, not a
//     source-of-invocation category.
// LIMITATION: neither field, alone or combined, reconstructs the 4-way
// distinction originally asked for. Treat `source` as "which local client
// + which project folder", not as "where the request originated from" in
// any product/channel sense.
function deriveSource(cwd, entrypoint) {
  const project = cwd ? path.basename(cwd) : null;
  return {
    client: entrypoint ?? null,
    project,
  };
}

// ---------------------------------------------------------------------------
// parent-session lookup (used only to check liveness of a subagent's parent)

async function getSessionAliveMap() {
  const alivePids = await getAlivePids();
  const map = new Map(); // sessionId -> { alive, cwd, entrypoint }
  if (!fs.existsSync(SESSIONS_DIR)) return map;

  for (const f of fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"))) {
    const data = readJsonSafe(path.join(SESSIONS_DIR, f));
    if (!data || !data.sessionId) continue;
    map.set(data.sessionId, {
      alive: alivePids.has(data.pid),
      pid: data.pid ?? null,
      cwd: data.cwd ?? null,
      entrypoint: data.entrypoint ?? null,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// aggregation

async function getAgents() {
  const sessionAlive = await getSessionAliveMap();
  const agents = [];

  for (const { metaPath, jsonlPath, sessionId, agentId } of findAllSubagents()) {
    const meta = readJsonSafe(metaPath);
    if (!meta) continue;

    // agent-field-3d only cares about its own real agent roster.
    const agentType = meta.agentType ?? "unknown";
    if (!AGENT_TYPE_ALLOWSET.has(agentType)) continue;

    const firstLine = firstJsonLine(jsonlPath);
    const derived = deriveSubagentStatus(tailJsonLines(jsonlPath));
    const parent = sessionAlive.get(sessionId) ?? null;

    let status = derived.status;
    let currentTool = derived.currentTool;

    if (meta.stoppedByUser) {
      // explicit, structured signal from meta.json — takes priority over
      // whatever the transcript's last line naively implies.
      status = "stopped";
      currentTool = null;
    } else if (status !== "completed") {
      // non-terminal: reconcile against the parent session's liveness, since
      // an orphaned subagent's own transcript can't tell us its parent died.
      if (parent) {
        if (!parent.alive) status = "ended";
      } else {
        // parent's sessions/<pid>.json is already gone (cleaned up) — fall
        // back to a staleness check. See SUBAGENT_STALE_MS note above.
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(jsonlPath).mtimeMs;
        } catch {
          // leave mtimeMs at 0 -> treated as maximally stale -> "ended" below
        }
        if (Date.now() - mtimeMs > SUBAGENT_STALE_MS) status = "ended";
      }
    }

    const cwd = parent?.cwd ?? firstLine?.cwd ?? null;
    const entrypoint = parent?.entrypoint ?? null;

    agents.push({
      agentId,
      agentType,
      description: meta.description ?? null,
      spawnDepth: meta.spawnDepth ?? 1,
      parentAgentId: meta.parentAgentId ?? null,
      sessionId,
      parentPid: parent?.pid ?? null,
      parentAlive: parent?.alive ?? null,
      cwd,
      source: deriveSource(cwd, entrypoint),
      startedAt: firstLine?.timestamp ?? null,
      lastActivityAt: derived.lastActivityAt,
      status,
      currentTool,
    });
  }

  agents.sort((a, b) => new Date(b.lastActivityAt ?? b.startedAt ?? 0) - new Date(a.lastActivityAt ?? a.startedAt ?? 0));
  return agents;
}

// Per-agentType summary for all 7 roster types, always present (even at
// zero) so the 3D scene can render an empty slot for a type with no current
// activity instead of having to special-case "missing from the response".
//   - active: currently thinking or running a tool right now
//   - recent: active, OR last activity within RECENT_MS (a soft "still
//     warm" window — see RECENT_MS above)
//   - total: every matching subagent record found on disk right now,
//     regardless of age (no time bound — mirrors findAllSubagents()'s own
//     unbounded walk)
function summarizeByType(agents) {
  const now = Date.now();
  const byType = new Map(AGENT_TYPE_ALLOWLIST.map((t) => [t, { agentType: t, total: 0, active: 0, recent: 0 }]));

  for (const agent of agents) {
    const bucket = byType.get(agent.agentType);
    if (!bucket) continue; // should be impossible post-filter, kept defensive
    bucket.total += 1;

    const isActive = agent.status === "thinking" || agent.status === "running_tool";
    if (isActive) bucket.active += 1;

    const lastActivity = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : NaN;
    const isRecent = isActive || (!Number.isNaN(lastActivity) && now - lastActivity <= RECENT_MS);
    if (isRecent) bucket.recent += 1;
  }

  return AGENT_TYPE_ALLOWLIST.map((t) => byType.get(t));
}

// ---------------------------------------------------------------------------
// http

const app = express();
app.use(cors());

app.get("/api/agents", async (_req, res) => {
  const agents = await getAgents();
  res.json({
    generatedAt: new Date().toISOString(),
    agentTypes: summarizeByType(agents),
    agents,
  });
});

// live-updating list over SSE: a cheap watch on ~/.claude/sessions gives an
// immediate push when a session starts/ends (a leading indicator that new
// subagents may follow); the 2s poll is what actually picks up new/changed
// subagents day-to-day, since recursively watching all of ~/.claude/projects
// just to catch a file 4 levels deep would be expensive for what it buys.
app.get("/api/stream", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  let closed = false;
  const send = async () => {
    if (closed) return;
    try {
      const agents = await getAgents();
      const payload = {
        generatedAt: new Date().toISOString(),
        agentTypes: summarizeByType(agents),
        agents,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // client likely disconnected mid-write; the close handler will clean up
    }
  };

  await send();
  const interval = setInterval(send, 2000);
  const watcher = fs.existsSync(SESSIONS_DIR)
    ? chokidar.watch(SESSIONS_DIR, { ignoreInitial: true }).on("all", send)
    : null;

  req.on("close", () => {
    closed = true;
    clearInterval(interval);
    watcher?.close();
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`agent-field-3d backend on http://127.0.0.1:${PORT} (loopback only, read-only)`);
});
