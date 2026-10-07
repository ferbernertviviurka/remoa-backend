// FR-26 `content:dossier`: the physician reviewer's document, one self-contained printable HTML (+ PDF when a Chrome/Chromium is
// found) per map, every card in trail order with its evidence, verifier verdict and Aprovo / Ajustar / Rejeitar boxes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CardFile, VerifyResult } from '@remoa/contracts';
import { formatIssues, hasErrors, lintBundle } from './lint';
import { loadBundle, type Bundle } from './load';
import { currentVerdicts } from './verify';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Markdown leftovers in FONTES.md cells (`**x**`, `` `x` ``) are dropped, the rest is escaped text. */
const cell = (s: string) => esc(s.replace(/\*\*|`/g, ''));

/** First markdown table of FONTES.md ("Fontes lidas") as an HTML table; the raw file is not needed by the reviewer. */
export function sourcesTable(md: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|'));
  if (start < 0) return '<p class="falta">FONTES.md sem tabela de fontes.</p>';
  const rows = [];
  for (let i = start; i < lines.length && lines[i]!.trim().startsWith('|'); i++) rows.push(lines[i]!.trim().slice(1, -1).split('|').map((c) => c.trim()));
  const [head = [], , ...body] = rows;
  return `<table class="fontes"><thead><tr>${head.map((h) => `<th>${cell(h)}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

const RISK: Record<CardFile['risco'], string> = { nenhum: '', dose: 'DOSE: conferir número, unidade e via (revisão dupla)', conduta: 'CONDUTA: conferir indicação e ordem' };
const VERDICT: Record<VerifyResult['veredito'], string> = { sustenta: 'Sustenta', parcial: 'Parcial', contradiz: 'Contradiz' };
const field = (label: string, value: string | undefined, cls = '') => (value ? `<div class="campo ${cls}"><span class="rot">${label}</span><div class="txt">${esc(value)}</div></div>` : '');

function imageTag(b: Bundle, c: Extract<CardFile, { tipo: 'imagem' }>): string {
  const file = c.imagem.arquivo.replace(/^imagens\//, '');
  const path = join(b.dir, 'imagens', file);
  if (!existsSync(path)) return '<p class="falta">imagem ausente</p>';
  const ext = file.split('.').pop()!;
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  // <img> with a data: URI: an SVG shown this way never runs scripts, and the file stays self-contained.
  return `<img src="data:${mime};base64,${readFileSync(path).toString('base64')}" alt="${esc(c.imagem.alt)}">`;
}

function body(b: Bundle, c: CardFile): string {
  switch (c.tipo) {
    case 'conceito':
      return field('Frente', c.frente) + field('Verso', c.verso);
    case 'fluxograma':
      return `${field('Frente', c.frente)}<div class="campo"><span class="rot">Passos</span><ol>${c.passos.map((p) => `<li>${esc(p.texto)}</li>`).join('')}</ol></div>`;
    case 'imagem': {
      const credit = c.imagem.credito ?? b.credits?.get(c.imagem.arquivo.replace(/^imagens\//, ''))?.credito;
      return `${field('Frente', c.frente)}<figure>${imageTag(b, c)}<figcaption>${esc(c.imagem.alt)}${credit ? ` · Crédito: ${esc(credit)}` : ''} · Licença: ${esc(c.imagem.licenca)}</figcaption></figure>`
        + field('Rótulos ocultos', c.imagem.mascaras.map((m) => m.rotulo).join(' · '));
    }
    case 'caso':
      return field('Apresentação', c.caso.apresentacao) + field('Exames', c.caso.exames) + field('Diagnóstico', c.caso.diagnostico) + field('Conduta', c.caso.conduta);
  }
}

function cardHtml(b: Bundle, c: CardFile, verdict: VerifyResult | undefined): string {
  const ev = b.evidence.filter((e) => e.cardId === c.id);
  const name = `d-${c.id}`;
  return `<section class="card risco-${c.risco}" id="${esc(c.id)}">
<header><span class="ordem">#${c.ordem}</span> <strong>${esc(c.titulo)}</strong>
<span class="meta">${esc(c.id)} · ${esc(c.modulo)} · nível ${c.nivel} · ${esc(c.tipo)}${c.preRequisitos.length ? ` · pré-requisitos: ${esc(c.preRequisitos.join(', '))}` : ''}</span>
${c.risco !== 'nenhum' ? `<span class="badge ${c.risco}">${esc(RISK[c.risco])}</span>` : ''}</header>
${body(b, c)}
${field('Por quê', c.porQue)}
${c.macete ? field(`Macete (${c.macete.tipo})`, `${c.macete.texto}. ${c.macete.explicacao}`, 'alerta') : ''}
${field('Pegadinha', c.pegadinha)}
${c.naProva || c.naDiretriz ? `<div class="campo alerta"><span class="rot">Divergência prova × diretriz</span><div class="txt">Na prova: ${esc(c.naProva)}<br>Na diretriz (${esc(c.naDiretriz?.data)}): ${esc(c.naDiretriz?.texto)}</div></div>` : ''}
<div class="campo"><span class="rot">Fontes</span><ul>${c.fontes.map((f) => `<li>${esc(f.doc)}, ${esc(f.local)} (${esc(f.versao)}; acesso ${esc(f.acesso)})</li>`).join('')}</ul></div>
<div class="campo"><span class="rot">Evidências</span>${ev.length ? `<ul>${ev.map((e) => `<li><q>${esc(e.trecho)}</q> (${esc(e.doc)}, ${esc(e.local)})</li>`).join('')}</ul>` : '<p class="falta">sem evidência</p>'}</div>
<div class="campo verif ${verdict?.veredito ?? 'nada'}"><span class="rot">Verificação (IA, contra as evidências)</span><div class="txt">${verdict ? `<strong>${VERDICT[verdict.veredito]}</strong>: ${esc(verdict.motivo)}` : 'sem verificação para o texto atual'}</div></div>
<fieldset class="decisao"><legend>Decisão do revisor</legend>
<label><input type="checkbox" name="${esc(name)}" value="aprovo"> Aprovo</label>
<label><input type="checkbox" name="${esc(name)}" value="ajustar"> Ajustar</label>
<label><input type="checkbox" name="${esc(name)}" value="rejeitar"> Rejeitar</label>
<div class="nota">Nota: <span class="linha"></span></div></fieldset>
</section>`;
}

const CSS = `body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1626;background:#fff;margin:0 auto;max-width:900px;padding:24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:24px 0 8px}.aviso{border:1px solid #6b4fbb;padding:8px 12px;border-radius:6px}
table.fontes{border-collapse:collapse;width:100%;font-size:11px}table.fontes th,table.fontes td{border:1px solid #bbb;padding:4px;vertical-align:top;text-align:left;word-break:break-word}
.card{border:1px solid #bbb;border-radius:8px;padding:12px 14px;margin:14px 0;break-inside:avoid}.card header{margin-bottom:6px}
.ordem{color:#6b4fbb;font-weight:700}.meta{display:block;color:#555;font-size:12px}
.badge{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:700}
.badge.dose{background:#fde2e2;color:#8a1010;border:2px solid #b42318}.badge.conduta{background:#fff1d6;color:#7a4b00;border:1px solid #b76e00}
.risco-dose{border:2px solid #b42318}.campo{margin:6px 0}.rot{display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#555}
.txt{white-space:pre-wrap}.alerta .txt{background:#f6f2ff;padding:4px 6px;border-radius:4px}.falta{color:#b42318;font-weight:700}
.verif.contradiz .txt,.verif.nada .txt{color:#b42318}.verif.parcial .txt{color:#7a4b00}
figure{margin:6px 0}figure img{max-width:100%;max-height:360px;border:1px solid #ddd}figcaption{font-size:12px;color:#555}
.decisao{border:1px dashed #888;border-radius:6px;margin-top:8px}.decisao label{margin-right:18px;font-weight:600}
.decisao input{width:16px;height:16px;vertical-align:middle}.nota{margin-top:8px}.linha{display:inline-block;border-bottom:1px solid #333;width:85%;height:1.2em}
.assinatura td{padding:10px 0;border-bottom:1px solid #333;width:50%}
@media print{body{padding:0;max-width:none}@page{size:A4;margin:14mm}a{color:inherit}}`;

/** Self-contained HTML (inline CSS, images as data: URIs, no script). */
export function renderDossier(b: Bundle, verdicts: VerifyResult[], fontesMd: string | null, today = new Date().toISOString().slice(0, 10)): string {
  const m = b.map!;
  const v = new Map(verdicts.map((x) => [x.cardId, x]));
  const cards = [...m.cards].sort((a, c) => a.ordem - c.ordem);
  const count = (k: VerifyResult['veredito']) => cards.filter((c) => v.get(c.id)?.veredito === k).length;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dossiê de revisão: ${esc(m.mapa.titulo)} ${esc(m.mapa.versao)}</title><style>${CSS}</style></head><body>
<h1>Dossiê de revisão médica: ${esc(m.mapa.titulo)}</h1>
<p>Versão ${esc(m.mapa.versao)} · ${esc(m.mapa.marcoTemporal)} · revisar até ${esc(m.mapa.revisarAte)} · área ${esc(m.mapa.area)} · ${cards.length} cards · gerado em ${esc(today)} · estado: rascunho (seed_draft)</p>
<p class="aviso">${esc(m.mapa.aviso)} Nada aqui é público até o revisor com CRM aprovar card a card (regra 6). Cards com <strong>DOSE</strong> exigem dois conferentes.</p>
<p>Verificação por IA (contra as evidências): ${count('sustenta')} sustenta, ${count('parcial')} parcial, ${count('contradiz')} contradiz, ${cards.length - count('sustenta') - count('parcial') - count('contradiz')} sem verificação.
Marque uma caixa por card. Em Ajustar e Rejeitar a nota é obrigatória.</p>
<h2>Fontes</h2>${fontesMd ? sourcesTable(fontesMd) : '<p class="falta">FONTES.md ausente</p>'}
<h2>Cards na ordem da trilha</h2>
${cards.map((c) => cardHtml(b, c, v.get(c.id))).join('\n')}
<h2>Assinatura</h2><table class="assinatura"><tr><td>Revisor:</td><td>CRM:</td></tr><tr><td>Data:</td><td>Assinatura:</td></tr></table>
</body></html>
`;
}

/** CHROME_PATH, else Google Chrome on macOS, else the newest Playwright Chromium in the user cache. */
function chrome(): string | null {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  const cache = join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (!existsSync(cache)) return null;
  for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const found = ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']
      .map((p) => join(cache, d, p)).find(existsSync);
    if (found) return found;
  }
  return null;
}

const say = (s: string) => process.stdout.write(`${s}\n`);

/** `content:dossier <slug...>` -> `<slug>/dossie/<slug>-<versao>.html` (+ .pdf). */
export async function run(args: string[]): Promise<number> {
  const slugs = args.filter((a) => !a.startsWith('--'));
  if (!slugs.length) return say('informe o slug'), 1;
  let code = 0;
  for (const slug of slugs) {
    const b = loadBundle(slug);
    const issues = lintBundle(b);
    // Lint errors (e.g. targets not reached yet) do not stop a partial dossier, but the run fails so nobody takes it as final.
    if (hasErrors(issues)) {
      say(formatIssues(slug, issues));
      code = 1;
    }
    if (!b.map) continue;
    const fontes = join(b.dir, 'FONTES.md');
    const dir = join(b.dir, 'dossie');
    mkdirSync(dir, { recursive: true });
    const html = join(dir, `${slug}-${b.map.mapa.versao}.html`);
    writeFileSync(html, renderDossier(b, currentVerdicts(b), existsSync(fontes) ? readFileSync(fontes, 'utf8') : null));
    say(`${slug}: ${html}`);
    const bin = chrome();
    if (!bin) {
      say('  PDF pendente: nenhum Chrome/Chromium encontrado (defina CHROME_PATH ou imprima o HTML em PDF)');
      continue;
    }
    const pdf = html.replace(/\.html$/, '.pdf');
    try {
      execFileSync(bin, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, pathToFileURL(html).href], { stdio: 'ignore', timeout: 120_000 });
      say(`${slug}: ${pdf}`);
    } catch (e) {
      say(`  PDF falhou (${e instanceof Error ? e.message : String(e)}); o HTML imprime pelo navegador`);
      code = 1;
    }
  }
  return code;
}
