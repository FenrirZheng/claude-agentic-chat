# claude-chat

A small Node / TypeScript CLI that talks to [Anthropic's Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) through four shell-friendly modes: **one-shot**, **REPL**, **daemon**, and **connect**. Sister project to [`gemini-acp`](../gemini-acp/), which uses the same shape over Google's Gemini via the Agent Client Protocol.

The daemon mode is the standout — it holds one Claude session in memory and amortises spawn cost across many turns, dropping per-turn latency to a clean LLM round-trip. Combined with NDJSON streaming over the daemon's Unix socket, that makes Claude practical to call from inside multi-step shell pipelines and from Claude Code's `Bash` tool, neither of which can keep a REPL alive across calls.

Token streaming is on by default. Tool use is opt-in via `--allow-tools`. Session state persists across daemon restarts via a pointer file under `${XDG_STATE_HOME:-~/.local/state}/claude-chat/` — `last-session` for the default socket, or a per-instance `last-session-<socket>-<hash>` when you run a daemon on a custom `--socket` (so several daemons don't clobber each other). Override the path explicitly with `--state-file`.

## Requirements

- **Node.js 23.6 or newer** — required for native TypeScript execution. Earlier versions need `tsx` / `ts-node` and a build step.
- The [`claude`](https://docs.claude.com/en/docs/claude-code) CLI on `PATH`. The Agent SDK auto-detects it, spawns it as `claude --print --output-format stream-json`, and parses the JSON stream. Authentication is handled by `claude` itself; no API-key plumbing in this layer.
- Linux / macOS — daemon mode uses Unix sockets.

## Build

```bash
npm install
npm run build              # produces ./dist/index.js
./dist/index.js --help
```

Local dev without building: `node src/index.ts --help` (Node 23.6+ runs TS sources directly).

## The four modes

| Mode | Usage | When |
|---|---|---|
| **One-shot** | `claude-chat "Q"` or `echo Q \| claude-chat -` | Scripts, single questions, shell pipelines |
| **REPL** | `claude-chat --repl` | Interactive terminal chat |
| **Daemon** | `claude-chat --daemon &` | Long-running background process holding one session |
| **Connect** | `claude-chat --connect "Q"` | Send a turn to the running daemon over its Unix socket |

### Quick examples

```bash
# One-shot, streams tokens to stdout by default
claude-chat "Explain the borrow checker in one sentence."

# Pipe stdin (handles multi-line / large input)
cat error.log | claude-chat -

# Stable JSON output (collected, single line — no streaming)
claude-chat --json "ping"
# → {"reply":"pong","stop_reason":"success","session_id":"..."}

# Interactive REPL (streams; persists session within the REPL only)
claude-chat --repl

# Daemon: warm session reused across calls, persisted across restarts
claude-chat --daemon &
claude-chat --connect "remember my favourite colour is teal"
claude-chat --connect "what colour did I just say?"   # remembers
claude-chat --connect --shutdown

# Tool-enabled: Read / Write / Bash / MCP within process.cwd()
claude-chat --allow-tools "summarise the structure of this repo"
```

### Useful flags

| Flag | Effect |
|---|---|
| `-q` / `--quiet` | Strip REPL chrome / daemon banner — stdout becomes pure reply text |
| `--json` | Single JSON line: `{"reply":"...","stop_reason":"...","session_id":"..."}`. Disables streaming |
| `--trace` | Dump every SDK message to stderr (debug) |
| `--model M` | Pick a Claude model (defaults to whatever the local `claude` is configured for) |
| `--resume <id>` | Resume a specific session id |
| `--fresh` | (Daemon) Ignore persisted last session, start a new conversation |
| `--allow-tools` | Enable Claude Code's full tool set + system prompt; loads user / project settings |
| `--permission-mode <m>` | (With `--allow-tools`) `default` / `acceptEdits` / `bypassPermissions` / `plan` |
| `--socket <path>` | Daemon socket path. Default: `/tmp/claude-chat-$USER.sock`. A non-default value also gives the daemon its own state file |
| `--state-file <path>` | (Daemon) Override the resume-pointer file path (default: derived from `--socket`) |
| `--shutdown` | (With `--connect`) stop the running daemon |

## Streaming

Token streaming is **on by default** in one-shot, REPL, and `--connect` whenever `--json` is not set. The SDK's `includePartialMessages: true` flag opens a stream of Anthropic-SDK `content_block_delta` events; the CLI flushes their `text_delta.text` payloads to stdout as they arrive.

`--json` forces a single collected response (incompatible with mid-line streaming) — use it whenever a downstream parser needs to see one line per call.

The daemon and `--connect` use a small NDJSON protocol over the Unix socket when the client requests streaming: zero or more `{"chunk":"..."}` frames followed by exactly one `{"reply":"...","stop_reason":"...","session_id":"...","done":true}` terminator. Errors mid-stream are delivered as `{"error":"..."}` and end the stream. Wire-shape details live in [CLAUDE.md "The four modes"](CLAUDE.md#the-four-modes).

## Tool access

`claude-chat` is chat-only by default — the SDK call passes `tools: []` so no Read / Write / Bash / MCP loads. `--allow-tools` flips this on:

- **Tools**: full Claude Code preset
- **System prompt**: Claude Code's preset (teaches the agent how to use the tools)
- **Settings**: `["user", "project"]` — `~/.claude/CLAUDE.md` and the project's `CLAUDE.md` are honoured
- **Permission mode**: defaults to `bypassPermissions` — every tool call (including `Bash`) auto-approved; `allowDangerouslySkipPermissions: true` is set per SDK requirement. Chosen so routine workstation use doesn't need a flag; the cwd directory allowlist still contains filesystem blast radius. Tighten with `--permission-mode acceptEdits` (edits auto, Bash gated), `plan` (read-only), or `default` (every tool gated)

The agent operates in `process.cwd()`. The SDK enforces a directory allowlist at the tool boundary — paths outside cwd get blocked, even under `bypassPermissions`. The agent reports the block honestly rather than confabulating output.

## Using from Claude Code (or other multi-step shell tools)

Claude Code's `Bash` tool runs each call in a fresh subprocess, so a REPL session can't span calls. The daemon pattern works around that:

```bash
# Pay cold start once, then ~LLM round-trip per call
claude-chat --daemon &
claude-chat --connect "Q1"
claude-chat --connect "Q2"        # remembers Q1's context
claude-chat --connect --shutdown
```

Break-even vs cold-start-each is the second call. Multi-call workflows save proportionally.

If the daemon dies or the machine reboots, the next `--daemon` start auto-reads its pointer file (under `${XDG_STATE_HOME:-~/.local/state}/claude-chat/` — the resolved path is echoed in the startup banner as `claude-chat: state file <path>`) and resumes the prior conversation transparently. To force a fresh thread: `--daemon --fresh`. To wipe state manually: `rm` the path from that banner line.

## Daemon discipline

- **Default socket**: `/tmp/claude-chat-$USER.sock` — a per-user singleton. Override with `--socket PATH`
- **Stale-socket detection**: probe-then-remove. Live daemon at the path → refuse to start with an error. Orphaned socket (no listener) → unlink and bind
- **Clean stop**: `claude-chat --connect --shutdown`. `SIGINT` / `SIGTERM` also remove the socket
- **One in-flight request at a time**. Concurrent `--connect` calls serialise on the daemon's accept queue. A long streaming response holds the queue until its `done:true` terminator goes out — by design (interleaving streams across one session would be incoherent)
- **One session per daemon**. To multiplex sessions, run multiple daemons on distinct `--socket` paths — each non-default socket automatically gets its own state file, so they don't clobber each other's resume pointer. (Or pin one explicitly with `--state-file`.) Two Claude Code sessions on the same machine that each want a persistent side-claude daemon **must** pick distinct `--socket` paths; for a throwaway side-task that doesn't need persistence, one-shot `claude-chat --json "Q"` has no daemon and no state file — zero coupling

## Documentation map

- [CLAUDE.md](CLAUDE.md) — project memory: build & run, daemon discipline, the three traps in [src/index.ts](src/index.ts), tool access security model, future work, `Don't` list. Read first before changing protocol-handling code
- [`../gemini-acp/`](../gemini-acp/) — sister project (Rust + ACP over Gemini). Architectural blueprint for the four modes; many design decisions cross-reference it

## License

Unlicensed local project. No remote, no published package.
