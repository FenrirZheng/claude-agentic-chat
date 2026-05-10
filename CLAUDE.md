# CLAUDE.md

Project memory for `claude-chat` — a Node / TypeScript CLI that wraps the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) into a four-mode shell tool (one-shot / REPL / daemon / connect). Sister project to [`gemini-acp`](../gemini-acp/CLAUDE.md), which uses the same shape over Google's Gemini via the Agent Client Protocol; many design decisions and `Don't` items here cross-reference that project.

## Repo shape

- Standalone project at `/home/fenrir/Documents/claude-agentic-chat/`, **its own git repo on branch `main`** with remote `origin` at `git@github.com:FenrirZheng/claude-agentic-chat.git`. The parent `$HOME` dotfiles repo's [root `.gitignore`](../../.gitignore) excludes `Documents/`, so this working tree is invisible to that repo. See [Git](#git) below for the conventions.
- The parent `$HOME` is a separate dotfiles repo (remote `bash-for-fenrir`); the two are unrelated despite the directory nesting — don't confuse `cd` paths between them when switching tmux panes.
- Tracked-once-init'd: [package.json](package.json), [tsconfig.json](tsconfig.json), [src/index.ts](src/index.ts), this file. Gitignored: `node_modules/`, `dist/`, `*.log`, `.env*` — see [.gitignore](.gitignore).

## Build & run

```bash
npm install
node src/index.ts --help          # dev (Node 23.6+ runs TypeScript natively)
npm run build && ./dist/index.js  # built JS for distribution
```

Runtime requirement: a working `claude` binary on `PATH` (currently at `~/.local/bin/claude`). The Claude Agent SDK auto-detects it, then spawns `claude --print --output-format stream-json` per `query()` call and parses the JSON message stream — no API-key plumbing needed at this layer; `claude` handles auth itself.

## The four modes

One-shot, REPL, daemon, connect — same shape as [gemini-acp's CLAUDE.md §"The four modes"](../gemini-acp/CLAUDE.md#the-four-modes), with these differences:

- All modes share `promptAndCollect` in [src/index.ts](src/index.ts), which builds SDK options via `buildSdkOptions` (chat-only or tool-enabled branch) and accumulates either `assistant` text blocks (non-streaming) or `stream_event` text deltas (streaming) until the `result` message arrives.
- **Default is chat-only**: `tools: []` (NOT `allowedTools: []`) — the former skips loading tools entirely; the latter only whitelists from a loaded set. See [`Don't`](#dont) below.
- **`--allow-tools` opens up the full Claude Code tool set** — see [Tool access](#tool-access) for permission modes and the cwd allowlist boundary.
- **Token streaming is on by default** for one-shot and REPL when `--json` is NOT set. The SDK's `includePartialMessages: true` opens a `stream_event` channel carrying Anthropic-SDK `content_block_delta` events; their `text_delta.text` payloads flush to stdout as they arrive. `--json` forces collected output (one JSON line, incompatible with mid-line streaming). Daemon never streams (would need a multi-line wire protocol — see [Future work](#future-work)).
- **Daemon session continuity** is per-turn `query({resume: lastSessionId})`, where `lastSessionId` is captured from the SDK's `session_id` field (present on `system` / `assistant` / `result` messages alike). No long-lived `claude` subprocess — each turn re-spawns. Cheap because the SDK doesn't pay ACP's npx package-resolution tax.
- **Daemon ↔ connect wire protocol** has two modes over `/tmp/claude-chat-$USER.sock`:
  - **Single-frame** (default for shutdown, `--json` prompts): one `\n`-terminated JSON line per direction. Request shapes: `{prompt} | {shutdown:true}`. Response shapes: `{reply, stop_reason, session_id} | {ok:true} | {error}`.
  - **NDJSON stream** (default for non-`--json` prompts): client adds `stream:true` to its request. Daemon emits zero or more `{chunk:"..."}` frames followed by exactly one `{reply, stop_reason, session_id, done:true}` terminator, all `\n`-separated. Errors mid-stream arrive as `{error}` and terminate the stream. Client `--connect` reads frame-by-frame via `readline` and prints `chunk` payloads to stdout as they arrive. See [gemini-acp's TECHNICAL.md §4](../gemini-acp/TECHNICAL.md#4-mode-by-mode-reference) for the reference single-frame protocol; the streaming variant is novel here and unique to claude-chat.

## Tool access

By default `claude-chat` is chat-only (no Read / Write / Bash / MCP). `--allow-tools` flips this on by switching the SDK call to:

- `tools: { type: "preset", preset: "claude_code" }` — full Claude Code tool set
- `systemPrompt: { type: "preset", preset: "claude_code" }` — Claude Code's system prompt teaches the agent how to invoke them
- `settingSources: ["user", "project"]` — `~/.claude/CLAUDE.md` and the project's `CLAUDE.md` get loaded as context (mirrors a real `claude` invocation in the cwd)
- `permissionMode` defaults to `bypassPermissions` — every tool call (including `Bash`) auto-approved, and `allowDangerouslySkipPermissions: true` is set automatically per SDK requirement. Chosen so routine `claude-chat --allow-tools "..."` invocations don't need a flag; the cwd directory allowlist still contains filesystem blast radius. Override with `--permission-mode <mode>`. Valid modes: `default` (every tool gated), `acceptEdits` (edits auto, Bash gated), `bypassPermissions` (default), `plan` (read-only — no Edit/Write/Bash). Tighten when calibration calls for it — see [Don't](#dont) for when bypass is the wrong default.

**The agent operates in `process.cwd()`** — the SDK enforces a directory allowlist at the boundary between Claude Code's tool implementations and the filesystem. Reading `/tmp/foo` from a `claude-chat` started in `~/Documents/claude-agentic-chat/` will fail with a polite block message; the agent reports it instead of pretending. Honest by construction. To loosen, either `cd` to the parent before launching, or pass `additionalDirectories` (not yet exposed as a flag — would be a `--cwd-allow <path>` addition).

`--permission-mode` is silently ignored in `--connect` mode: the daemon's tool config is fixed at startup. To change it, `--shutdown` and restart with new flags.

See `buildSdkOptions` in [src/index.ts](src/index.ts) for the exact branch.

## Daemon discipline

- Default socket: `/tmp/claude-chat-$USER.sock`. Override with `--socket PATH`.
- Stale-socket detection: on bind, daemon `existsSync()`s the path, then probes with `createConnection` (`probeSocket` in [src/index.ts](src/index.ts)). Connect-success ⇒ refuse to start (another daemon owns it). Connect-fail ⇒ stale, `unlinkSync`, then bind.
- **`allowHalfOpen: true` on `createServer` is mandatory** — see [Editing src/index.ts](#editing-srcindexts) trap 1 for why.
- Proper stop: `claude-chat --connect --shutdown`. `SIGINT` / `SIGTERM` also clean up the socket file.
- One in-flight `query()` at a time: a `Promise` chain (`queue = queue.then(...)` in `runDaemon`) serializes concurrent connections. Concurrent prompts on one session would interleave conversation state — same honest-serial design as gemini-acp's single-threaded `tokio::select!`. Note: a long streaming response holds the queue until its `done:true` terminator goes out, so a second `--connect` waits behind it. By design — interleaving streams across one session would be incoherent.
- **Session persistence across daemon restarts is wired.** After every successful turn the daemon writes the current `sessionId` to `${XDG_STATE_HOME:-~/.local/state}/claude-chat/last-session`. On the next `--daemon` startup, that id is auto-loaded (banner: `claude-chat: resuming session <id>`) and used as the implicit `resume:` for the first turn. `--resume <id>` overrides; `--fresh` suppresses load and starts a new conversation. To wipe state manually: `rm ~/.local/state/claude-chat/last-session`. One-shot and REPL modes intentionally don't read or write this file — see `getStatePath` / `loadLastSession` / `saveLastSession` in [src/index.ts](src/index.ts).

## Editing src/index.ts

Three specific traps before changing protocol-handling code:

1. **`allowHalfOpen: true` is mandatory on `createServer`.** Node defaults to `allowHalfOpen: false`, which means: when the client half-closes the connection (sends FIN via `conn.end()`), Node automatically ends the daemon's writable side too — discarding any queued response data. Our wire protocol is "client writes request + half-closes, daemon reads-then-writes response + closes" — this requires the daemon's writable side to stay open after seeing the client's FIN. The bug looks like `error: bad daemon response: Unexpected end of JSON input` on every connect call; the fix is one keyword in the `createServer(...)` call. See the inline comment in `runDaemon` in [src/index.ts](src/index.ts).

2. **Forward-compat in the `SDKMessage` switch.** `SDKMessage` is a union of `system | user | assistant | result | stream_event | compact_boundary`, and the SDK adds variants between minor versions. The `for await` loop in `promptAndCollect` handles `assistant`, `result`, and (when streaming) `stream_event` explicitly, and falls through silently on everything else. **Don't** "tighten" this with an exhaustive `switch` plus a `never` exhaustiveness check — the next SDK release will break the build. Same intent as [gemini-acp's `_ => {}` arm on `acp::SessionMessage`](../gemini-acp/TECHNICAL.md#5-design-decisions-log).

3. **Forward-compat in the `block.type === "text"` filter.** Content blocks from the Anthropic SDK are a discriminated union (`TextBlock | ToolUseBlock | ThinkingBlock | ServerToolUseBlock | …`). Filtering for `"text"` is intentional for chat-only mode — `ToolUseBlock` shouldn't fire because `tools: []` blocks tool loading, and any other block type is safely dropped. Adding more arms (e.g. handling `ThinkingBlock` as separate output) is fine, but don't make this exhaustive.

## Tests

No `npm test` suite. Manual smoke recipe — the parity test against `gemini-acp`'s [favourite-colour-is-teal check](../gemini-acp/CLAUDE.md#tests):

```bash
rm -f /tmp/claude-chat-$USER.sock
./dist/index.js --daemon --quiet &
./dist/index.js --connect --json "remember: my favourite colour is teal. reply just OK"
./dist/index.js --connect --json "what colour did i just say? reply just the colour"  # should reply "teal"
./dist/index.js --connect --shutdown
```

Both connect calls must emit the **same** `session_id`. Run this after any change touching the socket lifecycle, the `queue` chain, or `promptAndCollect`.

## Git

This directory is **its own git repo** on branch `main`, with remote `origin` at `git@github.com:FenrirZheng/claude-agentic-chat.git`. The parent `$HOME` dotfiles repo gitignores `Documents/` so this working tree is invisible there. Init commit was `7b0ada2 init: four-mode CLI around the Claude Agent SDK`, mirroring [gemini-acp](../gemini-acp/CLAUDE.md#git)'s shape.

Per global rule in [`~/.claude/CLAUDE.md`](../../.claude/CLAUDE.md), no `git push`, no PRs, no opening additional remotes without asking first. Match the loose subject style of the existing log (`feat: ...`, `daemon: ...`, `docs: ...`).

## Future work

Not done yet, listed so you don't accidentally invent the same feature twice:

- **Streaming-input mode.** Today each turn is a fresh `query({prompt: string, ...})` — re-spawning `claude` per turn. Switching to `query({prompt: asyncIterable, ...})` keeps one `claude` subprocess alive across turns. Only worth doing if profiling shows re-spawn dominates; today the LLM round-trip drowns it out.
- **Structured `stop_reason`.** Today we forward the SDK's `subtype` verbatim (`"success"`, `"error_max_turns"`, …). Acceptable today; brittle if consumers parse exact strings.

## Don't

- Don't `git push` or `git remote add` without explicit user instruction.
- **Don't remove `allowHalfOpen: true`** from the `createServer` call. Fatal — daemon silently swallows all responses. See [Editing src/index.ts](#editing-srcindexts) trap 1.
- Don't tighten `SDKMessage` or content-block matches into exhaustive `switch` + `never` checks. The SDK adds variants between minor versions; [src/index.ts](src/index.ts) is intentionally permissive.
- Don't switch `tools: []` to `allowedTools: []` thinking they mean the same thing. They don't — `tools: []` skips tool loading entirely (chat-only); `allowedTools: []` whitelists from a loaded set (still loads, just denies).
- Don't auto-spawn a daemon from `--connect`. Same probe-then-bind race window that [gemini-acp](../gemini-acp/CLAUDE.md#dont) avoids; let the user manage daemon lifecycle.
- Don't reach for `--permission-mode bypassPermissions` blindly when **the prompt is open-ended AND the inputs include external/untrusted content** (e.g. "investigate and fix issues here" while feeding in web fetch results / unknown file contents). Tool outputs can carry prompt injection, and bypass turns that into direct shell execution. For bounded prompts with self-typed inputs (explicit commands, listed paths, named files in cwd) bypass is the pragmatic default — same risk profile as running `Bash` in the main session. The risk gate is `prompt openness × input trust`, not the flag itself; the SDK's scary `allowDangerouslySkipPermissions` name overstates the routine case.
- Don't introduce streaming-input mode (`query({prompt: asyncIterable})`) without measuring re-spawn cost first. Per-turn `query({resume})` is cheaper to write and reason about.
- Don't commit `node_modules/` or `dist/` — already in [.gitignore](.gitignore), but stay alert.
