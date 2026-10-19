import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCanonicalBase64, decodeFiles, pins } from './domain';
describe('bounded canonical asset base64',()=>{
 it('decodes an 8,537,207-byte asset without recursive regex stack exhaustion',()=>{
  const original=Buffer.alloc(8_537_207);for(let i=0;i<original.length;i++)original[i]=i%256;
  expect(decodeCanonicalBase64(original.toString('base64'),original.length).equals(original)).toBe(true);
 });
 it('rejects permissive decoder variants, altered padding and lengths',()=>{
  for(const [encoded,bytes] of [['AB==',1],['AA\n=',1],['____',3],['AAAA',1],['AA=',1],['A===',1],['!!!!',3],['AAAA=',3]] as const)expect(()=>decodeCanonicalBase64(encoded,bytes)).toThrow('team_asset_hash_mismatch');
  expect(()=>decodeCanonicalBase64('AAAA',50*1024*1024+1)).toThrow('team_asset_hash_mismatch');
  for(const bytes of [1,2,3,4,5,6]){const original=Buffer.alloc(bytes,255);expect(decodeCanonicalBase64(original.toString('base64'),bytes)).toEqual(original);}
 });
 it.skipIf(!process.env.G29_TEAM_TEST_ORIGINALS)('decodes all 2,108 actual pinned files one at a time with exact bytes and SHA',()=>{
  const root=process.env.G29_TEAM_TEST_ORIGINALS!;let count=0,total=0;
  for(const pin of pins.files){const original=readFileSync(resolve(root,pin.path));const [decoded]=decodeFiles([{path:pin.path,base64:original.toString('base64')}]);expect(decoded!.body.equals(original)).toBe(true);count++;total+=original.length;}
  expect(count).toBe(2108);expect(total).toBe(773933652);
 },120000);
});
