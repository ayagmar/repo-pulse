import { logger } from './logger.js';

const MATERIAL_TTL_SECONDS = 300;

/** The part of the Workers Cache API the public routes use. */
export interface MaterialCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** Material read from D1 by this isolate. */
export interface MaterialMemory<Material> {
  snapshot?: { material: Material; expiresAt: number };
}

export interface MaterialSources<Material> {
  /**
   * Checked before the Cache API, which is per location and may store nothing on
   * `*.workers.dev`: a warm isolate never reads D1 more than once per 300 seconds.
   */
  memory: MaterialMemory<Material>;
  /** The Cache API, or null where the runtime has none. */
  cache: MaterialCache | null;
  waitUntil(promise: Promise<unknown>): void;
}

/** Where a route keeps its material, and how it reads it from D1. */
export interface MaterialKind<Material> {
  /** On a host the Worker never serves, so a cached entry can never be returned as a response. */
  cacheUrl: string;
  /** The logger component; a failed Cache API write is logged as `<component>.material_cache_failed`. */
  component: 'public-feed' | 'public-activity';
  read: () => Promise<Material>;
}

/** Plain-JSON material from the isolate, then the Cache API, then D1, each copy kept for 300 seconds. */
export async function loadMaterial<Material>(
  sources: MaterialSources<Material>,
  { cacheUrl, component, read }: MaterialKind<Material>,
  now: Date
): Promise<Material> {
  const remembered = sources.memory.snapshot;
  if (remembered && now.getTime() < remembered.expiresAt) {
    return remembered.material;
  }
  const cached = await sources.cache?.match(cacheUrl);
  if (cached) {
    return cached.json();
  }

  const material = await read();
  sources.memory.snapshot = {
    material,
    expiresAt: now.getTime() + MATERIAL_TTL_SECONDS * 1000,
  };
  if (sources.cache) {
    sources.waitUntil(
      sources.cache
        .put(
          cacheUrl,
          new Response(JSON.stringify(material), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `max-age=${String(MATERIAL_TTL_SECONDS)}`,
            },
          })
        )
        .catch((error: unknown) => {
          logger.warn(`${component.replace('-', '_')}.material_cache_failed`, {
            component,
            error,
          });
        })
    );
  }
  return material;
}
