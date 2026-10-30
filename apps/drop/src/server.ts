import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { audit, cfg, HttpError } from "./config";
import { login, logout, newPassword, mfa, readSession, refreshSession } from "./auth";
import { store } from "./store";

/**
 * One page: sign in (Cognito, MFA required), drop all of a client's documents,
 * get the company's PDF form back filled in. No database; files live in an
 * encrypted S3 bucket that deletes everything after 24 hours.
 */

const MAX_FILE = 50 * 1024 * 1024;
const MAX_FILES = 40;
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const ID = /^[0-9a-f-]{36}$/;
const running = new Set<string>();

const publicDir = join(import.meta.dirname, "public");
const assets: Record<string, [string, Buffer]> = {
  "/": ["text/html; charset=utf-8", await readFile(join(publicDir, "index.html"))],
  "/app.js": ["text/javascript; charset=utf-8", await readFile(join(publicDir, "app.js"))],
  "/style.css": ["text/css; charset=utf-8", await readFile(join(publicDir, "style.css"))],
  "/logo.png": ["image/png", await readFile(join(import.meta.dirname, "..", "..", "..", "packages", "core", "assets", "we-achieve-logo.png"))],
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(buf.length), ...headers });
  res.end(buf);
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "That file is larger than 50 MB.");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const json = async (req: IncomingMessage) => {
  try {
    return JSON.parse((await body(req, 10_000)).toString("utf8")) as Record<string, string>;
  } catch {
    throw new HttpError(400, "Bad request.");
  }
};

/** Fill the form in its own process (job.ts), so building the PDF never stalls the website. */
function startJob(owner: string, email: string, job: string) {
  running.add(job);
  if (!cfg.bucket) {
    // Local development keeps files in memory, which only this process can see.
    void import("./job").then((m) => m.runJob(owner, email, job)).finally(() => running.delete(job));
    return;
  }
  const child = fork(join(import.meta.dirname, "job.ts"), [owner, email, job]);
  child.on("exit", async (code) => {
    running.delete(job);
    if (code !== 0 && (await store.getStatus(owner, job))?.state === "working") {
      await store.setStatus(owner, job, { state: "failed", message: "Something went wrong reading the documents. Please try again." });
      audit("form_failed", email, { jobId: job });
    }
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0]!.trim();

  if (path === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && assets[path]) {
    const [type, buf] = assets[path];
    return send(res, 200, buf, { "content-type": type, "cache-control": "no-cache" });
  }
  if (!path.startsWith("/api/")) return send(res, 404, { error: "Not found." });
  // Every state-changing call carries this header; a cross-site form or image cannot set it.
  if (req.method !== "GET" && req.headers["x-drop"] !== "1") throw new HttpError(403, "Forbidden.");

  // ---- sign-in ----
  if (req.method === "POST" && path === "/api/login") {
    const b = await json(req);
    return send(res, 200, ...(await login(b.email ?? "", b.password ?? "", ip)));
  }
  if (req.method === "POST" && path === "/api/new-password") {
    const b = await json(req);
    return send(res, 200, ...(await newPassword(b.challenge ?? "", b.password ?? "", ip)));
  }
  if (req.method === "POST" && path === "/api/mfa") {
    const b = await json(req);
    return send(res, 200, ...(await mfa(b.challenge ?? "", b.code ?? "", ip)));
  }

  const user = await readSession(req);
  if (!user) throw new HttpError(401, "Please sign in.");
  if (req.method === "POST" && path === "/api/logout") {
    audit("logout", user.email, { ip });
    return send(res, 200, { ok: true }, { "set-cookie": logout() });
  }
  // Status polling does not count as activity, so an unattended page still times out.
  const poll = req.method === "GET" && /^\/api\/jobs\/[^/]+$/.test(path);
  const cookie: Record<string, string> = poll ? {} : { "set-cookie": await refreshSession(user) };
  if (req.method === "GET" && path === "/api/me") return send(res, 200, { email: user.email }, cookie);

  if (req.method === "POST" && path === "/api/jobs") {
    const job = randomUUID();
    await store.setStatus(user.sub, job, { state: "new" });
    return send(res, 200, { id: job }, cookie);
  }
  const m = path.match(/^\/api\/jobs\/([^/]+)(\/files|\/start|\/pdf)?$/);
  if (!m || !ID.test(m[1]!)) return send(res, 404, { error: "Not found." });
  const job = m[1]!;
  const status = await store.getStatus(user.sub, job); // only the uploader's own jobs exist under their prefix
  if (!status) return send(res, 404, { error: "Not found." });

  if (req.method === "PUT" && m[2] === "/files") {
    if (status.state !== "new") throw new HttpError(409, "This form was already started.");
    const name = (url.searchParams.get("name") ?? "document").slice(0, 200);
    const mime = MIME[name.split(".").pop()!.toLowerCase()];
    if (!mime) throw new HttpError(415, "Use PDF, Word (.docx), Excel (.xlsx), CSV, PNG or JPG files.");
    if ((await store.inputCount(user.sub, job)) >= MAX_FILES) throw new HttpError(400, `At most ${MAX_FILES} files.`);
    const bytes = await body(req, MAX_FILE);
    if (!bytes.length) throw new HttpError(400, "That file is empty.");
    await store.putInput(user.sub, job, name, mime, bytes);
    audit("document_uploaded", user.email, { jobId: job, bytes: bytes.length, mime });
    return send(res, 200, { ok: true }, cookie);
  }
  if (req.method === "POST" && m[2] === "/start") {
    if (status.state !== "new") throw new HttpError(409, "This form was already started.");
    if (!(await store.inputCount(user.sub, job))) throw new HttpError(400, "Add at least one document first.");
    await store.setStatus(user.sub, job, { state: "working" });
    startJob(user.sub, user.email, job);
    return send(res, 200, { ok: true }, cookie);
  }
  if (req.method === "GET" && !m[2]) {
    // A job that was working when the server restarted will never finish.
    if (status.state === "working" && !running.has(job)) return send(res, 200, { state: "failed", message: "The server restarted. Please start over." });
    return send(res, 200, status, cookie);
  }
  if (req.method === "GET" && m[2] === "/pdf") {
    const pdf = await store.getOutput(user.sub, job);
    if (!pdf) return send(res, 404, { error: "Not ready." });
    audit("form_downloaded", user.email, { jobId: job, ip });
    const day = new Date().toISOString().slice(0, 10);
    return send(res, 200, pdf, { ...cookie, "content-type": "application/pdf", "content-disposition": `attachment; filename="Treatment plan ${day}.pdf"` });
  }
  if (req.method === "DELETE" && !m[2]) {
    if (running.has(job)) throw new HttpError(409, "Wait until the form is finished.");
    await store.remove(user.sub, job);
    audit("job_deleted", user.email, { jobId: job });
    return send(res, 200, { ok: true }, cookie);
  }
  return send(res, 404, { error: "Not found." });
}

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const server = createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(JSON.stringify({ event: "request_failed", errorName: (e as Error).name }));
    send(res, 500, { error: "Something went wrong. Please try again." });
  });
});
// Longer than the load balancer's 300 s idle timeout, so Node never closes a connection the load balancer is about to reuse.
server.keepAliveTimeout = 310_000;
server.headersTimeout = 320_000;
server.listen(cfg.port, () => console.log(JSON.stringify({ event: "listening", port: cfg.port })));
