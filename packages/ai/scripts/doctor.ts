// G22 `pnpm ai:doctor`: environment, key (presence only, never the value), tier and daily usage, model and fallbacks checked
// against the live catalog, and current free text-only models. Read-only: /models and /key do not spend model requests.
import { aiConfig, aiMode, chainFor, missingConfig } from '../src/config';
import { fetchCatalog, freeTextModels, validateAi } from '../src/catalog';
import { ocrEnabled } from '../src/ocr';

// Scripts run outside the API: an unset NODE_ENV means a local run here, not production (the prod guard still applies on Railway).
process.env.NODE_ENV ??= 'development';

const c = aiConfig();
const yes = (b: boolean) => (b ? 'sim' : 'não');
const out = (k: string, v: unknown) => console.log(`${k.padEnd(24)} ${v ?? '(vazio)'}`);

console.log('Remoa — diagnóstico da IA\n');
out('NODE_ENV', process.env.NODE_ENV ?? '(vazio = produção)');
out('modo', aiMode());
out('AI_PROVIDER', c.provider);
out('AI_BASE_URL', c.baseUrl);
out('OPENROUTER_API_KEY', c.apiKey ? `definida (${c.apiKey.length} caracteres)` : 'ausente');
out('AI_MODEL', c.model);
out('AI_MODEL_FALLBACKS', c.fallbacks.join(', ') || undefined);
for (const fn of ['grader', 'rubric', 'extract']) out(`  cadeia ${fn}`, chainFor(fn).join(' → ') || undefined);
out('AI_REQUIRE_FREE', yes(c.requireFree));
out('AI_ALLOW_FREE_IN_PROD', yes(c.allowFreeInProd));
out('AI_DATA_COLLECTION', c.dataCollection);
out('AI_TIMEOUT_MS', c.timeoutMs);
out('AI_MAX_RETRIES', c.maxRetries);
out('AI_RPM_LIMIT / RPD', `${c.rpmLimit} / ${c.rpdLimit}`);
out('AI_APP_URL / NAME', `${c.appUrl ?? '(vazio)'} / ${c.appName ?? '(vazio)'}`);
out('OCR (AI_OCR_MODEL)', process.env.AI_OCR_MODEL || undefined);
out('MISTRAL_API_KEY', process.env.MISTRAL_API_KEY ? 'definida' : 'ausente');
out('OCR ligado', ocrEnabled() ? 'sim (Mistral, pago)' : c.requireFree ? 'não (AI_REQUIRE_FREE=1: a Mistral é paga)' : 'não');
if (missingConfig().length) console.log(`\nFaltam para chamadas reais: ${missingConfig().join(', ')}`);
if (c.production && c.dataCollection !== 'deny') console.log('\nAtenção: produção com AI_DATA_COLLECTION diferente de deny.');

let problems = 0;
if (aiMode() === 'live') {
  const h = await validateAi();
  console.log(`\nConta: nível gratuito ${h.key?.isFreeTier === null || !h.key ? '?' : yes(h.key.isFreeTier)}; uso hoje US$ ${h.key?.usageDaily ?? '?'}; limite ${h.key?.limit ?? 'sem limite'}; restante ${h.key?.limitRemaining ?? '?'}`);
  console.log(`Validação: ${h.status}`);
  for (const p of h.problems) console.log(`  - ${p}`);
  problems = h.problems.length;
}

if (c.baseUrl) {
  const catalog = await fetchCatalog().catch(() => null);
  if (catalog?.ok) {
    const byCtx = new Map(catalog.data.map((m) => [m.id, m.context_length ?? 0]));
    const free = freeTextModels(catalog.data).sort((a, b) => (byCtx.get(b) ?? 0) - (byCtx.get(a) ?? 0));
    console.log(`\nModelos :free só-texto com JSON no catálogo agora (${free.length}):`);
    for (const id of free.slice(0, 12)) console.log(`  ${id}  (${byCtx.get(id)} tokens)`);
    const tools = new Set(freeTextModels(catalog.data, ['tools', 'tool_choice']));
    console.log(`  com tools (correção): ${free.filter((id) => tools.has(id)).slice(0, 6).join(', ') || 'nenhum'}`);
  } else console.log('\nCatálogo indisponível.');
}
process.exit(problems ? 1 : 0);
