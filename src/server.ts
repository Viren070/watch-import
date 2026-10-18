import { readFile } from 'node:fs/promises';
import { AddonError, defineAddon } from '@aiostreams/addon-sdk';
import { serve } from '@aiostreams/addon-sdk/node';
import { z } from 'zod';
import { ConfigSchema, ConfigureRequestSchema, type Config } from './config.js';
import { env } from './env.js';
import { UpstreamError } from './http.js';
import { manifestFor } from './manifest.js';
import { NuvioAuthError, NuvioError, rpc, type Profile } from './nuvio/api.js';
import { createSession } from './nuvio/sessions.js';
import { nuvioSource } from './nuvio/source.js';
import { buildPull } from './reads.js';
import { getUser, StremioAuthError, StremioError } from './stremio/api.js';
import { stremioSource } from './stremio/source.js';

const CONFIGURE_PAGE = await readFile(
  new URL('../public/configure.html', import.meta.url),
  'utf8'
);

/** Service failures as answers AIOStreams acts on: sign in again, or retry later. */
async function answering<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof StremioAuthError || error instanceof NuvioAuthError) {
      const service = error instanceof StremioAuthError ? 'Stremio' : 'Nuvio';
      throw new AddonError(
        401,
        `The ${service} session has ended. Sign in again.`
      );
    }
    if (
      error instanceof UpstreamError ||
      error instanceof StremioError ||
      error instanceof NuvioError
    ) {
      throw new AddonError(503, error.message, {
        retryAfter: 60,
        cause: error,
      });
    }
    throw error;
  }
}

async function configOf(
  request: z.infer<typeof ConfigureRequestSchema>
): Promise<Config> {
  if (request.service === 'stremio') {
    await getUser(request.authKey);
    return request;
  }
  const session = await createSession(request.refreshToken);
  const profiles = await rpc<Profile[]>(
    session.accessToken,
    'sync_pull_profiles',
    {}
  );
  if (
    profiles.length &&
    !profiles.some((p) => p.profile_index === request.profile)
  ) {
    throw new AddonError(400, 'That Nuvio profile does not exist');
  }
  return {
    service: 'nuvio',
    session: session.id,
    key: session.key,
    profile: request.profile,
    library: request.library,
  };
}

const sourceOf = (config: Config) =>
  config.service === 'stremio' ? stremioSource(config) : nuvioSource(config);

const addon = defineAddon({
  manifest: manifestFor,
  config: { schema: ConfigSchema, secret: env.SECRET_KEY },

  watchState: {
    pull: ({ config, since }) =>
      answering(async () => {
        const budget = env.PULL_BUDGET_SECONDS * 1000;
        return (await buildPull(sourceOf(config), since, budget)).answer;
      }),
  },

  configure: async ({ request, manifestUrl }) => {
    if (request.method !== 'POST') return CONFIGURE_PAGE;
    const parsed = ConfigureRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      throw new AddonError(400, z.prettifyError(parsed.error));
    }
    const config = await answering(() => configOf(parsed.data));
    return Response.json({ manifestUrl: await manifestUrl(config) });
  },
});

await serve(addon, { port: env.PORT });
