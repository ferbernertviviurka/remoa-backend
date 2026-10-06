import { z } from 'zod';
import { nameSchema } from './account';

const emailSchema = z.string().trim().toLowerCase().email();

export const signUpInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(72),
  /** G20 (D-842): required, same rule as Minha conta (2–60, normalized). Goes to raw_user_meta_data.name (handle_new_user). */
  name: nameSchema,
});
export const signInInputSchema = z.object({ email: emailSchema, password: z.string().min(1) });
export const magicLinkInputSchema = z.object({ email: emailSchema, next: z.string().optional() });

export type SignUpInput = z.infer<typeof signUpInputSchema>;
export type SignInInput = z.infer<typeof signInInputSchema>;
export type MagicLinkInput = z.infer<typeof magicLinkInputSchema>;
