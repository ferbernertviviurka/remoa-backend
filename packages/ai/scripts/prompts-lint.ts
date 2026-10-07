// G25 `pnpm ai:prompts:lint`: every challenge prompt has the five parts, its variables, data markers and a valid JSON example.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { CHALLENGE_PROMPT_IDS, challengePromptFiles, lintPrompt } from '../src/challenge-prompts';

const files = challengePromptFiles();
let problems = 0;
for (const f of files) {
  const errors = lintPrompt(readFileSync(f.path, 'utf8'), { id: f.id, version: f.version });
  const name = relative(process.cwd(), f.path);
  if (!errors.length) console.log(`ok    ${name}`);
  for (const e of errors) console.log(`erro  ${name}: ${e}`);
  problems += errors.length;
}
for (const id of CHALLENGE_PROMPT_IDS) {
  if (!files.some((f) => f.id === id)) {
    console.log(`erro  falta o prompt ${id}`);
    problems += 1;
  }
}
if (problems) {
  console.log(`\n${problems} problema(s).`);
  process.exit(1);
}
console.log(`\n${files.length} prompt(s) sem problemas.`);
