import { z } from 'zod';

export const idSchema = z.string().uuid();
/** Accepts Date or ISO string (wire), always yields Date. */
export const timestampSchema = z.coerce.date();
/** FSRS sub-item key: FlowStep.id or Mask.id; null = the card itself. */
export const subIdSchema = z.string().min(1).nullable();
/** 0..1 probability. */
export const probabilitySchema = z.number().min(0).max(1);

/** Canvas px; bounded so it always fits the integer columns (F01 QA). */
const coordSchema = z.number().finite().min(-1_000_000).max(1_000_000);
export const positionSchema = z.object({ x: coordSchema, y: coordSchema });
export type Position = z.infer<typeof positionSchema>;
