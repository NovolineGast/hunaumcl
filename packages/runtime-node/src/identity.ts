import { createHash } from 'node:crypto';
export function offlineUUID(playerName: string): string {
  const digest = createHash('md5').update(`OfflinePlayer:${playerName}`, 'utf8').digest();
  digest[6] = (digest[6]! & 0x0f) | 0x30;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return digest.toString('hex');
}
