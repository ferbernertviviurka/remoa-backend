import { z } from 'zod';
import { areas } from './enums';
import { idSchema, probabilitySchema } from './common';

export const matrixAreaSchema = z.enum(areas);
export type MatrixArea = z.infer<typeof matrixAreaSchema>;

export const matrixItemSchema = z.object({
  id: idSchema,
  area: matrixAreaSchema,
  code: z.string().min(1),
  title: z.string().min(1),
  parentId: idSchema.nullable(),
  targetCards: z.number().int().positive(),
});
export type MatrixItem = z.infer<typeof matrixItemSchema>;

export const boardMatrixLinkSchema = z.object({ boardId: idSchema, matrixItemId: idSchema });
export type BoardMatrixLink = z.infer<typeof boardMatrixLinkSchema>;

export const coverageRowSchema = z.object({
  matrixItemId: idSchema,
  area: matrixAreaSchema,
  code: z.string(),
  title: z.string(),
  boards: z.number().int().nonnegative(),
  cards: z.number().int().nonnegative(),
  targetCards: z.number().int().positive(),
  /** min(100, cards / targetCards * 100). */
  coverage: z.number().min(0).max(100),
  /** Mean estimated recall of linked cards; null when nothing reviewed. */
  avgRetrievability: probabilitySchema.nullable(),
});
export type CoverageRow = z.infer<typeof coverageRowSchema>;
