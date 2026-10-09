import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { register } from 'node:module';
import { createHash } from 'node:crypto';
register(new URL('./css-loader.mjs', import.meta.url));
const root=fileURLToPath(new URL('../../../remoa-frontend',import.meta.url));
const inputFile=resolve(process.argv[2]);
const outputFile=process.argv[3] ? resolve(process.argv[3]) : null;
const manifestFile=process.argv[4] ? resolve(process.argv[4]) : null;
const {JSDOM}=await import(`${root}/apps/web/node_modules/jsdom/lib/api.js`);
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://remoa.com.br'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,DOMParser:dom.window.DOMParser,getComputedStyle:dom.window.getComputedStyle});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const {Editor}=await import(`${root}/apps/web/node_modules/@tiptap/core/dist/index.js`);
globalThis.React=await import(`${root}/apps/web/node_modules/react/index.js`);
const {blogExtensions}=await import(`${root}/apps/web/src/features/admin/blog/editor/extensions.tsx`);
const {blogDocSchema,countWords,seoChecklist,blogPostInputSchema}=await import(`${root}/packages/contracts/src/blog.ts`);
const packageBytes=await readFile(inputFile);
const input=JSON.parse(packageBytes.toString('utf8'));
const results=[];
for(const p of input.posts){
 const htmlFileBytes=await readFile(p.copyFile);
 const sourceDom=new JSDOM(htmlFileBytes.toString('utf8'),{url:pathToFileURL(p.copyFile).href});
 if(sourceDom.window.document.querySelector('base')?.getAttribute('href')!=='https://remoa.com.br/' || p.copyBaseUrl!=='https://remoa.com.br/') throw new Error(`Copy base missing: ${p.slug}`);
 const anchors=[...sourceDom.window.document.querySelectorAll('a[href]')];
 for(const anchor of anchors) {
   if(anchor.href.startsWith('file:')) throw new Error(`File URL in copy document: ${p.slug}`);
   // Model native rich-HTML clipboard URL resolution: browsers copy resolved anchor URLs.
   anchor.setAttribute('href',anchor.href);
 }
 const editor=new Editor({element:document.createElement('div'),extensions:blogExtensions(),content:sourceDom.window.document.body.innerHTML});
 const parsed=blogDocSchema.parse(editor.getJSON());
 const expected=blogDocSchema.parse(p.content);
 const normalize=(raw:any):any=>{
   if(Array.isArray(raw)) return raw.map(normalize);
   if(!raw || typeof raw!=='object') return raw;
   let x=raw;
   if(x.type==='link'&&typeof x.attrs?.href==='string') {
     try {
       const url=new URL(x.attrs.href);
       if(url.origin==='https://remoa.com.br'&&!url.username&&!url.password) x={...x,attrs:{...x.attrs,href:url.pathname+url.search+url.hash}};
     } catch { /* Relative links remain unchanged; file/http/other origins never become equivalent. */ }
   }
   return Object.fromEntries(Object.entries(x).filter(([k,v])=>k!=='external'&&v!=null&&!(k==='start'&&v===1)).map(([k,v])=>[k,normalize(v)]).filter(([k,v])=>!(k==='attrs'&&v&&typeof v==='object'&&Object.keys(v).length===0)).sort(([a],[b])=>String(a).localeCompare(String(b))));
 };
 const clean=(d:any)=>normalize({...d,content:d.content.filter((n:any)=>!(n.type==='paragraph'&&(!n.content||n.content.length===0)))});
 if(JSON.stringify(clean(parsed))!==JSON.stringify(clean(expected))) {throw new Error(`Roundtrip differs: ${p.slug}`)};
 const subject=blogPostInputSchema.parse({...p,coverAssetId:'00000000-0000-4000-8000-000000000001'});
 const seo=seoChecklist(subject as any);
 const image=await readFile(p.coverAbsolutePath);
 results.push({index:p.index,slug:p.slug,roundtrip:true,clipboardResolutionSimulation:true,copyBaseUrl:p.copyBaseUrl,anchorCount:anchors.length,wordCount:countWords(parsed),seoScore:seo.score,blocksPublish:seo.blocksPublish,publishAt:p.publishAt,coverAlt:p.coverAlt,imageBytes:image.length,imageSha256:createHash('sha256').update(image).digest('hex'),htmlSha256:createHash('sha256').update(p.contentHtml).digest('hex'),copyFileSha256:createHash('sha256').update(htmlFileBytes).digest('hex')});
 console.log(p.slug,'roundtrip pass',countWords(parsed));
 editor.destroy();
 sourceDom.window.close();
}

const evidence={validatedAt:new Date().toISOString(),mode:'offline; no API calls or browser control',roundtrip:'real frontend blogExtensions + @tiptap/core + jsdom; file HTML read with production base and clipboard-resolved absolute anchors; schema-parsed document semantically identical',normalizedDefaults:['external href hint','rel:null','orderedList.start:1','empty attrs','empty trailing paragraph','link marks only: exact HTTPS remoa.com.br origin → pathname+search+hash; other origins/protocols remain distinct'],posts:results.length,allRoundtripsPass:results.every(p=>p.roundtrip),allSeo100:results.every(p=>p.seoScore===100&&!p.blocksPublish),packageSha256:createHash('sha256').update(packageBytes).digest('hex'),manifestSha256:manifestFile?createHash('sha256').update(await readFile(manifestFile)).digest('hex'):null,results};
if(outputFile)await writeFile(outputFile,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({posts:results.length,allRoundtripsPass:evidence.allRoundtripsPass,allSeo100:evidence.allSeo100,evidence:outputFile}));
