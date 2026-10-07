// `pnpm content:<command> [slug...]` (F31 FR-31–FR-34). Exit code 1 on any error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentReviewDecisionSchema } from '@remoa/contracts';
import postgres from 'postgres';
import { buildMap, SEED_OWNER_ID, type Put } from './build';
import { checkImages, toWebp } from './images';
import { formatIssues, hasErrors, lintBundle } from './lint';
import { CONTENT_ROOT, listSlugs, loadBundle } from './load';
import { renderReport } from './report';
import { currentVerdicts } from './verify';

const say = (s: string) => process.stdout.write(`${s}\n`);
const OUT = fileURLToPath(new URL('../.out', import.meta.url));

/** Named slugs, or every map folder (templates only for lint). */
const slugsOf = (args: string[], withTemplates: boolean) => {
  const named = args.filter((a) => !a.startsWith('--'));
  return named.length ? named : listSlugs().filter((s) => withTemplates || !s.startsWith('_'));
};

/** `<slug>/decisoes.jsonl` lines that parse with the schema (one decision per line). */
function readRows<T>(file: string, schema: { safeParse: (x: unknown) => { success: true; data: T } | { success: false } }): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const rows: unknown[] = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  return rows.flatMap((r) => {
    const p = schema.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

/** S3/R2 upload of the WebP variants when the bucket env is set (same variables as apps/api storage). */
async function s3Put(): Promise<Put | undefined> {
  const e = process.env;
  if (!e.S3_ENDPOINT || !e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) return undefined;
  const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: e.S3_ENDPOINT, region: e.S3_REGION ?? 'auto', forcePathStyle: e.S3_URL_STYLE !== 'virtual',
    credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
  });
  return async (Key, Body, ContentType) => void (await client.send(new PutObjectCommand({ Bucket: e.S3_BUCKET, Key, Body, ContentType })));
}

type Command = { help: string; run: (args: string[]) => Promise<number> };

export const commands: Record<string, Command> = {
  lint: {
    help: 'lint [slug...]   esquema, trilha, metas, fontes, cópia literal (FR-31). Pasta com _ (ex. _template) = só esquema e grafo',
    async run(args) {
      let code = 0;
      for (const slug of slugsOf(args, true)) {
        const issues = lintBundle(loadBundle(slug));
        say(formatIssues(slug, issues));
        if (hasErrors(issues)) code = 1;
      }
      return code;
    },
  },
  images: {
    help: 'images [slug...]   SVG seguro, CREDITOS.md, máscaras; WebP w800/w1600 em packages/content/.out (FR-16/17)',
    async run(args) {
      let code = 0;
      for (const slug of slugsOf(args, false)) {
        const b = loadBundle(slug);
        const issues = [...b.issues, ...checkImages(b)];
        say(formatIssues(`${slug} (imagens)`, issues));
        if (hasErrors(issues)) {
          code = 1;
          continue;
        }
        for (const f of b.images) {
          const webp = await toWebp(readFileSync(join(b.dir, 'imagens', f)), f.endsWith('.svg'));
          const dir = join(OUT, slug, f.replace(/\.[^.]+$/, ''));
          mkdirSync(dir, { recursive: true });
          for (const [name, data] of Object.entries(webp.variants)) writeFileSync(join(dir, `${name}.webp`), data);
          say(`  ${f} -> ${webp.width}x${webp.height}`);
        }
      }
      return code;
    },
  },
  build: {
    help: 'build <slug...|--all> [--publicar]   seed_draft idempotente no DATABASE_URL (FR-33), só com content:verify verde; --publicar só testa o portão (FR-28)',
    async run(args) {
      if (!args.length) return say('informe o slug ou --all'), 1;
      const url = process.env.DATABASE_URL;
      if (!url) return say('DATABASE_URL não definido'), 1;
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      const put = await s3Put();
      if (!put) say('aviso: S3_* ausente, imagens não enviadas ao bucket (só as linhas de assets)');
      let code = 0;
      try {
        for (const slug of slugsOf(args.filter((a) => a !== '--all'), false)) {
          const b = loadBundle(slug);
          const r = await sql.begin((tx) => buildMap(tx, b, {
            ownerId: process.env.CONTENT_OWNER_ID ?? SEED_OWNER_ID,
            put,
            status: args.includes('--publicar') ? 'seed_approved' : 'seed_draft',
            verify: currentVerdicts(b), // stale verdicts (card or evidence changed) count as missing
            decisions: readRows(join(b.dir, 'decisoes.jsonl'), contentReviewDecisionSchema),
          }));
          if (r.ok) say(`${slug}: ${r.data.created ? 'criado' : 'atualizado'} ${r.data.boardId} (seed_draft) cards=${r.data.cards} conexoes=${r.data.edges} prereqs=${r.data.prereqs} imagens=${r.data.assets} removidos=${r.data.removed}`);
          else {
            code = 1;
            say(`${slug}: RECUSADO (${r.error.code}) ${r.error.message}`);
            for (const d of r.error.details ?? []) say(`  ${d}`);
          }
        }
      } finally {
        await sql.end();
      }
      return code;
    },
  },
  verify: {
    help: 'verify <slug...> [--only id,id]   IA confere cada card contra a evidência (FR-22); só cards novos ou mudados; -> <slug>/verificacao.json (AI_TIMEOUT_MS_VERIFY=240000 recomendado: 20 cards por chamada)',
    run: (a) => import('./verify').then((m) => m.run(a)),
  },
  dossier: {
    help: 'dossier <slug...>   dossiê do revisor médico, HTML e PDF (FR-26) -> <slug>/dossie/',
    run: (a) => import('./dossier').then((m) => m.run(a)),
  },
  report: {
    help: 'report   metas × feito, Matriz e pendências -> docs/content/enamed/RELATORIO-COBERTURA.md (FR-34)',
    async run() {
      const file = join(CONTENT_ROOT, 'RELATORIO-COBERTURA.md');
      writeFileSync(file, renderReport());
      say(`escrito ${file}`);
      return 0;
    },
  },
};

const [name = '', ...rest] = process.argv.slice(2);
const cmd = commands[name];
if (!cmd) {
  say(`uso: pnpm content:<comando>\n${Object.values(commands).map((c) => `  ${c.help}`).join('\n')}`);
  process.exit(1);
}
process.exit(await cmd.run(rest));
