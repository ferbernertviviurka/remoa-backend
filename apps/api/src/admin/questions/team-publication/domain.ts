import { createHash } from 'node:crypto';
import pins from './pins.json';
import { contentHash } from '../../../questions/imports/domain';

export const NAMESPACE = 'g29-cp21-20261019';
export const CORPUS_HASH = '0616493c0f337e4edb1a8f698cacd40dbe1466933eeba5256a65cf073d9c8d2e';
export const MANIFEST_HASH = 'f3d40e71a86c071b2792e49bb09e1f3030b9aaf3ca66e94a94cba1055a0afc63';
export const MEMBERSHIP_HASH = 'a6e42dd838112d7c3e74de2b58f9a6f65644b7242c5494553de4756abeba2ba8';
export const ATTESTATION = 'Publique todas. Todas foram validadas pelo time da Remoa.';
export const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export const fixedId = (s: string) => { const h = hash(`${NAMESPACE}:${s}`); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
export const files = new Map(pins.files.map(f => [f.path, f]));
export const objectKey = (sha: string) => `questions/team-publication/${NAMESPACE}/sha256/${sha}`;
type Json = Record<string, unknown>;
export const record = (x: unknown): Json => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Json : {};
const text = (x: unknown) => typeof x === 'string' ? x : '';
const courses: Record<string,string> = {'medicina':'medicine','enfermagem':'nursing','odontologia':'dentistry','farmacia':'pharmacy','nutricao':'nutrition','psicologia':'psychology','fisioterapia':'physiotherapy','biomedicina':'biomedicine','educacao-fisica':'physical_education','medicina-veterinaria':'veterinary_medicine'};
export type Wrapper = {offlineId:string;payloadSha256:string;sourceLineSha256:string;flags:string[];payload:Json};
/** Raw batch SHA authenticates every byte, including Python's exact float serialization and original flags. */
export function parseBatch(index: number, raw: string): Wrapper[] {
  const pin = pins.batches[index-1];
  if (!pin || hash(raw)!==pin.sha256 || Buffer.byteLength(raw)!==pin.bytes) throw Error('team_batch_hash_mismatch');
  const rows = raw.trimEnd().split('\n').map(line => JSON.parse(line) as Wrapper);
  if (rows.length!==pin.registros || rows.length>200 || new Set(rows.map(r=>r.offlineId)).size!==rows.length) throw Error('team_batch_count_mismatch');
  for (const r of rows) if(r.offlineId!==r.payload.id || !/^[a-f0-9]{64}$/.test(r.payloadSha256) || !/^[a-f0-9]{64}$/.test(r.sourceLineSha256)) throw Error('team_invalid_wrapper');
  return rows;
}
/** Offline nivel is confidence, never clinical difficulty. Use the existing neutral default. */
export function project(r: Wrapper) {
  const p=r.payload, source=record(p.fonte), sourceCode=text(source.source_id)||JSON.stringify([source.orgao??'',source.url??'',p.exame,p.edicao,p.curso]);
  // Two explicit research mirrors are named literally in these pinned legacy payloads.
  // They are acquisition links, never official publisher URLs or licensing evidence.
  const mirrors:Record<string,string>={
    'github.com/adonias-caetano/LLMs-revalida-medicina (planilhas de pesquisa; sem licença declarada)':'https://github.com/adonias-caetano/LLMs-revalida-medicina',
    'github.com/LarissaCastor/Sistema_Estudo_Questoes_Enade (sem licença declarada)':'https://github.com/LarissaCastor/Sistema_Estudo_Questoes_Enade',
  };
  const officialUrl=text(source.url)||text(source.prova_url),mirror=officialUrl?'':mirrors[text(source.obtido_via)];
  const sourceUrl=officialUrl||mirror;if(!sourceUrl)throw Error('team_source_url_missing');
  const sourceId=fixedId(`source:${sourceCode}`), questionId=fixedId(`question:${r.offlineId}`), itemId=fixedId(`item:${r.offlineId}`);
  const flags:string[]=[];
  if(p.anulada===true)flags.push('annulled');
  if(p.conflito_gabarito)flags.push('key_conflict');
  if(p.depende_de_imagem===true && (!Array.isArray(p.imagens)||!p.imagens.length))flags.push('image_missing');
  if(r.flags.includes('cabecalho_preliminar_link_definitivo'))flags.push('key_finality_unverified');
  const alternatives=Object.entries(record(p.alternativas)).map(([key,value])=>({key,text:text(value)}));
  if(alternatives.length<2 || alternatives.some(a=>!a.text || !/^[A-J]$/.test(a.key))) throw Error('team_invalid_alternatives');
  const annulled=p.anulada===true, correctKey=annulled?null:text(p.gabarito);
  if(!annulled&&!alternatives.some(a=>a.key===correctKey))throw Error('team_invalid_key');
  const profession=courses[text(p.curso)]; if(!profession)throw Error('team_unknown_profession');
  const assets=(Array.isArray(p.imagens)?p.imagens:[]).map((path:unknown,i:number)=>{
    const file=files.get(text(path));if(!file)throw Error('team_asset_not_pinned');
    return {id:fixedId(`asset:${r.offlineId}:${i}`),objectKey:objectKey(file.sha256),alt:`Figura original da questão ${String(p.numero)} (${i+1})`,provenance:null};
  });
  const availability=annulled?'annulled':flags.some(f=>f==='key_conflict'||f==='image_missing')?'unavailable':'active';
  const content={stem:text(p.enunciado),alternatives,correctKey,explanation:null,areaId:null,topicId:null,annulled,assets};
  if(!content.stem)throw Error('team_invalid_stem');
  const projectedHash=contentHash(content);
  const scopeHash=hash(JSON.stringify({namespace:NAMESPACE,itemId,offlineId:r.offlineId,payloadHash:r.payloadSha256,sourceId,origin:'official_exam',profession,language:'pt-BR',contentHash:projectedHash,availability,flags,rights:'pending',disclosure:1}));
  return {...content,questionId,itemId,sourceId,source,profession,availability,flags,contentHash:projectedHash,scopeHash,sourceName:(text(source.orgao)||text(p.exame)||'Prova oficial')+(mirror?' — espelho de pesquisa':''),sourcePublisher:text(source.banca)||text(source.orgao)||text(p.exame),sourceUrl,difficulty:'medium',paths:[...new Set([...(Array.isArray(p.imagens)?p.imagens.map(text):[]),text(source.prova_arquivo),text(source.gabarito_arquivo),...(Array.isArray(source.recortes)?source.recortes.map(c=>text(record(c).arquivo)):[])].filter(Boolean))]};
}
export function decodeFiles(input: {path:string;base64:string}[]) {
  let bytes=0; const seen=new Set<string>();
  return input.map(f=>{
    const pin=files.get(f.path); if(!pin||seen.has(f.path)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.base64))throw Error('team_asset_not_pinned');
    seen.add(f.path); const body=Buffer.from(f.base64,'base64'); bytes+=body.length;
    if(bytes>50*1024*1024 || body.length!==pin.bytes || hash(body)!==pin.sha256)throw Error('team_asset_hash_mismatch');
    return {...pin,body,key:objectKey(pin.sha256),mime:f.path.endsWith('.pdf')?'application/pdf':/\.jpe?g$/i.test(f.path)?'image/jpeg':'image/png'};
  });
}
export { pins };
