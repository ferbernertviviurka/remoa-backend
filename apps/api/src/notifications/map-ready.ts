// G18 F26 FR-4 / F24 template 7: "map_ready" when a generation (text, PDF) or an Anki import finishes.
import { sql } from 'drizzle-orm';
import { env } from '@remoa/config';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { notify } from './notify';

const log = createLogger({ requestId: 'map-ready' });
/** Faster than this and the person is assumed to still be watching the progress screen: in-app only (F26 FR-4). */
export const MAP_READY_QUICK_MS = 60_000;

/**
 * Never throws. Reference = the board id (one notice per map).
 * ponytail: the API has no signal that the person left the screen, so the e-mail rule is the duration alone (<= 60 s: in-app only);
 * add a "last poll of the progress endpoint" timestamp if people who leave within a minute should also get the e-mail.
 */
export async function notifyMapReady(a: { userId: string; boardId: string; origin: 'text' | 'pdf' | 'anki'; tookMs: number }): Promise<void> {
  try {
    const { db } = await dbm();
    const [b] = await db.execute<{ title: string; cards: number; edges: number }>(sql`
      select b.title,
        (select count(*)::int from cards c where c.board_id = b.id and c.deleted_at is null and c.type <> 'note') as cards,
        (select count(*)::int from edges e where e.board_id = b.id) as edges
      from boards b where b.id = ${a.boardId} and b.user_id = ${a.userId}`);
    if (!b) return;
    const mapUrl = `/app/mapas/${a.boardId}`;
    await notify(
      a.userId,
      'map_ready',
      {
        reference: a.boardId,
        href: mapUrl,
        data: { boardId: a.boardId, title: b.title, cards: b.cards },
        email: { mapTitle: b.title.slice(0, 120) || '-', cards: b.cards, connections: b.edges, origin: a.origin, mapUrl: `${env().appUrl}${mapUrl}` },
      },
      { skipEmail: a.tookMs <= MAP_READY_QUICK_MS },
    );
  } catch (e) {
    log.error('map ready notice failed', { error: e instanceof Error ? e.message : String(e) });
  }
}
