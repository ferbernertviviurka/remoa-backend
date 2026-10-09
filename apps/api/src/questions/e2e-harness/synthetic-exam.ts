import {deflateSync} from 'node:zlib';

/** Isolated QA fixture: vector shapes without a figure keyword in the text. */
export function syntheticExamPdf():Uint8Array {
 const stream=deflateSync(Buffer.from(String.raw`BT /F1 12 Tf 50 700 Td (Questao 1) Tj 0 -20 Td (Enunciado sintetico nao medico sobre formas) Tj 0 -20 Td (A\) Primeira forma sintetica) Tj 0 -20 Td (B\) Segunda forma sintetica) Tj ET q 0 0 0 RG 2 w 50 540 40 40 re S 130 540 m 150 580 l 170 540 l h S Q`, 'latin1'));
 const objects=[Buffer.from('<</Type/Catalog/Pages 2 0 R>>'),Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>'),Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>'),Buffer.concat([Buffer.from(`<</Length ${stream.length}/Filter/FlateDecode>>stream\n`),stream,Buffer.from('\nendstream')]),Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>')];
 const parts=[Buffer.from('%PDF-1.4\n')];let size=parts[0]!.length;const offsets:number[]=[];
 for(const[ordinal,object]of objects.entries()){offsets.push(size);const part=Buffer.concat([Buffer.from(`${ordinal+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);parts.push(part);size+=part.length;}
 parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer<</Size ${objects.length+1}/Root 1 0 R>>\nstartxref\n${size}\n%%EOF\n`));
 return new Uint8Array(Buffer.concat(parts));
}
