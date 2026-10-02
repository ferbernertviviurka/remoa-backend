import {
  CreateBucketCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// D-047: one S3 client. Production = Cloudflare R2, local = Supabase Storage's S3 endpoint.
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

let cached: S3Client | undefined;
const client = () =>
  (cached ??= new S3Client({
    endpoint: env('S3_ENDPOINT'),
    region: env('S3_REGION'),
    credentials: { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') },
    forcePathStyle: true,
  }));
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

export const deleteObject = (Key: string) => client().send(new DeleteObjectCommand({ Bucket: Bucket(), Key }));

/** Deletes every object under `Prefix` (account purge, F08). Returns how many were removed. */
export async function deletePrefix(Prefix: string) {
  let n = 0;
  for (let token: string | undefined; ; ) {
    const page = await client().send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix, ContinuationToken: token }));
    const Objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (Objects.length) await client().send(new DeleteObjectsCommand({ Bucket: Bucket(), Delete: { Objects } }));
    n += Objects.length;
    token = page.NextContinuationToken;
    if (!token) return n;
  }
}
