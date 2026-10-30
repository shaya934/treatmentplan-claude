import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { InputDocument } from "@aba/core/pipeline/from-documents";
import { cfg } from "./config";

/**
 * Files per job, under jobs/<user>/<job>/ in the S3 bucket (encrypted with the
 * bucket's KMS key; a lifecycle rule deletes everything after 1 day). Each user
 * only ever reads under their own prefix. Locally, without a bucket, in memory.
 */

export interface JobStatus {
  state: "new" | "working" | "done" | "failed";
  message?: string;
}

interface Store {
  setStatus(owner: string, job: string, s: JobStatus): Promise<void>;
  getStatus(owner: string, job: string): Promise<JobStatus | null>;
  putInput(owner: string, job: string, name: string, mime: string, bytes: Buffer): Promise<void>;
  inputCount(owner: string, job: string): Promise<number>;
  inputs(owner: string, job: string): Promise<InputDocument[]>;
  putOutput(owner: string, job: string, pdf: Buffer): Promise<void>;
  getOutput(owner: string, job: string): Promise<Buffer | null>;
  remove(owner: string, job: string): Promise<void>;
}

const prefix = (owner: string, job: string) => `jobs/${owner}/${job}/`;

class S3Store implements Store {
  private s3 = new S3Client({ region: cfg.region });
  constructor(private bucket: string) {}

  private async put(key: string, body: Buffer, type: string, meta?: Record<string, string>) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: type, Metadata: meta, ServerSideEncryption: "aws:kms" }));
  }
  private async get(key: string): Promise<{ bytes: Buffer; meta: Record<string, string>; type: string } | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: Buffer.from(await r.Body!.transformToByteArray()), meta: r.Metadata ?? {}, type: r.ContentType ?? "" };
    } catch (e) {
      if ((e as Error).name === "NoSuchKey") return null;
      throw e;
    }
  }
  private async keys(p: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: p, ContinuationToken: token }));
      out.push(...(r.Contents ?? []).map((o) => o.Key!));
      token = r.NextContinuationToken;
    } while (token);
    return out;
  }

  async setStatus(owner: string, job: string, s: JobStatus) {
    await this.put(prefix(owner, job) + "status.json", Buffer.from(JSON.stringify(s)), "application/json");
  }
  async getStatus(owner: string, job: string) {
    const r = await this.get(prefix(owner, job) + "status.json");
    return r ? (JSON.parse(r.bytes.toString("utf8")) as JobStatus) : null;
  }
  async putInput(owner: string, job: string, name: string, mime: string, bytes: Buffer) {
    // S3 metadata is ASCII-only, so the original file name is stored base64url-encoded.
    await this.put(`${prefix(owner, job)}in/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, bytes, mime, { name: Buffer.from(name).toString("base64url") });
  }
  async inputCount(owner: string, job: string) {
    return (await this.keys(prefix(owner, job) + "in/")).length;
  }
  async inputs(owner: string, job: string) {
    const docs: InputDocument[] = [];
    for (const key of await this.keys(prefix(owner, job) + "in/")) {
      const r = (await this.get(key))!;
      docs.push({ name: Buffer.from(r.meta.name ?? "", "base64url").toString("utf8") || "document", mime: r.type, bytes: r.bytes, s3Key: key });
    }
    return docs;
  }
  async putOutput(owner: string, job: string, pdf: Buffer) {
    await this.put(prefix(owner, job) + "filled.pdf", pdf, "application/pdf");
  }
  async getOutput(owner: string, job: string) {
    return (await this.get(prefix(owner, job) + "filled.pdf"))?.bytes ?? null;
  }
  async remove(owner: string, job: string) {
    const keys = await this.keys(prefix(owner, job));
    for (let i = 0; i < keys.length; i += 1000) {
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
    }
  }
}

/** Local development only (no bucket): nothing is written to disk. */
class MemoryStore implements Store {
  private files = new Map<string, { bytes: Buffer; type: string; name?: string }>();
  async setStatus(owner: string, job: string, s: JobStatus) {
    this.files.set(prefix(owner, job) + "status.json", { bytes: Buffer.from(JSON.stringify(s)), type: "application/json" });
  }
  async getStatus(owner: string, job: string) {
    const f = this.files.get(prefix(owner, job) + "status.json");
    return f ? (JSON.parse(f.bytes.toString("utf8")) as JobStatus) : null;
  }
  async putInput(owner: string, job: string, name: string, mime: string, bytes: Buffer) {
    this.files.set(`${prefix(owner, job)}in/${this.files.size}`, { bytes, type: mime, name });
  }
  private ins(owner: string, job: string) {
    return [...this.files].filter(([k]) => k.startsWith(prefix(owner, job) + "in/"));
  }
  async inputCount(owner: string, job: string) {
    return this.ins(owner, job).length;
  }
  async inputs(owner: string, job: string) {
    return this.ins(owner, job).map(([k, f]) => ({ name: f.name ?? "document", mime: f.type, bytes: f.bytes, s3Key: k }));
  }
  async putOutput(owner: string, job: string, pdf: Buffer) {
    this.files.set(prefix(owner, job) + "filled.pdf", { bytes: pdf, type: "application/pdf" });
  }
  async getOutput(owner: string, job: string) {
    return this.files.get(prefix(owner, job) + "filled.pdf")?.bytes ?? null;
  }
  async remove(owner: string, job: string) {
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix(owner, job))) this.files.delete(k);
  }
}

export const store: Store = cfg.bucket ? new S3Store(cfg.bucket) : new MemoryStore();
