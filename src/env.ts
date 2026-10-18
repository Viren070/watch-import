import { configureLogging, defineEnv } from '@aiostreams/addon-sdk';
import { z } from 'zod';

export const env = defineEnv({
  PORT: z.coerce.number().int().min(1).max(65535).default(7007),
  SECRET_KEY: z
    .string({ error: 'required, generate one with: openssl rand -hex 32' })
    .min(32, 'must be at least 32 characters'),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error', 'silent'])
    .default('info'),
  ALLOW_PRIVATE_ADDON_URLS: z.stringbool().default(false),
  PULL_BUDGET_SECONDS: z.coerce.number().min(1).max(60).default(15),
  DATA_DIR: z.string().default('data'),
});

configureLogging({ level: env.LOG_LEVEL });
