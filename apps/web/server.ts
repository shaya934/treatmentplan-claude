import { createServer, type IncomingMessage } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { audit } from "@aba/core/audit";
import { withCtx } from "@aba/core/db";
import { env } from "@aba/core/env";
import { setLocalRunner } from "@aba/core/jobs";
import { log } from "@aba/core/logger";
import { SESSION_COOKIE, verifySession } from "@aba/core/session";
import { installUsageSink } from "@aba/core/svc/context";
import { runJob } from "@aba/core/svc/work";
import { startTranscription } from "@aba/core/transcribe";

/**
 * Custom Node server: Next.js pages/API plus a WebSocket endpoint for
 * streaming voice input to Amazon Transcribe. Audio frames are forwarded and
 * dropped; nothing is written to disk. In local mode, background jobs also run
 * in this process (in AWS they run in the Fargate worker via SQS).
 */
const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const app = next({ dev, hostname: "0.0.0.0", port });
const handle = app.getRequestHandler();

installUsageSink();
if (env().mode === "local") setLocalRunner(runJob);

function cookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

await app.prepare();
const server = createServer((req, res) => handle(req, res, parse(req.url ?? "/", true)));
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on("upgrade", async (req, socket, head) => {
  const { pathname } = parse(req.url ?? "/");
  if (pathname !== "/ws/transcribe") {
    if (dev) return; // let Next dev HMR handle its own upgrades
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return socket.destroy();
  const token = cookie(req, SESSION_COOKIE);
  const claims = token ? await verifySession(token, env().sessionSecret, env().sessionIdleMinutes) : null;
  if (!claims || claims.role === "read_only" || (claims.role === "super_admin" && !claims.tid)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => onTranscribe(ws, claims.sub, claims.tid, req));
});

function onTranscribe(ws: WebSocket, userId: string, tenantId: string | null, req: IncomingMessage) {
  let bytes = 0;
  const maxBytes = 16000 * 2 * 60 * 10; // 10 minutes of 16 kHz PCM
  const session = startTranscription((e) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  });
  session.done
    .catch((e) => {
      log.error({ event: "transcribe_failed", userId }, e);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ error: "Transcription failed. Please type instead." }));
    })
    .finally(() => ws.close());
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      if (String(data) === "end") session.end();
      return;
    }
    const buf = data as Buffer;
    bytes += buf.length;
    if (bytes > maxBytes) return session.end();
    session.write(buf);
  });
  ws.on("close", () => {
    session.end();
    withCtx({ tenantId, userId, role: "system" }, (t) =>
      audit(t, { tenantId, userId, action: "transcribe", entity: "voice", detail: { bytes } }, { ip: req.socket.remoteAddress ?? null, userAgent: req.headers["user-agent"] ?? null }),
    ).catch(() => {});
  });
}

server.listen(port, () => log.info({ event: "server_started", status: env().mode }));
