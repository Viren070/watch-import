import type { Manifest } from '@aiostreams/addon-sdk';
import type { Config } from './config.js';

const VERSION = '0.1.0';

const SERVICES = { stremio: 'Stremio', nuvio: 'Nuvio' } as const;

export function manifestFor(config?: Config): Manifest {
  return {
    id: 'community.watch-import',
    version: VERSION,
    name: config
      ? `Watch Import (${SERVICES[config.service]})`
      : 'Watch Import',
    description:
      'Brings your watch history, Continue Watching and library from Stremio or Nuvio into AIOStreams, and keeps them up to date.',
    types: ['movie', 'series'],
    resources: [{ name: 'watch_state', types: ['movie', 'series', 'anime'] }],
    watchState: {
      version: 2,
      pull: {
        items: true,
        watched: true,
        watchlist: config?.library ?? true,
        ttlSeconds: 300,
      },
    },
    behaviorHints: { configurable: true, configurationRequired: true },
  };
}
