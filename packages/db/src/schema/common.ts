import { sql } from 'drizzle-orm';
import { pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';
// Supabase-managed table: drizzle-orm marks it as existing, so drizzle-kit never creates it.
import { authUsers } from 'drizzle-orm/supabase';
import {
  areas, assetLicenses, boardStatuses, cardShapes, cardStatuses, cardTypes, challengeModes, editorialStatuses,
  flagSources, fsrsCardStates, importKinds, inputKinds, jobStatuses, plans, profileRoles,
  sessionKinds, subscriptionStatuses,
} from '@remoa/contracts';

export { authUsers };

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
};

export const userId = () => uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' });

export const roleEnum = pgEnum('profile_role', profileRoles);
export const areaEnum = pgEnum('area', areas);
export const boardStatusEnum = pgEnum('board_status', boardStatuses);
export const cardTypeEnum = pgEnum('card_type', cardTypes);
export const cardShapeEnum = pgEnum('card_shape', cardShapes);
export const cardStatusEnum = pgEnum('card_status', cardStatuses);
export const licenseEnum = pgEnum('asset_license', assetLicenses);
export const fsrsStateEnum = pgEnum('fsrs_card_state', fsrsCardStates);
export const modeEnum = pgEnum('challenge_mode', challengeModes);
export const inputKindEnum = pgEnum('input_kind', inputKinds);
export const sessionKindEnum = pgEnum('session_kind', sessionKinds);
export const planEnum = pgEnum('plan', plans);
export const subStatusEnum = pgEnum('subscription_status', subscriptionStatuses);
export const importKindEnum = pgEnum('import_kind', importKinds);
export const jobStatusEnum = pgEnum('job_status', jobStatuses);
export const editorialStatusEnum = pgEnum('editorial_status', editorialStatuses);
export const flagSourceEnum = pgEnum('flag_source', flagSources);
