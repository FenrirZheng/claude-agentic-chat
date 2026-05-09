#!/usr/bin/env node
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Command } from "commander";
import { createServer, createConnection, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { stdin, stdout, stderr, exit } from "node:process";
import { createInterface } from "node:readline";

interface CommonOpts {
  model?: string;
  resume?: string;
  json: boolean;
  quiet: boolean;
  socket: string;
  trace: boolean;
  fresh: boolean;
}

interface PromptResult {
  reply: string;
  sessionId: string;
  stopReason: string;
}

interface DaemonRequest {
  prompt?: string;
  shutdown?: boolean;
}

interface DaemonResponse {
  reply?: string;
  stop_reason?: string;
  session_id?: string;
  ok?: boolean;
  error?: string;
}

// ── persisted session state ─────────────────────────────────────────────────

// XDG_STATE_HOME/claude-chat/last-session — daemon-only auto-resume.
// One-shot and REPL modes intentionally don't read or write this; ad-hoc calls
// staying ad-hoc is the more useful default.
function getStatePath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "claude-chat", "last-session");
}

async function loadLastSession(): Promise<string | undefined> {
  try {
    const content = await readFile(getStatePath(), "utf8");
    const id = content.trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

async function saveLastSession(id: string): Promise<void> {
  if (!id) return;
  const path = getStatePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, id + "\n", "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`warn: failed to persist session: ${msg}\n`);
  }
}

// ── core ────────────────────────────────────────────────────────────────────

async function promptAndCollect(
  prompt: string,
  opts: { model?: string; resume?: string; trace?: boolean },
): Promise<PromptResult> {
  const q = query({
    prompt,
    options: {
      model: opts.model,
      resume: opts.resume,
      // chat-only: no tools loaded, no settings sourced (settingSources defaults to []),
      // empty system prompt (systemPrompt defaults to undefined).
      tools: [],
    },
  });

  let reply = "";
  let sessionId = opts.resume ?? "";
  let stopReason = "unknown";

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (opts.trace) stderr.write(`[trace] ${JSON.stringify(msg)}\n`);

    if ("session_id" in msg && typeof msg.session_id === "string" && msg.session_id) {
      sessionId = msg.session_id;
    }

    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") reply += block.text;
      }
    } else if (msg.type === "result") {
      stopReason = msg.subtype;
    }
    // forward-compat: unknown SDKMessage variants are ignored
  }

  return { reply, sessionId, stopReason };
}

function emit(opts: CommonOpts, r: PromptResult): void {
  if (opts.json) {
    stdout.write(
      JSON.stringify({
        reply: r.reply,
        stop_reason: r.stopReason,
        session_id: r.sessionId,
      }) + "\n",
    );
  } else {
    stdout.write(r.reply + "\n");
  }
}

async function readStdin(): Promise<string> {
  let buf = "";
  for await (const chunk of stdin) buf += chunk.toString();
  return buf.trim();
}

// ── mode 1: one-shot ────────────────────────────────────────────────────────

async function runOneShot(prompt: string, opts: CommonOpts): Promise<void> {
  const r = await promptAndCollect(prompt, opts);
  emit(opts, r);
}

// ── mode 2: REPL ────────────────────────────────────────────────────────────

async function runRepl(opts: CommonOpts): Promise<void> {
  let sessionId = opts.resume;
  if (!opts.quiet) {
    stderr.write("claude-chat — Ctrl+D to exit\n");
    stderr.write("you> ");
  }
  const rl = createInterface({ input: stdin, terminal: false });
  for await (const line of rl) {
    if (line.length === 0) {
      if (!opts.quiet) stderr.write("you> ");
      continue;
    }
    const r = await promptAndCollect(line, { ...opts, resume: sessionId });
    sessionId = r.sessionId;
    if (!opts.quiet) stderr.write("claude> ");
    emit(opts, r);
    if (!opts.quiet) stderr.write("you> ");
  }
  if (!opts.quiet) stderr.write("\nbye\n");
}

// ── mode 3: daemon ──────────────────────────────────────────────────────────

function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    c.once("connect", () => {
      c.end();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

async function runDaemon(opts: CommonOpts): Promise<void> {
  // Stale-socket detection: probe; success ⇒ live daemon, refuse; failure ⇒ stale, remove.
  if (existsSync(opts.socket)) {
    if (await probeSocket(opts.socket)) {
      stderr.write(`claude-chat: daemon already running on ${opts.socket}\n`);
      exit(1);
    }
    unlinkSync(opts.socket);
  }

  // Resolve initial session: explicit --resume wins, then persisted last session
  // (unless --fresh suppresses it), then undefined (start a new conversation).
  let sessionId: string | undefined = opts.resume;
  if (!sessionId && !opts.fresh) {
    const persisted = await loadLastSession();
    if (persisted) {
      sessionId = persisted;
      if (!opts.quiet) {
        stderr.write(`claude-chat: resuming session ${persisted}\n`);
      }
    }
  }

  // Serialize prompts: one in-flight query() at a time. ACP-style honesty —
  // concurrent prompts on the same session would interleave conversation state.
  let queue: Promise<void> = Promise.resolve();

  const cleanup = (): void => {
    try {
      unlinkSync(opts.socket);
    } catch {
      /* socket already gone */
    }
  };

  const handle = async (conn: Socket, raw: string): Promise<void> => {
    let req: DaemonRequest;
    try {
      req = JSON.parse(raw) as DaemonRequest;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      conn.end(JSON.stringify({ error: `bad JSON: ${msg}` } satisfies DaemonResponse) + "\n");
      return;
    }

    if (req.shutdown) {
      conn.end(JSON.stringify({ ok: true } satisfies DaemonResponse) + "\n");
      conn.once("close", () => {
        server.close();
        cleanup();
        exit(0);
      });
      return;
    }

    if (typeof req.prompt !== "string") {
      conn.end(
        JSON.stringify({ error: "missing 'prompt' field" } satisfies DaemonResponse) + "\n",
      );
      return;
    }

    try {
      const r = await promptAndCollect(req.prompt, {
        model: opts.model,
        resume: sessionId,
        trace: opts.trace,
      });
      sessionId = r.sessionId;
      await saveLastSession(r.sessionId);
      conn.end(
        JSON.stringify({
          reply: r.reply,
          stop_reason: r.stopReason,
          session_id: r.sessionId,
        } satisfies DaemonResponse) + "\n",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      conn.end(JSON.stringify({ error: msg } satisfies DaemonResponse) + "\n");
    }
  };

  // allowHalfOpen: true is critical. Without it, Node auto-ends the writable
  // side of each connection as soon as the client half-closes (FIN), which
  // discards the daemon's response before it can flush. The wire protocol is
  // request-then-response on a single half-closed connection, so we need to
  // keep writing after the client's end.
  const server = createServer({ allowHalfOpen: true }, (conn: Socket) => {
    let buf = "";
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
    });
    conn.on("end", () => {
      // Chain onto the queue so prompts process in order.
      queue = queue.then(() => handle(conn, buf));
    });
    conn.on("error", () => {
      /* swallow per-connection errors; daemon stays up */
    });
  });

  server.listen(opts.socket, () => {
    if (!opts.quiet) {
      stderr.write(`claude-chat daemon listening on ${opts.socket}\n`);
    }
  });

  const stop = (): void => {
    server.close();
    cleanup();
    exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// ── mode 4: connect ─────────────────────────────────────────────────────────

async function runConnect(
  prompt: string | null,
  opts: CommonOpts & { shutdown?: boolean },
): Promise<void> {
  const conn = createConnection(opts.socket);
  await new Promise<void>((resolve, reject) => {
    conn.once("connect", () => resolve());
    conn.once("error", reject);
  });

  const req: DaemonRequest = opts.shutdown ? { shutdown: true } : { prompt: prompt ?? "" };
  conn.write(JSON.stringify(req) + "\n");
  conn.end();

  let buf = "";
  for await (const chunk of conn) buf += chunk.toString();

  let resp: DaemonResponse;
  try {
    resp = JSON.parse(buf) as DaemonResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`error: bad daemon response: ${msg}\n`);
    exit(1);
  }

  if (resp.error) {
    stderr.write(`error: ${resp.error}\n`);
    exit(1);
  }
  if (opts.shutdown) {
    if (!opts.quiet) stderr.write("daemon stopped\n");
    return;
  }
  if (opts.json) {
    stdout.write(JSON.stringify(resp) + "\n");
  } else {
    stdout.write((resp.reply ?? "") + "\n");
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface RawCliOpts {
  repl?: boolean;
  daemon?: boolean;
  connect?: boolean;
  shutdown?: boolean;
  fresh?: boolean;
  model?: string;
  resume?: string;
  socket: string;
  json?: boolean;
  quiet?: boolean;
  trace?: boolean;
}

const program = new Command();
program
  .name("claude-chat")
  .description(
    "Four-mode shell CLI around the Claude Agent SDK (one-shot / REPL / daemon / connect)",
  )
  .argument("[prompt]", "prompt to send (or '-' to read stdin)")
  .option("--repl", "interactive REPL")
  .option("--daemon", "run as daemon holding session state")
  .option("--connect", "send a turn to a running daemon")
  .option("--shutdown", "(with --connect) stop the daemon")
  .option("--fresh", "(with --daemon) ignore persisted last session, start new")
  .option("--model <m>", "Claude model (defaults to SDK default)")
  .option("--resume <id>", "resume a specific session id")
  .option(
    "--socket <path>",
    "daemon socket path",
    `/tmp/claude-chat-${userInfo().username}.sock`,
  )
  .option("--json", "JSON output: {reply, stop_reason, session_id}")
  .option("-q, --quiet", "REPL without chrome / daemon without banner")
  .option("--trace", "dump SDK message stream to stderr")
  .action(async (promptArg: string | undefined, raw: RawCliOpts) => {
    const opts: CommonOpts = {
      model: raw.model,
      resume: raw.resume,
      json: !!raw.json,
      quiet: !!raw.quiet,
      socket: raw.socket,
      trace: !!raw.trace,
      fresh: !!raw.fresh,
    };

    const modes = [raw.daemon, raw.connect, raw.repl].filter(Boolean).length;
    if (modes > 1) {
      stderr.write("error: --daemon, --connect, --repl are mutually exclusive\n");
      exit(2);
    }

    if (raw.connect) {
      const prompt = raw.shutdown
        ? null
        : (promptArg && promptArg !== "-" ? promptArg : await readStdin());
      if (!raw.shutdown && !prompt) {
        stderr.write("error: --connect needs a prompt arg, stdin, or --shutdown\n");
        exit(2);
      }
      await runConnect(prompt, { ...opts, shutdown: !!raw.shutdown });
      return;
    }

    if (raw.daemon) {
      await runDaemon(opts);
      return;
    }

    if (raw.repl) {
      await runRepl(opts);
      return;
    }

    const prompt = promptArg && promptArg !== "-" ? promptArg : await readStdin();
    if (!prompt) {
      stderr.write(
        "error: no prompt — give an arg, pipe stdin, or use --repl/--daemon/--connect\n",
      );
      exit(2);
    }
    await runOneShot(prompt, opts);
  });

program.parseAsync().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  stderr.write(`error: ${msg}\n`);
  exit(1);
});
