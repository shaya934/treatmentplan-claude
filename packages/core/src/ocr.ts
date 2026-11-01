import {
  DetectDocumentTextCommand,
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
  type Block,
} from "@aws-sdk/client-textract";
import { env } from "./env";

/** OCR for scanned pages and images: Amazon Textract (HIPAA-eligible). */
export interface Ocr {
  /** Returns text per page (1-based index = array index + 1), or null when OCR is unavailable. */
  pdf(s3Key: string): Promise<string[] | null>;
  image(bytes: Buffer): Promise<string | null>;
}

function linesByPage(blocks: Block[]): string[] {
  const pages: string[][] = [];
  for (const b of blocks) {
    if (b.BlockType !== "LINE") continue;
    const p = (b.Page ?? 1) - 1;
    (pages[p] ??= []).push(b.Text ?? "");
  }
  return Array.from({ length: pages.length }, (_, i) => (pages[i] ?? []).join("\n"));
}

export class TextractOcr implements Ocr {
  private client: TextractClient;
  constructor(region = env().region, private bucket = env().bucket) {
    this.client = new TextractClient({ region });
  }

  async pdf(s3Key: string) {
    const start = await this.client.send(
      new StartDocumentTextDetectionCommand({ DocumentLocation: { S3Object: { Bucket: this.bucket, Name: s3Key } } }),
    );
    const jobId = start.JobId!;
    const blocks: Block[] = [];
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("Textract timeout");
      await new Promise((r) => setTimeout(r, 3000));
      let next: string | undefined;
      const first = await this.client.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
      if (first.JobStatus === "IN_PROGRESS") continue;
      if (first.JobStatus !== "SUCCEEDED") throw new Error(`Textract ${first.JobStatus}`);
      blocks.push(...(first.Blocks ?? []));
      next = first.NextToken;
      while (next) {
        const page = await this.client.send(new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: next }));
        blocks.push(...(page.Blocks ?? []));
        next = page.NextToken;
      }
      return linesByPage(blocks);
    }
  }

  async image(bytes: Buffer) {
    const res = await this.client.send(new DetectDocumentTextCommand({ Document: { Bytes: bytes } }));
    return linesByPage(res.Blocks ?? []).join("\n");
  }
}

/** Local mode has no OCR; scanned pages are flagged for the BCBA instead. */
class NoOcr implements Ocr {
  async pdf() {
    return null;
  }
  async image() {
    return null;
  }
}

let instance: Ocr | null = null;
export function ocr(): Ocr {
  if (!instance) instance = env().mode === "aws" ? new TextractOcr() : new NoOcr();
  return instance;
}
export function setOcr(o: Ocr | null) {
  instance = o;
}
