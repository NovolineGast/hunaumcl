import { z } from 'zod';
export interface CredentialProtector {
  available(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}
export const microsoftCredentialsSchema = z
  .object({
    clientId: z.string().uuid(),
    refreshToken: z.string().min(1).max(32768),
    accessToken: z.string().min(1).max(32768),
    xuid: z.string().regex(/^\d{0,24}$/),
  })
  .strict();
export type MicrosoftCredentials = z.infer<typeof microsoftCredentialsSchema>;
export interface MicrosoftAuthentication {
  playerName: string;
  uuid: string;
  expiresAt: string;
  credentials: MicrosoftCredentials;
}
