import { db } from './client';
import { matrixItems } from './schema';

// Titles only (grandes áreas de Clínica Médica); target_cards null until F07 content pass. No medical claims.
const items = [
  ['CM.01', 'Cardiologia'], ['CM.02', 'Pneumologia'], ['CM.03', 'Gastroenterologia'],
  ['CM.04', 'Nefrologia'], ['CM.05', 'Endocrinologia'], ['CM.06', 'Infectologia'],
  ['CM.07', 'Hematologia'], ['CM.08', 'Reumatologia'], ['CM.09', 'Neurologia'],
] as const;

await db.insert(matrixItems).values(items.map(([code, title]) => ({ area: 'CM' as const, code, title })))
  .onConflictDoNothing({ target: matrixItems.code });
process.stdout.write(`seed ok: ${items.length} matrix_items` + '\n');
process.exit(0);
