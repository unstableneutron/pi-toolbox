import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SOCKET_PATH = path.join(
  os.homedir(),
  '.codex/app-server-control/app-server-control.sock',
);

export const CODEX_APP_SERVER_ORIGIN = 'app://codex';

export type CodexAppServerControlSocketHealth =
  | { ok: true; socketPath: string }
  | { ok: false; socketPath: string; error: string };

export function getCodexAppServerControlSocketPath(): string {
  return process.env.PI_CODEX_APP_SERVER_CONTROL_SOCKET?.trim() || DEFAULT_SOCKET_PATH;
}

export async function checkCodexAppServerControlSocket(
  options: { socketPath?: string | undefined; timeoutMs?: number | undefined } = {},
): Promise<CodexAppServerControlSocketHealth> {
  const socketPath = options.socketPath ?? getCodexAppServerControlSocketPath();
  const timeoutMs = options.timeoutMs ?? 750;

  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (health: CodexAppServerControlSocketHealth) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(health);
    };
    const timer = setTimeout(
      () => finish({ ok: false, socketPath, error: `timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );

    socket.once('connect', () => finish({ ok: true, socketPath }));
    socket.once('error', (error) => finish({ ok: false, socketPath, error: error.message }));
  });
}
