import { type WebSocket, WebSocketServer } from "ws";
import * as pty from "node-pty";
import os from "os";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

// ── Custom ZDOTDIR for orange prompt ─────────────────────────────────────────
// Creates a tiny .zshrc that (1) sources the user's real ~/.zshrc so all their
// aliases / nvm / PATH / oh-my-zsh still loads, then (2) appends a precmd hook
// that unconditionally sets PROMPT last — winning over any oh-my-zsh theme.
const CUSTOM_ZDOTDIR = path.join(os.tmpdir(), "buildover-zsh-dotdir");
mkdirSync(CUSTOM_ZDOTDIR, { recursive: true });
writeFileSync(
  path.join(CUSTOM_ZDOTDIR, ".zshrc"),
  [
    `[[ -f ${JSON.stringify(path.join(os.homedir(), ".zshrc"))} ]] && source ${JSON.stringify(path.join(os.homedir(), ".zshrc"))}`,
    `_buildover_set_prompt() { PROMPT='%F{#d97757}%n@%m %1~ >%f '; }`,
    `precmd_functions+=(_buildover_set_prompt)`,
  ].join("\n") + "\n",
);

type TerminalClientMsg =
  | { type: "create"; tabId: string; cwd: string }
  | { type: "input"; tabId: string; data: string }
  | { type: "resize"; tabId: string; cols: number; rows: number }
  | { type: "destroy"; tabId: string };

interface PtySession {
  process: pty.IPty;
  tabId: string;
}

function resolveShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (os.platform() === "win32") return "cmd.exe";
  // Common fallbacks on macOS/Linux
  for (const sh of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (existsSync(sh)) return sh;
  }
  return "/bin/sh";
}

export function attachTerminalWss(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket) => {
    const sessions = new Map<string, PtySession>();

    const send = (msg: object) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    ws.on("message", (raw) => {
      let msg: TerminalClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as TerminalClientMsg;
      } catch {
        return;
      }

      switch (msg.type) {
        case "create": {
          // Don't double-create a tab
          if (sessions.has(msg.tabId)) break;

          const shell = resolveShell();
          const cwd = existsSync(msg.cwd) ? msg.cwd : os.homedir();

          // Strip npm_config_prefix — it conflicts with nvm and causes a warning
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { npm_config_prefix: _ncp, ...cleanEnv } = process.env as Record<string, string>;

          let ptyProcess: pty.IPty;
          try {
            ptyProcess = pty.spawn(shell, [], {
              name: "xterm-256color",
              cols: 120,
              rows: 30,
              cwd,
              env: {
                ...cleanEnv,
                TERM: "xterm-256color",
                COLORTERM: "truecolor",
                // Ensure PATH includes common tool locations on macOS
                PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                // Point zsh at our custom dotdir — sources real ~/.zshrc then
                // appends a precmd hook that sets the orange prompt last.
                ZDOTDIR: CUSTOM_ZDOTDIR,
              } as Record<string, string>,
            });
          } catch (err) {
            send({
              type: "error",
              tabId: msg.tabId,
              message: err instanceof Error ? err.message : String(err),
            });
            break;
          }

          ptyProcess.onData((data) => {
            send({ type: "output", tabId: msg.tabId, data });
          });

          ptyProcess.onExit(({ exitCode }) => {
            sessions.delete(msg.tabId);
            send({ type: "exit", tabId: msg.tabId, code: exitCode });
          });

          sessions.set(msg.tabId, { process: ptyProcess, tabId: msg.tabId });
          break;
        }

        case "input": {
          sessions.get(msg.tabId)?.process.write(msg.data);
          break;
        }

        case "resize": {
          const s = sessions.get(msg.tabId);
          if (s && msg.cols > 0 && msg.rows > 0) {
            try {
              s.process.resize(msg.cols, msg.rows);
            } catch {
              // Ignore resize errors (e.g. if the process just exited)
            }
          }
          break;
        }

        case "destroy": {
          const s = sessions.get(msg.tabId);
          if (s) {
            try { s.process.kill(); } catch { /* ignore */ }
            sessions.delete(msg.tabId);
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      for (const s of sessions.values()) {
        try { s.process.kill(); } catch { /* ignore */ }
      }
      sessions.clear();
    });
  });
}
