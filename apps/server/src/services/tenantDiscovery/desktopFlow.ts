import { z } from 'zod';

/** AuthCtr generates randomBytes(16).hex state and SHA-256 base64url challenge. */
export const desktopFlowSchema = z
  .object({
    state: z.string().regex(/^[a-f0-9]{32}$/),
    codeChallenge: z.string().regex(/^[\w-]{43}$/),
  })
  .strict();
export type DesktopFlow = z.infer<typeof desktopFlowSchema>;
export const parseDesktopFlow = (input: unknown): DesktopFlow | null => {
  const result = desktopFlowSchema.safeParse(input);
  return result.success ? result.data : null;
};
