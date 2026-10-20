import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const prefixes = { originals: "originals/", proxies: "proxies/", renders: "renders/" } as const;
/** Single-put ceiling and multipart part size for worker uploads (S3 allows 5 MB to 5 GB per part). */
export const putPartBytes = 64 * 1024 * 1024;
export function createStorage() {
  const required = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
  for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
  const bucket = process.env.S3_BUCKET!;
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION!, forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  return {
    client, bucket,
    async start(key: string, contentType: string) {
      const response = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
      if (!response.UploadId) throw new Error("Object store did not return an upload ID");
      return response.UploadId;
    },
    part(key: string, uploadId: string, partNumber: number) {
      return getSignedUrl(client, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 900 });
    },
    async complete(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket, Key: key, UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }));
    },
    async abort(key: string, uploadId: string) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    },
    /** Uploads one local file: a single request up to putPartBytes, multipart above it, since a single put is capped
     * at 5 GB and a long proxy can pass that. A failed multipart upload is aborted so no orphaned parts are billed. */
    async put(key: string, file: string, contentType: string, signal?: AbortSignal) {
      const { size } = await stat(file);
      if (size <= putPartBytes) {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: contentType }), { abortSignal: signal });
        return size;
      }
      const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { abortSignal: signal });
      const uploadId = created.UploadId;
      if (!uploadId) throw new Error("Object store did not return an upload ID");
      const handle = await open(file, "r");
      try {
        const parts: Array<{ PartNumber: number; ETag: string }> = [];
        for (let offset = 0, number = 1; offset < size; offset += putPartBytes, number++) {
          const length = Math.min(putPartBytes, size - offset);
          const body = Buffer.alloc(length);
          await handle.read(body, 0, length, offset);
          const part = await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: body, ContentLength: length }), { abortSignal: signal });
          if (!part.ETag) throw new Error(`Object store returned no ETag for part ${number}`);
          parts.push({ PartNumber: number, ETag: part.ETag });
        }
        await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }), { abortSignal: signal });
        return size;
      } catch (error) {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
    },
    playback(key: string) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
    },
  };
}