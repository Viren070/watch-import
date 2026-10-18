import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { env } from './env.js';

/** Anything worth retrying: a timeout, a network failure or a 5xx. */
export class UpstreamError extends Error {}

/** A private address, or a host that does not exist. Never worth retrying. */
export class UnreachableError extends Error {}

const PRIVATE = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv4');
}
PRIVATE.addAddress('::', 'ipv6');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  return family !== 0 && PRIVATE.check(host, family === 6 ? 'ipv6' : 'ipv4');
}

// Checks the addresses the socket really connects to, so redirects and DNS rebinding are covered.
const checkedLookup = ((hostname, options, callback) => {
  dnsLookup(hostname, options, (err, address, family) => {
    const addresses: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address: address as string, family: family as number }];
    if (!err && addresses.some((a) => isPrivateAddress(a.address))) {
      err = new UnreachableError(`${hostname} is a private address`);
    }
    (callback as (...args: unknown[]) => void)(err, address, family);
  });
}) as LookupFunction;

const checkedConnect = buildConnector({ lookup: checkedLookup });

const publicOnly = new Agent({
  connect(options, callback) {
    if (isPrivateAddress(options.hostname)) {
      const err = new UnreachableError(
        `${options.hostname} is a private address`
      );
      process.nextTick(() => callback(err, null));
      return;
    }
    return checkedConnect(options, callback);
  },
});

interface ReadOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  /** For URLs a user chose: refuses private addresses unless the operator allows them. */
  untrusted?: boolean;
}

export async function readJson(
  url: string,
  options: ReadOptions
): Promise<{ status: number; json: unknown }> {
  const host = new URL(url).host;
  const init = {
    method: options.method,
    headers: options.headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs),
  };
  let res: Response;
  try {
    res =
      options.untrusted && !env.ALLOW_PRIVATE_ADDON_URLS
        ? ((await undiciFetch(url, {
            ...init,
            dispatcher: publicOnly,
          })) as unknown as Response)
        : await fetch(url, init);
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause instanceof UnreachableError) throw cause;
    if (cause?.code === 'ENOTFOUND') {
      throw new UnreachableError(`${host} does not exist`);
    }
    throw new UpstreamError(
      `${host}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (res.status >= 500 || res.status === 429) {
    await res.body?.cancel();
    throw new UpstreamError(`${host}: HTTP ${res.status}`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > options.maxBytes) {
        await res.body?.cancel();
        throw new UpstreamError(`${host}: response too large`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(
      `${host}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    return {
      status: res.status,
      json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
  } catch {
    return { status: res.status, json: null };
  }
}
