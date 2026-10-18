import { createHash } from 'node:crypto';
import { z } from 'zod';

const library = z.boolean().default(true);
const profile = z.number().int().min(1).max(6).default(1);

const StremioConfigSchema = z.object({
  service: z.literal('stremio'),
  authKey: z.string().min(1),
  library,
});

/** The session lives on this server; `key` decrypts it and is only ever in the URL. */
const NuvioConfigSchema = z.object({
  service: z.literal('nuvio'),
  session: z.string().min(1),
  key: z.string().min(1),
  profile,
  library,
});

export const ConfigSchema = z.discriminatedUnion('service', [
  StremioConfigSchema,
  NuvioConfigSchema,
]);

export type Config = z.infer<typeof ConfigSchema>;
export type StremioConfig = z.infer<typeof StremioConfigSchema>;
export type NuvioConfig = z.infer<typeof NuvioConfigSchema>;

export const ConfigureRequestSchema = z.discriminatedUnion('service', [
  StremioConfigSchema,
  z.object({
    service: z.literal('nuvio'),
    refreshToken: z.string().min(1),
    profile,
    library,
  }),
]);

/** Keys per-account caches without holding the session itself. */
export function accountKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 32);
}
