import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

/**
 * File storage. In AWS, browsers upload and download directly to the
 * SSE-KMS bucket through presigned URLs (<= 5 minutes); bytes never pass through
 * the app server. Locally, a filesystem store with HMAC-signed, expiring URLs
 * stands in for S3.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/tiff": "tiff",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export interface Storage {
  presignUpload(key: string, mime: string, size: number): Promise<{ url: string; headers: Record<string, string> }>;
  presignDownload(key: string, filename: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, mime: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Keys never contain PHI: tenant/client/file UUIDs only. */
export function fileKey(tenantId: string, clientId: string, fileId: string, ext: string) {
  return `tenants/${tenantId}/clients/${clientId}/files/${fileId}.${ext}`;
}
export function figureKey(tenantId: string, clientId: string, figureId: string) {
  return `tenants/${tenantId}/clients/${clientId}/figures/${figureId}.png`;
}
export function exportKey(tenantId: string, planId: string, version: number, ext: string) {
  return `tenants/${tenantId}/exports/${planId}/v${version}.${ext}`;
}

class S3Storage implements Storage {
  private s3 = new S3Client({ region: env().region });
  private bucket = env().bucket;
  private ttl = env().presignTtlSeconds;

  async presignUpload(key: string, mime: string, size: number) {
    if (size > MAX_UPLOAD_BYTES) throw new Error("File too large");
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: size, ServerSideEncryption: "aws:kms" });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: this.ttl });
    return { url, headers: { "Content-Type": mime, "x-amz-server-side-encryption": "aws:kms" } };
  }
  async presignDownload(key: string, filename: string) {
    const safe = filename.replace(/[^\w.\- ]/g, "_");
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${safe}"` }), { expiresIn: this.ttl });
  }
  async get(key: string) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async put(key: string, body: Buffer, mime: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime, ServerSideEncryption: "aws:kms" }));
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export class LocalStorage implements Storage {
  constructor(
    private root = env().localStorageDir,
    private secret = env().sessionSecret,
    private baseUrl = env().appUrl,
    private ttl = env().presignTtlSeconds,
  ) {}

  private path(key: string) {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error("Invalid key");
    return p;
  }
  sign(op: "put" | "get", key: string, exp: number, extra = "") {
    return createHmac("sha256", this.secret).update(`${op}:${key}:${exp}:${extra}`).digest("hex");
  }
  verify(op: "put" | "get", key: string, exp: number, sig: string, extra = ""): boolean {
    if (Date.now() / 1000 > exp) return false;
    const a = Buffer.from(this.sign(op, key, exp, extra));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private url(op: "put" | "get", key: string, extra = "", filename = "") {
    const exp = Math.floor(Date.now() / 1000) + this.ttl;
    const q = new URLSearchParams({ key, exp: String(exp), sig: this.sign(op, key, exp, extra) });
    if (filename) q.set("fn", filename);
    if (extra) q.set("x", extra);
    return `${this.baseUrl}/api/local-storage/${op}?${q}`;
  }
  async presignUpload(key: string, mime: string, size: number) {
    if (size > MAX_UPLOAD_BYTES) throw new Error("File too large");
    return { url: this.url("put", key, `${mime}|${size}`), headers: { "Content-Type": mime } };
  }
  async presignDownload(key: string, filename: string) {
    return this.url("get", key, "", filename);
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

let instance: Storage | null = null;
export function storage(): Storage {
  if (!instance) instance = env().mode === "aws" ? new S3Storage() : new LocalStorage();
  return instance;
}
export function setStorage(s: Storage | null) {
  instance = s;
}
