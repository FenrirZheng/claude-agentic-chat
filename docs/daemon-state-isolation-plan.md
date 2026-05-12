# Plan: daemon state-file isolation (fix the per-user singleton coupling)

Status: **implemented** (2026-05-12) — `--state-file` flag + socket-derived pointer naming + the `claude-chat: state file <path>` startup banner are live in [src/index.ts](../src/index.ts) (`stateDir` / `resolveStatePath` / `loadLastSession` / `saveLastSession`). User-facing summary folded into [CLAUDE.md "Daemon discipline"](../CLAUDE.md#daemon-discipline) and [README](../README.md); the `cleanup-state` follow-up is parked in [CLAUDE.md "Future work"](../CLAUDE.md#future-work). This file is retained for the design rationale (the A/B/C/D consult, the critique points the `resolveStatePath` edge-case handling came from).

## The problem (root cause)

Daemon mode holds **two per-user global singletons, neither namespaced by instance**:

1. **Unix socket** — default `/tmp/claude-chat-$USER.sock`, overridable via `--socket <path>`. On `--daemon` start the daemon `existsSync()`s the path, then `probeSocket()`s it (`createConnection`); connect-success ⇒ refuse to start (`exit 1`), connect-fail ⇒ stale, `unlinkSync`, then bind. See `runDaemon` in [src/index.ts](../src/index.ts).
2. **Resume-pointer file** — `${XDG_STATE_HOME:-~/.local/state}/claude-chat/last-session`. Written after **every** turn (`saveLastSession(r.sessionId)`); read on **every** `--daemon` start unless `--fresh` or `--resume <id>`. **There is no flag to override its path.** See `getLastSessionPath` / `loadLastSession` / `saveLastSession` in [src/index.ts](../src/index.ts).

`one-shot` and `REPL` modes touch neither file — that's by design, and it's why a throwaway side-task via `claude-chat --json "Q"` has zero coupling.

### Failure modes when two Claude Code sessions on one machine each want a persistent side-claude daemon

| Setup | Outcome | Character |
|---|---|---|
| Both use the default socket | Second `--daemon` start hits the live-socket probe → `exit 1` | loud, recoverable |
| Second uses `--socket <other>`, neither passes `--fresh`/`--resume` | Second daemon reads the **shared** `last-session` → silently resumes the **first** daemon's conversation; thereafter both daemons overwrite `last-session` every turn → pointer ping-pongs | quiet, cross-contaminating |
| Second uses `--socket <other> --fresh` (looks clean) | Second daemon's own lifetime is clean, but it still writes its `sessionId` into the shared `last-session` → when the **first** daemon next restarts, it picks up the second's conversation | pollution merely deferred in time |

The deepest cause: the daemon conflates *the socket* (an IPC endpoint) with *the conversation* (session state) and assumes both are 1:1 with the `$USER`. The fully-general fix is a multi-session daemon (named sessions multiplexed over the socket) — but [CLAUDE.md](../CLAUDE.md#daemon-discipline) deliberately chose the single-session-honest design and documents that choice, so the fix below stays inside that constraint.

## Design decision

Two sub-Claude consults (one "pick among A/B/C/D", one "critique candidate A") converged on **Option A + Option B + a startup banner line**. Summary of the alternatives that were weighed:

- **A — derive the state-file name from the socket path.** Makes `--socket` the single namespace knob. Chosen as the default behaviour.
- **B — explicit `--state-file <path>` flag.** Kept as a higher-precedence override (power users / scripts). Critique consult's point (f): a plain flag is more predictable and trivially documentable; offering both, with `--state-file` winning, gets the best of each.
- **C — env var (`CLAUDE_CHAT_INSTANCE`) namespacing both socket and state.** Rejected: pushes coordination to the caller and would internally end up implementing A or B anyway.
- **D — true multi-session daemon.** Rejected: large rewrite, contradicts the project's stated design philosophy.

### Resolution rules (precedence, highest first)

1. `--resume <id>` given → use that id, ignore the state file for the initial resume (unchanged behaviour).
2. `--fresh` given → start a new conversation, don't load (unchanged behaviour).
3. `--state-file <path>` given → use exactly that path.
4. `--socket` **explicitly given on the CLI** (detected via commander's `getOptionValueSource('socket') !== 'default'`, **not** by string-comparing against the default path — that comparison is fragile re: trailing slashes / symlinks / env-expansion timing, per the critique consult's point (b)) → state file is `${stateDir}/last-session-${sanitize(basename(socket))}-${sha1(path.resolve(socket)).slice(0,8)}`.
   - Use `path.resolve()`, **not** `fs.realpath()` — the socket usually doesn't exist yet, so `realpath` would throw. Accept that `/tmp/foo` vs `/tmp/../tmp/foo` hash differently; document "pass a clean socket path". (Critique consult's point (a).)
   - `sanitize()` = keep `[A-Za-z0-9._-]`, replace the rest with `-`. The basename prefix is for human legibility when staring at `~/.local/state/claude-chat/` (consult #1's補充); the 8-char SHA prefix disambiguates.
5. Otherwise (no `--socket` on the CLI) → the literal name `last-session` — **zero migration** for every existing single-daemon user.

### Banner / discoverability

When the daemon starts without `--quiet`, after the existing `claude-chat: resuming session <id>` / `daemon listening on <socket>` lines, also print `claude-chat: state file <resolved-path>`. Kills the "where did my session go?" opacity (critique consult's point (d)) without a new subcommand.

### Deferred (do NOT block this change on these)

- A `claude-chat cleanup-state` / `--prune-state` command for the `last-session-*` files that accumulate as users experiment with socket paths (critique consult's point (e)). Add to [CLAUDE.md](../CLAUDE.md#future-work) "Future work" instead.
- `--isolate-state` opt-in flag (critique consult's alternative framing). Not needed — explicit `--socket` already implies isolation under rule 4, and `--state-file` covers the manual case.

## Implementation steps

### 1. `src/index.ts`

- Add `--state-file <path>` to the commander option list (near `--socket`). Add `stateFile?: string` to the relevant opts type(s) (`CommonOpts` / the daemon opts struct).
- Add a helper, e.g. `resolveStatePath(opts, program)`:
  - `if (opts.stateFile) return resolve(opts.stateFile);`
  - `const dir = stateDir();` (factor the existing `${XDG_STATE_HOME:-~/.local/state}/claude-chat` directory logic out of `getLastSessionPath` into a `stateDir()` so both the literal and the derived names share it)
  - `if (program.getOptionValueSource('socket') === 'default') return join(dir, 'last-session');`
  - else `return join(dir, \`last-session-${sanitize(basename(opts.socket))}-${sha1(resolve(opts.socket)).slice(0,8)}\`);`
- Rework `loadLastSession` / `saveLastSession` to take the resolved path (or read it from a closure in `runDaemon`) instead of calling `getLastSessionPath()` internally. Keep them daemon-only — `one-shot` / `REPL` still never call them.
- In `runDaemon`: compute the resolved state path once at the top (alongside the socket resolution), use it for both the initial `loadLastSession` and every `saveLastSession`, and emit the `claude-chat: state file <path>` banner line when `!opts.quiet`.
- `getOptionValueSource` needs the commander `Command` instance in scope at the call site — thread `program` through, or compute the source up in the action handler and pass a boolean `socketExplicit` down.
- Respect the existing forward-compat traps in [CLAUDE.md](../CLAUDE.md#editing-srcindexts) (don't touch the `SDKMessage` switch or the `allowHalfOpen` line).

### 2. Rebuild

`npm run build` → refreshes `dist/index.js` (the `~/.local/bin/claude-chat` symlink target). `dist/` is gitignored — not committed, but must be rebuilt locally for the change to take effect.

### 3. `CLAUDE.md` (this project)

- "Daemon discipline" section: document `--state-file`, rewrite the session-persistence paragraph to describe the new resolution rules and the per-socket derivation, mention the startup banner line.
- "Future work": add the `cleanup-state` bullet.
- Cross-link this plan file from "Daemon discipline" while it's still `status: proposed`; remove the link once folded in.

### 4. `~/.claude/skills/claude-chat/SKILL.md` (and the `~/.gemini/skills/claude-chat/SKILL.md` mirror)

- Add a caveat (in "Don't" or a new "Daemon is a per-user singleton" note): the daemon's socket is a per-user singleton, so a second concurrent persistent daemon **must** pass `--socket <unique-path>`; with this fix that one flag also isolates the resume pointer, so no `--fresh` dance is needed. For a throwaway side-task that doesn't need persistence, prefer one-shot (`claude-chat --json "Q"`) — it touches neither the socket nor the state file.
- Add `--state-file <path>` to the flag/usage tables.
- **Unrelated drive-by fix**: the SKILL.md still says the binary lives at `/home/fenrir/Documents/claude-agentic-chat/...`; the `~/.local/bin/claude-chat` symlink actually points at `~/fenrir-tools/claude-agentic-chat/dist/index.js` (the project moved into the `fenrir-tools/` submodule). Update all such path references. Same in the `.gemini/` mirror.

### 5. Smoke test

Run the favourite-colour-is-teal recipe from [CLAUDE.md](../CLAUDE.md#tests) — both `--connect` calls must report the same `session_id`. Then a second pass exercising the new path: `--daemon --socket /tmp/claude-chat-test.sock` in one shell while the default daemon is up, confirm they don't share state and the banner prints two different state-file paths, `--connect --shutdown` both.

## Open questions for the user

- OK to land all five steps in one go, or split (e.g. SKILL.md caveat now, tool change later)?
- Include the `cleanup-state` command in this round after all, or leave it deferred?
- Commit granularity: the project's [CLAUDE.md](../CLAUDE.md#git) prefers loose-subject commits; the parent `$HOME` repo will then show `modified: fenrir-tools/claude-agentic-chat` (gitlink SHA) — bless it with `git -C ~ add fenrir-tools/claude-agentic-chat && git -C ~ commit`, or leave the parent pin alone for now?
