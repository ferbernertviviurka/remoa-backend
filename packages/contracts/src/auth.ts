import { z } from 'zod';

const emailSchema = z.string().trim().toLowerCase().email();

export const signUpInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(72),
  name: z.string().trim().min(1).max(80).optional(),
});
export const signInInputSchema = z.object({ email: emailSchema, password: z.string().min(1) });
export const magicLinkInputSchema = z.object({ email: emailSchema, next: z.string().optional() });

export type SignUpInput = z.infer<typeof signUpInputSchema>;
export type SignInInput = z.infer<typeof signInInputSchema>;
export type MagicLinkInput = z.infer<typeof magicLinkInputSchema>;
