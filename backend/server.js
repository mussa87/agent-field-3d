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
//   - ~/.claude/projects/**/<sessionId>.jsonl (the TOP-LEVEL session
//     transcript, never anything inside a `subagents/` folder)
//     -> parsed for each genuine human-typed request (origin.kind==="human")
//        and Claude's final response to it, plus which specialist agent
//        type(s) (via `Agent` tool_use `input.subagent_type`, recursing one
//        level into an orchestrator subagent's own transcript when needed)
//        that request's work touched. See the parseSessionTurns() section
//        below for the exact schema/recursion rules this relies on.
//
// This is a direct port/adaptation of the read-only logic in the reference
// implementation at C:\Users\it4\Source\Repos\AgentViewer\backend\server.js
// (not required or depended on at runtime — this file is fully
// self-contained). Changes from that reference:
//   1. Results are filtered to agent-field-3d's own agent roster (see
//      AGENT_TYPE_ALLOWLIST below) instead of surfacing every agentType
//      string found on disk.
//   2. A best-effort "source" field is added per agent (see the comment
//      above deriveSource() for exactly what it does and does not tell you).
//   3. Per agent-type, a `requests` array of real verbatim user
//      requests + final responses is now included (see parseSessionTurns()
//      below) — this DOES read message text and `Agent` tool_use inputs out
//      of transcripts, which is a deliberate, narrow exception to point 4
//      below: only human request text, Claude's own final response text,
//      and the `subagent_type` field of `Agent` tool_use blocks are ever
//      read this way. No other tool_use input and no tool_result content is
//      ever read or exposed.
//
// IMPORTANT — deliberately NOT read/exposed:
//   - ~/.claude/ide/*.lock (contains a live IDE bridge authToken)
//   - the `messagingSocketPath` field found in sessions/*.json
//   - any tool_use input or tool_result content OTHER than the narrow
//     `Agent` tool_use `subagent_type` exception in point 3 above, and never
//     any tool_result content at all — these can carry real secrets, so the
//     subagent-status logic above only ever reads structural fields
//     (message type, tool NAME, timestamps).
// This service never touches those, and never binds beyond 127.0.0.1 — it is
// a personal local tool, not something meant to be reachable over a network.
// Because request/response TEXT is now surfaced (previously only
// structural fields were), treat this service's output with the same care
// as the transcripts themselves — it is still loopback-only and read-only,
// but no longer text-content-free.
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

// agent-field-3d's own absolute project directory. Used ONLY to scope the
// per-agent-type `requests` panel built by getRequestsByType() (see the
// investigation notes above sessionIsProjectScoped() below) to genuine
// agent-field-3d work. Never used for subagent discovery/status
// (findAllSubagents()/getAgents() above are intentionally left untouched).
const PROJECT_ROOT = path.join(os.homedir(), "Source", "Repos", "agent-field-3d");

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
// top-level session transcript parsing (user requests -> agent-type cards)
//
// Separate concern from the subagent-status logic above, which only ever
// reads files inside a session's `subagents/` folder. This section reads the
// SESSION's own top-level `<sessionId>.jsonl` (never anything inside
// `subagents/`) to recover each genuine human-typed request and Claude's
// final response to it, then maps that request onto every agent-type card
// whose work it touched.
//
// Schema notes (confirmed by sampling real transcripts on this machine):
//   - A genuine human-typed turn is a record with `origin.kind === "human"`.
//     Records with role "user" that are really tool_results do NOT have
//     that field set and are excluded.
//   - The orchestrator routing call is a `tool_use` block named "Agent"
//     whose `input.subagent_type` names the specialist being delegated to.
//   - The "final response" for a human turn is the LAST assistant `text`
//     block appearing before the next human turn (or EOF).
//   - Known wrinkle on this machine: this project's global CLAUDE.md forces
//     every request through an `orchestrator` subagent first, so the
//     top-level transcript's own Agent tool_use calls for a turn will often
//     show ONLY subagent_type "orchestrator" even though real specialist
//     work happened one level down. When that happens, we recurse exactly
//     one level into that orchestrator invocation's OWN subagent transcript
//     (found the same way findAllSubagents() above finds any subagent: via
//     its meta.json) and collect ITS Agent tool_use subagent_types too.
//
// `responseText` is returned FULL LENGTH, untruncated — server-side
// truncation would permanently discard data every future UI could otherwise
// show; index.html truncates to 320 chars for the preview and expands to
// the full text on click instead.
//
// Full top-level transcripts can run into the tens of MB across all
// projects on this machine, and /api/stream re-invokes this every 2s, so
// parsed turns are cached per session file keyed on (mtimeMs, size) and only
// ever re-parsed when the file actually changed since the last read.

const sessionTurnsCache = new Map(); // jsonlPath -> { mtimeMs, size, turns }

// Reads and parses an ENTIRE jsonl file (unlike tailJsonLines above, which
// deliberately only looks at the last chunk) — needed here because a human
// turn boundary can be anywhere in the file, not just near the end.
function readAllJsonLines(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial/corrupt line (e.g. a mid-write truncated tail) - skip it
    }
  }
  return out;
}

// Every top-level `<sessionId>.jsonl` across all projects. Reuses the exact
// same PROJECTS_DIR walk as findAllSubagents() above; the only difference is
// this looks at the FILES directly under each project dir (the session
// transcripts) instead of the `<sessionId>/subagents/` folders.
function findAllSessionTranscripts() {
  const found = []; // { sessionId, jsonlPath }
  if (!fs.existsSync(PROJECTS_DIR)) return found;

  for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    let entries;
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      found.push({
        sessionId: entry.name.slice(0, -".jsonl".length),
        jsonlPath: path.join(projectPath, entry.name),
      });
    }
  }
  return found;
}

// Every `Agent` tool_use block found across a run of parsed transcript
// records (assistant messages only), as {id, subagentType} pairs. Used both
// for the top-level scan and for the one-level-deeper orchestrator scan.
function extractAgentToolUses(records) {
  const out = [];
  for (const rec of records) {
    if (rec?.type !== "assistant") continue;
    const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const block of content) {
      if (block?.type === "tool_use" && block.name === "Agent" && block.input?.subagent_type) {
        out.push({ id: block.id, subagentType: block.input.subagent_type });
      }
    }
  }
  return out;
}

// index of every subagent's toolUseId -> its own jsonlPath, scoped by
// sessionId (a toolUseId is only meaningful within its own session). Built
// from the SAME findAllSubagents() walk used for the /api/agents "process"
// listing above - deliberately not a second, divergent directory walk.
function buildToolUseIndex() {
  const index = new Map(); // `${sessionId}:${toolUseId}` -> jsonlPath
  for (const { metaPath, jsonlPath, sessionId } of findAllSubagents()) {
    const meta = readJsonSafe(metaPath);
    if (!meta?.toolUseId) continue;
    index.set(`${sessionId}:${meta.toolUseId}`, jsonlPath);
  }
  return index;
}

// Verbatim human-typed text out of a `origin.kind === "human"` record.
function extractHumanText(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

// Parses one top-level session transcript into a list of "request turns":
// one per genuine human-typed message, each carrying the verbatim request,
// the verbatim final assistant response, and every agent type (including
// nested-orchestrator specialists) this request should be attributed to.
function parseSessionTurns(sessionId, jsonlPath, toolUseIndex) {
  const records = readAllJsonLines(jsonlPath);
  const humanIdx = [];
  records.forEach((r, i) => {
    if (r?.origin?.kind === "human") humanIdx.push(i);
  });

  const turns = [];
  for (let t = 0; t < humanIdx.length; t++) {
    const start = humanIdx[t];
    const end = t + 1 < humanIdx.length ? humanIdx[t + 1] : records.length;
    const requestText = extractHumanText(records[start]);
    if (!requestText) continue; // nothing genuinely typed (e.g. image-only) - skip

    const span = records.slice(start + 1, end);
    const agentToolUses = extractAgentToolUses(span);
    const typeSet = new Set(agentToolUses.map((a) => a.subagentType));

    // the mandatory-orchestrator-first routing wrinkle: recurse one level
    // when the top level only ever shows "orchestrator" for this turn.
    if (typeSet.size === 1 && typeSet.has("orchestrator")) {
      for (const { id, subagentType } of agentToolUses) {
        if (subagentType !== "orchestrator") continue;
        const nestedPath = toolUseIndex.get(`${sessionId}:${id}`);
        if (!nestedPath) continue;
        try {
          const nestedRecords = readAllJsonLines(nestedPath);
          for (const nested of extractAgentToolUses(nestedRecords)) {
            typeSet.add(nested.subagentType);
          }
        } catch {
          // missing/unreadable nested transcript - skip gracefully rather
          // than assuming any further depth is required (see plan notes)
        }
      }
    }

    // this machine's global CLAUDE.md routes every request through the
    // orchestrator first, so it's always part of the set - even for a turn
    // whose span happened to show no Agent tool_use at all (e.g. a very
    // short/aborted turn).
    typeSet.add("orchestrator");

    let responseText = "";
    let respondedAt = null;
    for (const rec of span) {
      if (rec?.type !== "assistant") continue;
      const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
      const textBlocks = content.filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
      if (textBlocks.length) {
        responseText = textBlocks[textBlocks.length - 1].text.trim();
        respondedAt = rec.timestamp ?? respondedAt;
      }
    }

    turns.push({
      requestId: `${sessionId}:${t}`,
      requestText,
      responseText,
      respondedAt,
      agentTypes: [...typeSet],
    });
  }
  return turns;
}

function getSessionTurnsCached(sessionId, jsonlPath, toolUseIndex) {
  let stat;
  try {
    stat = fs.statSync(jsonlPath);
  } catch {
    return [];
  }
  const cached = sessionTurnsCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.turns;
  }
  const turns = parseSessionTurns(sessionId, jsonlPath, toolUseIndex);
  sessionTurnsCache.set(jsonlPath, { mtimeMs: stat.mtimeMs, size: stat.size, turns });
  return turns;
}

// ---------------------------------------------------------------------------
// project scoping for the request panel (getRequestsByType() below)
//
// INVESTIGATION (done against real files on this machine before writing any
// of this, per the task instructions - not assumed):
//
//   1. Subagent meta.json schema, sampled across all 72 files in this
//      machine's real "home" session for this project
//      (~/.claude/projects/C--Users-it4--claude/a069c5a6-.../subagents/*.meta.json)
//      plus the AgentViewer/Operana projects' own meta.json files: the ONLY
//      fields ever present are agentType, description, toolUseId,
//      parentAgentId, spawnDepth, requestShape, requestNonInteractive.
//      There is NO cwd field, and no other project-identifying field, in
//      meta.json - ever. So filter option "meta.json cwd == project path" is
//      not just unreliable here, it's not available at all.
//   2. The subagent's own transcript first line DOES have a cwd field (read
//      elsewhere in this file via firstJsonLine()), but sampling it directly
//      (e.g. agent-a24d6826d1b690c86.jsonl, description "Build agent-field-3d
//      backend server", and agent-a23921a62bbdf0e5d.jsonl, description
//      "Implement agent-field-3d frontend changes") shows cwd ==
//      "C:\Users\it4\.claude" - the PARENT session's cwd, not the project -
//      for every one of them. This confirms the task's warning: this
//      machine's real top-level session for agent-field-3d was itself
//      started with cwd = ~/.claude (there is, in fact, no
//      "...Source-Repos-agent-field-3d" folder under
//      ~/.claude/projects at all), so that session's own subagents inherit
//      that same wrong cwd. For comparison, a subagent spawned from the
//      (correctly-homed) Operana project DOES show its real cwd
//      ("c:\Users\it4\Source\Repos\Operana") - so this signal is clean for
//      other projects, just not for this one's real working session.
//   3. Per-turn request TEXT was sampled directly against this project's
//      real 29-human-turn session: only 12 of 29 turns (41%) mention
//      "agent-field-3d"/"index.html"/"server.js" anywhere in the human
//      request OR Claude's own final response. Turns that are unmistakably
//      real project requests - e.g. "recolor the robot..", "i dont like the
//      circle behind each stationed unit..", "fix tester agent to stop
//      moving if there is no active task.." - do NOT mention the project by
//      name. Filtering per-turn on request/response text would silently
//      drop most of the genuine history the user explicitly wants kept.
//
// DECISION: no clean structural per-request signal exists on this machine
// today. What IS reliable is scoping at the SESSION level instead of the
// per-request level:
//   (a) STRUCTURAL, preferred when available: if a session's own
//       PROJECTS_DIR folder decodes to this exact project path, it is
//       unambiguously this project (this is how Operana/AgentViewer/etc.
//       already work correctly). This never matches today for the reasons
//       above, but is kept as the first check so a FUTURE session actually
//       started from inside the project directory needs no heuristic at all.
//   (b) HEURISTIC fallback (see risk note below): if the project's own
//       absolute path appears ANYWHERE in a session's already-parsed human
//       request text or Claude's final-response text (the exact same fields
//       parseSessionTurns() already extracts and exposes - nothing new is
//       read off disk for this), the WHOLE session is treated as this
//       project's and EVERY one of its turns is kept, not just the matching
//       one(s). This sidesteps the per-turn false-negative problem in (3)
//       above, because on real data this project's entire real working
//       session mentions its own absolute path repeatedly (71 times, in
//       human/assistant text alone) somewhere across its lifetime, even
//       though any single turn usually doesn't.
//
// VERIFIED RESULT of applying (b) to real data on this machine: it correctly
// keeps the one true session (sessionId a069c5a6-b763-43fd-b31c-7e1518da668d,
// homed under the misleadingly-named "C--Users-it4--claude" folder) and
// correctly excludes: every one of the 11 OTHER sessions sharing that same
// folder (SQL/database questions, MCP config questions, an unrelated
// "is the sql agent available?" conversation, etc. - none of them mention
// this project's path at all), everything under the Operana/SecuriteTeam-ERP/
// A-ERP project folders, AND - importantly - two AgentViewer sessions that
// mention the bare token "agent-field-3d" in passing (e.g. a pasted
// "...\Desktop\agent-field-3d-bundle" path, or "implement above html into
// our project") but never this project's actual full absolute path; matching
// on the bare token alone was tried first and rejected specifically because
// it would have wrongly pulled those two AgentViewer conversations (cards
// around an AI "brain", Playwright, artifacts - genuinely unrelated) back in,
// reproducing the exact kind of cross-project bleed this change exists to
// fix. Matching on the full path instead of the bare token is what avoids
// that false positive.
//
// KNOWN RESIDUAL RISK (this is a heuristic, not a guarantee):
//   - false positive: a session that mentions this project's absolute path
//     only in passing, as an aside about a DIFFERENT project's work, would
//     be pulled in wholesale.
//   - false negative: a genuine agent-field-3d session that never once has
//     its absolute path typed or pasted into human/assistant text anywhere
//     in the whole session would be wrongly excluded in full.
// Neither case was observed in the real data sampled for this change, but
// both remain possible on data not sampled here.
function normalizeForCompare(s) {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
const PROJECT_ROOT_NORMALIZED = normalizeForCompare(PROJECT_ROOT);

// Case-insensitive match on the project's full absolute path, tolerant of
// \ vs / and of repeated separators (JSON round-tripping / copy-pasted paths
// sometimes double them up).
const PROJECT_PATH_MARKER = new RegExp(
  PROJECT_ROOT.split(/[\\/]/)
    .filter(Boolean)
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]+"),
  "i"
);

// See the investigation/decision notes directly above. `turns` is this
// session's ALREADY-parsed turns (from getSessionTurnsCached()) - reused
// as-is, nothing extra is read off disk to make this decision.
function sessionIsProjectScoped(jsonlPath, turns) {
  const projectDirName = path.basename(path.dirname(jsonlPath));
  if (normalizeForCompare(projectDirName) === PROJECT_ROOT_NORMALIZED) return true; // (a)

  return turns.some(
    (t) => PROJECT_PATH_MARKER.test(t.requestText) || PROJECT_PATH_MARKER.test(t.responseText)
  ); // (b)
}

// Every request turn across every project/session, grouped by agent type -
// only for types in AGENT_TYPE_ALLOWLIST, since the UI has no card for
// anything else, AND only for sessions that pass sessionIsProjectScoped()
// above (agent-field-3d's own request panel should only ever show
// agent-field-3d's own history - see the scoping notes above). Each request
// is deliberately duplicated verbatim across every type it should appear
// under (confirmed product decision - see plan: e.g. a request the
// orchestrator routed to both `sql` and `backend-dotnet` shows up on the
// "sql" card, the "backend-dotnet" card, AND the "orchestrator" card).
function getRequestsByType() {
  const byType = new Map(AGENT_TYPE_ALLOWLIST.map((t) => [t, []]));
  const toolUseIndex = buildToolUseIndex();

  for (const { sessionId, jsonlPath } of findAllSessionTranscripts()) {
    let turns;
    try {
      turns = getSessionTurnsCached(sessionId, jsonlPath, toolUseIndex);
    } catch {
      continue;
    }
    if (!sessionIsProjectScoped(jsonlPath, turns)) continue;
    for (const turn of turns) {
      const request = {
        requestId: turn.requestId,
        requestText: turn.requestText,
        responseText: turn.responseText,
        respondedAt: turn.respondedAt,
      };
      for (const type of turn.agentTypes) {
        const bucket = byType.get(type);
        if (bucket) bucket.push(request);
      }
    }
  }

  for (const bucket of byType.values()) {
    bucket.sort((a, b) => new Date(b.respondedAt ?? 0) - new Date(a.respondedAt ?? 0));
  }
  return byType;
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
// `requestsByType` (from getRequestsByType()) is an additive param: every
// existing field here is untouched, callers that don't pass it just get an
// empty `requests` array per type instead of a broken response.
//
// DELIBERATE DECISION (agent-field-3d project-scoping task): total/active/
// recent stay MACHINE-WIDE subagent-invocation counts, exactly as before -
// they are NOT scoped to this project like `requests` now is. Reasons:
//   1. The user's confirmed problem and decision were specifically about the
//      request panel's `requests` content (unrelated conversations' text
//      showing up in it), not about the ring buildings' Active/Recent/Total
//      counts - nothing in this task flagged those counts as wrong.
//   2. There is no reliable way to scope them the same way even if desired:
//      meta.json has no project-identifying field at all (see the
//      investigation notes above sessionIsProjectScoped()), so the only
//      available join back to a project would be "does this subagent's
//      sessionId belong to a sessionIsProjectScoped() session" - which
//      would silently change what these numbers mean (from "every
//      agent-field-3d-type subagent running anywhere on this machine" to
//      "...within one heuristically-selected session") without being asked
//      to. If project-scoped KPI counts are wanted later, this is the
//      seam to extend - join `agents[].sessionId` against the same
//      sessionIsProjectScoped() check used for requests below.
function summarizeByType(agents, requestsByType) {
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

  return AGENT_TYPE_ALLOWLIST.map((t) => ({
    ...byType.get(t),
    requests: requestsByType?.get(t) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// http

const app = express();
app.use(cors());

app.get("/api/agents", async (_req, res) => {
  const agents = await getAgents();
  const requestsByType = getRequestsByType();
  res.json({
    generatedAt: new Date().toISOString(),
    agentTypes: summarizeByType(agents, requestsByType),
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
      const requestsByType = getRequestsByType();
      const payload = {
        generatedAt: new Date().toISOString(),
        agentTypes: summarizeByType(agents, requestsByType),
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
