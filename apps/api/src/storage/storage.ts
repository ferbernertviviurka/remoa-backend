import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateBucketCommand, CreateMultipartUploadCommand, UploadPartCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { env as configEnv } from '@remoa/config';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { timeExternal } from '../perf';

// D-047: one S3 client. Production = Cloudflare R2, local = Supabase Storage's S3 endpoint.
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

let cached: S3Client | undefined;
const client = () =>
  (cached ??= timed(new S3Client({
    endpoint: env('S3_ENDPOINT'),
    region: env('S3_REGION'),
    credentials: { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') },
    // Supabase Storage needs path-style; Railway buckets (new ones) only accept virtual-hosted (S3_URL_STYLE=virtual).
    forcePathStyle: process.env.S3_URL_STYLE !== 'virtual',
  })));
// G21/F29 FR-3: R2/S3 time in Server-Timing `ext` (the SDK uses node http, not fetch).
const timed = (c: S3Client) => {
  c.middlewareStack.add((next) => (args) => timeExternal('r2', () => next(args)), { step: 'finalizeRequest', name: 'remoaPerf' });
  return c;
};
const Bucket = () => env('S3_BUCKET');

/** Idempotent. Buckets are private by default on both R2 and Supabase Storage. */
export async function ensureBucket() {
  try {
    await client().send(new CreateBucketCommand({ Bucket: Bucket() }));
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (!/AlreadyOwnedByYou|AlreadyExists/.test(name) && status !== 409) throw e;
  }
}

export const presignPut = (Key: string, ContentType: string, ContentLength: number) =>
  getSignedUrl(client(), new PutObjectCommand({ Bucket: Bucket(), Key, ContentType, ContentLength }), { expiresIn: 600 });

export const presignGet = (Key: string) => getSignedUrl(client(), new GetObjectCommand({ Bucket: Bucket(), Key }), { expiresIn: 3600 });

/** null when the object does not exist. */
export async function headObject(Key: string) {
  try {
    const r = await client().send(new HeadObjectCommand({ Bucket: Bucket(), Key }));
    return { size: r.ContentLength ?? 0, mime: r.ContentType ?? '' };
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function getBytes(Key: string) {
  const r = await client().send(new GetObjectCommand({ Bucket: Bucket(), Key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

export const putBytes = (Key: string, Body: Buffer, ContentType: string) =>
  client().send(new PutObjectCommand({ Bucket: Bucket(), Key, Body, ContentType }));

const PART = 8 * 1024 * 1024;
/** D-1443: streams `body` to `Key` holding at most one 8 MB part in memory (S3 multipart; one PutObject when it fits in a part).
 * If `body` throws (size cap, bad type, client gone), the multipart upload is aborted and the error rethrown: nothing stays in the bucket. */
export async function putStream(Key: string, body: AsyncIterable<Uint8Array>, ContentType: string) {
  let buf: Uint8Array[] = [], len = 0, UploadId: string | undefined;
  const Parts: { ETag?: string; PartNumber: number }[] = [];
  const flush = async () => {
    UploadId ??= (await client().send(new CreateMultipartUploadCommand({ Bucket: Bucket(), Key, ContentType }))).UploadId!;
    const PartNumber = Parts.length + 1;
    const { ETag } = await client().send(new UploadPartCommand({ Bucket: Bucket(), Key, UploadId, PartNumber, Body: Buffer.concat(buf) }));
    Parts.push({ ETag, PartNumber });
    buf = [];
    len = 0;
  };
  try {
    for await (const chunk of body) {
      buf.push(chunk);
      len += chunk.byteLength;
      if (len >= PART) await flush();
    }
    if (!UploadId) return void (await putBytes(Key, Buffer.concat(buf), ContentType));
    if (len) await flush();
    await client().send(new CompleteMultipartUploadCommand({ Bucket: Bucket(), Key, UploadId, MultipartUpload: { Parts } }));
  } catch (e) {
    if (UploadId) await client().send(new AbortMultipartUploadCommand({ Bucket: Bucket(), Key, UploadId })).catch(() => undefined);
    throw e;
  }
}

export const deleteObject = (Key: string) => client().send(new DeleteObjectCommand({ Bucket: Bucket(), Key }));

/** Server-side copy inside the bucket (F17 copy from a shared link: the new owner gets independent objects). */
export const copyObject = (from: string, Key: string) =>
  client().send(new CopyObjectCommand({ Bucket: Bucket(), Key, CopySource: `${Bucket()}/${from.split('/').map(encodeURIComponent).join('/')}` }));

/** Deletes every object under `Prefix` (account purge, F08; blog cleanup in the public bucket, F27). Returns how many were removed. */
export async function deletePrefix(Prefix: string, Bucket_ = Bucket()) {
  let n = 0;
  for (let token: string | undefined; ; ) {
    const page = await client().send(new ListObjectsV2Command({ Bucket: Bucket_, Prefix, ContinuationToken: token }));
    const Objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (Objects.length) await client().send(new DeleteObjectsCommand({ Bucket: Bucket_, Delete: { Objects } }));
    n += Objects.length;
    token = page.NextContinuationToken;
    if (!token) return n;
  }
}

/** G19 F27 (D-914): blog images go to S3_PUBLIC_BUCKET (may be the private bucket), served by R2_PUBLIC_BASE_URL. Immutable: keys carry the asset id. */
export const putPublicBytes = (Key: string, Body: Buffer, ContentType: string) =>
  client().send(new PutObjectCommand({ Bucket: configEnv().s3PublicBucket, Key, Body, ContentType, CacheControl: 'public, max-age=31536000, immutable' }));

/** Blog image bytes for the API proxy (`/v1/public/blog/files/*`); null when missing. */
export async function getPublicObject(Key: string) {
  try {
    const r = await client().send(new GetObjectCommand({ Bucket: configEnv().s3PublicBucket, Key }));
    return { body: Buffer.from(await r.Body!.transformToByteArray()), mime: r.ContentType ?? 'application/octet-stream' };
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}
