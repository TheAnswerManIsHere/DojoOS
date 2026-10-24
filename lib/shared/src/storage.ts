import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const prefixes = { originals: "originals/", proxies: "proxies/", renders: "renders/" } as const;
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
    /** Uploads one local file from the worker, streamed: the SDK's uploader picks a single put or a multipart
     * upload (a single put is capped at 5 GB, which a long proxy can pass), sends parts in parallel, and aborts a
     * failed multipart upload so no orphaned parts are billed. */
    async put(key: string, file: string, contentType: string, signal?: AbortSignal) {
      await new Upload({ client, params: { Bucket: bucket, Key: key, Body: createReadStream(file), ContentType: contentType },
        partSize: 64 * 1024 * 1024, queueSize: 4, abortController: signal ? abortControllerFor(signal) : undefined }).done();
    },
    /** One small object's body as text, for a derivative the server relays (the peaks file). */
    async readText(key: string) {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return object.Body!.transformToString();
    },
    playback(key: string) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
    },
  };
}

/** lib-storage takes an AbortController rather than a signal; this one follows the caller's signal. */
function abortControllerFor(signal: AbortSignal) {
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
}
