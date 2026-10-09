/** F27: audited admin API importer. No database access, service-role auth or automatic retries. */
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { blogPostCreateInputSchema, blogPostInputSchema, blogScheduleInputSchema, publishBlockers, seoChecklist } from '../../packages/contracts/src/blog';

type Item = Record<string, any> & { slug: string; categorySlug: string; coverPath: string; publishAt: string };
type Entry = { id?: string; assetId?: string; imageHash?: string; pending?: string; scheduled?: string };
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const input = args.find((x) => !x.startsWith('--'));
if (!input) throw new Error('Usage: pnpm --filter @remoa/api exec node --import tsx ../../scripts/blog-campaign/import.mts /absolute/manifest.json [--apply]');
const file = resolve(input);
const manifest = JSON.parse(await readFile(file, 'utf8'));
const posts: Item[] = Array.isArray(manifest) ? manifest : manifest.posts;
if (!Array.isArray(posts) || !posts.length) throw new Error('Manifest must contain posts[]');
const statePath = `${file}.import-state.json`;
let state: Record<string, Entry> = {};
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
const base = process.env.BLOG_ADMIN_API_URL ?? 'https://backend.remoa.com.br';
const apiUrl = new URL(base);
if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password || apiUrl.pathname !== '/') throw new Error('API must be an HTTPS origin');
if (apply && apiUrl.hostname !== 'backend.remoa.com.br') throw new Error('Production importer accepts only backend.remoa.com.br');
const token = process.env.BLOG_ADMIN_ACCESS_TOKEN;
if (apply && !token) throw new Error('Existing admin session token required in BLOG_ADMIN_ACCESS_TOKEN; never use service-role credentials');
const unique = new Set<string>();
const coverData = new Map<string, { bytes: Buffer; hash: string; path: string }>();
function payload(item: Item, categoryId: string | null, coverAssetId: string | null) {
  const fields = ['title','seoTitle','description','excerpt','slug','template','coverAlt','focusKeyword','robots','canonicalUrl','content'];
  return blogPostInputSchema.parse({ ...Object.fromEntries(fields.filter(k => k in item).map(k => [k, item[k]])), categoryId, coverAssetId, authorId: null });
}
for (const p of posts) {
  if (unique.has(p.slug)) throw new Error(`Duplicate slug ${p.slug}`);
  unique.add(p.slug);
  blogPostCreateInputSchema.parse(p);
  blogScheduleInputSchema.parse({ publishAt: p.publishAt });
  if (Date.parse(p.publishAt) <= Date.now() && !state[p.slug]?.scheduled) throw new Error(`Schedule is past: ${p.slug}`);
  if (!p.categorySlug) throw new Error(`categorySlug missing: ${p.slug}`);
  const img = resolve(dirname(file), p.coverPath);
  const info = await stat(img);
  if (info.size > 5 * 1024 * 1024 || !['.png','.jpg','.jpeg','.webp'].includes(extname(img).toLowerCase())) throw new Error(`Invalid cover: ${p.slug}`);
  const bytes = await readFile(img);
  coverData.set(p.slug, { bytes, hash: createHash('sha256').update(bytes).digest('hex'), path: img });
  const val = payload(p, null, '00000000-0000-4000-8000-000000000001');
  const blockers = publishBlockers(val as any);
  if (blockers.length) throw new Error(`Publish blocked for ${p.slug}: ${JSON.stringify(blockers)}`);
  const checks = seoChecklist(val as any);
  console.log(JSON.stringify({slug:p.slug,publishAt:p.publishAt,seo:checks}));
}
if (!apply) {
  console.log(`Validated ${posts.length} posts. Dry run: no requests or writes. --apply uses the existing admin session and audited API.`);
  process.exit(0);
}
async function save() {
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, statePath);
}
async function api(path: string, method = 'GET', body?: object | FormData) {
  const headers: Record<string,string> = { authorization: `Bearer ${token}` };
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(`/v1/admin/blog${path}`, apiUrl), { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Admin API failed ${method} ${path}: ${response.status} ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
  return result.data;
}
const categories = await api('/categories'); // requires admin before any mutation
const categoryIds = new Map(categories.map((c: any) => [c.slug, c.id]));
for (const p of posts) if (!categoryIds.has(p.categorySlug)) throw new Error(`Category absent: ${p.categorySlug}`);
const existing = [];
for (let page = 1; ; page++) {
  const data = await api(`/posts?status=all&pageSize=100&page=${page}`);
  existing.push(...data.items);
  if (existing.length >= data.total) break;
}
for (const p of posts) {
  const entry = state[p.slug] ?? (state[p.slug] = {});
  if (entry.pending) throw new Error(`Uncertain prior operation ${entry.pending} for ${p.slug}; inspect admin/audit and reconcile state before resuming. No retry performed.`);
  if (!entry.id && existing.some((x: any) => x.slug === p.slug || x.title === p.title)) throw new Error(`Existing post collision ${p.slug}; refusing to adopt or duplicate`);
}
for (const p of posts) {
  const entry = state[p.slug];
  const image = coverData.get(p.slug)!;
  async function mutate(operation: string, path: string, method: string, body?: object | FormData) {
    entry.pending = operation;
    await save();
    const value = await api(path, method, body); // ambiguous transport errors intentionally leave pending
    delete entry.pending;
    return value;
  }
  if (!entry.id) {
    const result = await mutate('create', '/posts', 'POST', blogPostCreateInputSchema.parse(p));
    entry.id = result.post.id;
    await save();
  }
  let current = (await api(`/posts/${entry.id}`));
  if (current.slug !== p.slug && current.title !== p.title) throw new Error(`State points to another post: ${p.slug}`);
  if (current.status === 'published') {
    if (entry.scheduled && current.slug === p.slug && current.publishedAt === p.publishAt) { console.log(`Already published ${p.slug}`); continue; }
    throw new Error(`Refusing to edit published post ${p.slug}`);
  }
  if (!['draft','scheduled'].includes(current.status)) throw new Error(`Refusing status ${current.status}: ${p.slug}`);
  if (!entry.assetId || entry.imageHash !== image.hash) {
    const form = new FormData();
    form.set('slug', p.slug);
    form.set('file', new Blob([new Uint8Array(image.bytes)]), image.path.split('/').at(-1)!);
    const result = await mutate('upload', '/images', 'POST', form);
    entry.assetId = result.asset.id;
    entry.imageHash = image.hash;
    await save();
  }
  const desired = payload(p, categoryIds.get(p.categorySlug) as string, entry.assetId!);
  const actual = { ...current, categoryId:current.category?.id ?? null,coverAssetId:current.cover?.id ?? null,authorId:current.author?.id ?? null };
  const patch = Object.fromEntries(Object.entries(desired).filter(([key,value]) => JSON.stringify(actual[key]) !== JSON.stringify(value)));
  if (Object.keys(patch).length) {
    current = (await mutate('update', `/posts/${entry.id}`, 'PATCH', patch)).post;
    await save();
  }
  if (current.status !== 'scheduled' || Date.parse(current.publishAt) !== Date.parse(p.publishAt)) {
    current = (await mutate('schedule', `/posts/${entry.id}/schedule`, 'POST', { publishAt:p.publishAt })).post;
    entry.scheduled = current.publishAt;
    await save();
  }
  const verified = await api(`/posts/${entry.id}`);
  if (verified.status !== 'scheduled' || Date.parse(verified.publishAt) !== Date.parse(p.publishAt) || verified.slug !== p.slug || verified.cover?.id !== entry.assetId) throw new Error(`Readback mismatch ${p.slug}`);
  console.log(JSON.stringify({slug:p.slug,id:entry.id,status:verified.status,publishAt:verified.publishAt,wordCount:verified.wordCount,cover:verified.cover.url}));
}
console.log(`Verified ${posts.length} scheduled posts; scheduler runtime must be verified separately.`);
