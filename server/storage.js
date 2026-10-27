// Storage for the indexer's cache. Same interface for the local server (memory + JSON file)
// and for Vercel (Upstash Redis via the Vercel Marketplace).
//
//   getJSON(key) / setJSON(key, value)
//   getMap(key) -> { field: string } | null      replaceMap(key, obj)
//   commit({ meta, incr: { mapKey: { field: bigint } } })   atomic: counters + meta together
//   lock(ttlSeconds) -> boolean / unlock()          one sync at a time

export function createFileStorage(file) {
  let data = null;
  let lockedUntil = 0;

  async function load() {
    if (data) return data;
    data = {};
    if (file) {
      const { default: fs } = await import('node:fs');
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
    }
    return data;
  }
  async function persist() {
    if (!file) return;
    const { default: fs } = await import('node:fs');
    const { default: path } = await import('node:path');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  }

  return {
    async getJSON(key) {
      return (await load())[key] ?? null;
    },
    async setJSON(key, value) {
      (await load())[key] = value;
      await persist();
    },
    async getMap(key) {
      return (await load())[key] ?? null;
    },
    async replaceMap(key, obj) {
      (await load())[key] = obj;
      await persist();
    },
    async commit({ meta, incr = {} }) {
      const d = await load();
      for (const [mapKey, deltas] of Object.entries(incr)) {
        const map = (d[mapKey] ??= {});
        for (const [field, delta] of Object.entries(deltas)) map[field] = (BigInt(map[field] ?? 0) + BigInt(delta)).toString();
      }
      d.meta = meta;
      await persist();
    },
    async lock(ttlSeconds) {
      if (Date.now() < lockedUntil) return false;
      lockedUntil = Date.now() + ttlSeconds * 1000;
      return true;
    },
    async unlock() {
      lockedUntil = 0;
    },
  };
}

export async function createRedisStorage({ url, token, prefix }) {
  const { Redis } = await import('@upstash/redis');
  // Values are stored as plain strings; amounts stay exact (no automatic number parsing).
  const redis = new Redis({ url, token, automaticDeserialization: false });
  const k = (key) => `${prefix}:${key}`;
  const CHUNK = 1000;

  return {
    async getJSON(key) {
      const v = await redis.get(k(key));
      return v == null ? null : JSON.parse(v);
    },
    async setJSON(key, value) {
      await redis.set(k(key), JSON.stringify(value));
    },
    async getMap(key) {
      const v = await redis.hgetall(k(key));
      if (!v) return null;
      // Without automatic deserialization HGETALL comes back as a flat [field, value, ...] list.
      const obj = Array.isArray(v) ? Object.fromEntries(Array.from({ length: v.length / 2 }, (_, i) => [v[2 * i], String(v[2 * i + 1])])) : v;
      return Object.keys(obj).length ? obj : null;
    },
    // Rebuilt under a temp key and swapped in, so readers never see a half-written map.
    async replaceMap(key, obj) {
      const tmp = k(`${key}:next`);
      const entries = Object.entries(obj);
      await redis.del(tmp);
      for (let i = 0; i < entries.length; i += CHUNK) await redis.hset(tmp, Object.fromEntries(entries.slice(i, i + CHUNK)));
      if (entries.length) await redis.rename(tmp, k(key));
      else await redis.del(k(key));
    },
    async commit({ meta, incr = {} }) {
      const tx = redis.multi();
      for (const [mapKey, deltas] of Object.entries(incr)) {
        for (const [field, delta] of Object.entries(deltas)) tx.hincrby(k(mapKey), field, Number(delta));
      }
      tx.set(k('meta'), JSON.stringify(meta));
      await tx.exec();
    },
    async lock(ttlSeconds) {
      return (await redis.set(k('lock'), String(Date.now()), { nx: true, ex: ttlSeconds })) === 'OK';
    },
    async unlock() {
      await redis.del(k('lock'));
    },
  };
}
