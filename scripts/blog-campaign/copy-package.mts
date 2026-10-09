/** Render editor-compatible clipboard HTML without controlling any browser. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { blogDocSchema, type BlogDoc } from '../../packages/contracts/src/blog';
const file = resolve(process.argv[2]);
const data = JSON.parse(await readFile(file, 'utf8'));
const posts = Array.isArray(data) ? data : data.posts;
const out = resolve(process.argv[3] ?? join(dirname(file), 'copy-package'));
await mkdir(out, { recursive:true });
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function node(n: any): string {
  const children = () => (n.content ?? []).map(node).join('');
  if (n.type === 'text') {
    let s = esc(n.text);
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') s = `<strong>${s}</strong>`;
      if (m.type === 'italic') s = `<em>${s}</em>`;
      if (m.type === 'link') s = `<a href="${esc(m.attrs.href)}"${m.attrs.rel ? ` rel="${esc(m.attrs.rel)}"` : ''}>${s}</a>`;
    }
    return s;
  }
  const tags: Record<string,string> = {paragraph:'p',bulletList:'ul',orderedList:'ol',listItem:'li',blockquote:'blockquote',doc:'article'};
  if (n.type === 'heading') return `<h${n.attrs.level}>${children()}</h${n.attrs.level}>`;
  if (n.type === 'faq') return `<div data-blog-faq="" data-items="${esc(JSON.stringify(n.attrs.items))}">${n.attrs.items.map((i:any) => `<h3>${esc(i.q)}</h3><p>${esc(i.a)}</p>`).join('')}</div>`;
  if (n.type === 'button') return `<div data-blog-button="" data-text="${esc(n.attrs.text)}" data-href="${esc(n.attrs.href)}"><a href="${esc(n.attrs.href)}">${esc(n.attrs.text)}</a></div>`;
  if (n.type === 'callout') return `<div data-callout="" data-variant="${esc(n.attrs.variant)}">${children()}</div>`;
  if (n.type === 'image') return `<div data-blog-image="" ${Object.entries(n.attrs).filter(([,v])=>v!=null).map(([k,v])=>`data-${k.toLowerCase()}="${esc(v)}"`).join(' ')}><p>${esc(n.attrs.alt)}</p></div>`;
  const tag = tags[n.type];
  if (!tag) throw new Error(`Unsupported node ${n.type}`);
  return `<${tag}${n.type==='orderedList' && n.attrs?.start ? ` start="${esc(n.attrs.start)}"` : ''}>${children()}</${tag}>`;
}
const ready = [];
for (const p of posts) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug)) throw new Error('Unsafe slug');
  const doc: BlogDoc = blogDocSchema.parse(p.content);
  const contentHtml = node(doc);
  const path = join(out, `${p.slug}.html`);
  // The visible document contains only body content: Cmd+A/Copy cannot accidentally include admin metadata in the post.
  await writeFile(path, `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><base href="https://remoa.com.br/"><title>${esc(p.title)}</title><style>body{font:18px/1.7 system-ui;max-width:850px;margin:32px auto;padding:20px}h2{margin-top:36px}a{color:#6149cb}</style></head><body>${contentHtml}</body></html>\n`);
  const local = new Date(p.publishAt);
  ready.push({ ...p, contentHtml, copyBaseUrl:'https://remoa.com.br/', copyFile:path, coverAbsolutePath:resolve(dirname(file),p.coverPath), scheduleBrasilia:local.toLocaleString('sv-SE',{timeZone:'America/Sao_Paulo'}), content:doc });
}
await writeFile(join(out,'cua-package.json'),JSON.stringify({posts:ready},null,2)+'\n');
console.log(JSON.stringify({posts:ready.length,directory:out,package:join(out,'cua-package.json')}));
