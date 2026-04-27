/**
 * Device token registry.
 *
 * Stores { userId → Set<deviceToken> } in Redis when available, falling back
 * to an in-process Map for local dev / tests. Each entry has a platform tag
 * ("fcm" | "apns") so the dispatcher knows which SDK to use.
 */

export interface DeviceRecord {
  token: string;
  platform: "fcm" | "apns";
  registeredAt: number;
}

export interface DeviceRegistry {
  register(userId: string, record: DeviceRecord): Promise<void>;
  remove(userId: string, token: string): Promise<void>;
  list(userId: string): Promise<DeviceRecord[]>;
  count(userId: string): Promise<number>;
}

// ── In-memory (dev / test) ────────────────────────────────────────────────

export class InMemoryRegistry implements DeviceRegistry {
  private readonly store = new Map<string, Map<string, DeviceRecord>>();

  async register(userId: string, record: DeviceRecord): Promise<void> {
    if (!this.store.has(userId)) this.store.set(userId, new Map());
    this.store.get(userId)?.set(record.token, record);
  }

  async remove(userId: string, token: string): Promise<void> {
    this.store.get(userId)?.delete(token);
  }

  async list(userId: string): Promise<DeviceRecord[]> {
    return [...(this.store.get(userId)?.values() ?? [])];
  }

  async count(userId: string): Promise<number> {
    return this.store.get(userId)?.size ?? 0;
  }
}

// ── Redis-backed ──────────────────────────────────────────────────────────

const REDIS_PREFIX = "patchwork:devices:";
const MAX_DEVICES_PER_USER = 10;

export class RedisRegistry implements DeviceRegistry {
  constructor(
    private readonly redis: {
      hSet(key: string, field: string, value: string): Promise<unknown>;
      hDel(key: string, ...fields: string[]): Promise<unknown>;
      hGetAll(key: string): Promise<Record<string, string>>;
      hLen(key: string): Promise<number>;
    },
  ) {}

  private key(userId: string) {
    return `${REDIS_PREFIX}${userId}`;
  }

  async register(userId: string, record: DeviceRecord): Promise<void> {
    const key = this.key(userId);
    const current = await this.redis.hLen(key);
    if (current >= MAX_DEVICES_PER_USER) {
      // Evict oldest: fetch all, delete the one with smallest registeredAt
      const all = await this.redis.hGetAll(key);
      let oldestToken: string | undefined;
      let oldestTs = Infinity;
      for (const [token, raw] of Object.entries(all)) {
        let parsed: DeviceRecord | null = null;
        try {
          parsed = JSON.parse(raw) as DeviceRecord;
        } catch {
          // Corrupt entry — evict it as if it were the oldest so the registry
          // self-heals rather than blocking new registrations.
          oldestToken = token;
          oldestTs = -Infinity;
          continue;
        }
        if (parsed.registeredAt < oldestTs) {
          oldestTs = parsed.registeredAt;
          oldestToken = token;
        }
      }
      if (oldestToken) await this.redis.hDel(key, oldestToken);
    }
    await this.redis.hSet(key, record.token, JSON.stringify(record));
  }

  async remove(userId: string, token: string): Promise<void> {
    await this.redis.hDel(this.key(userId), token);
  }

  async list(userId: string): Promise<DeviceRecord[]> {
    const all = await this.redis.hGetAll(this.key(userId));
    const out: DeviceRecord[] = [];
    for (const raw of Object.values(all)) {
      try {
        out.push(JSON.parse(raw) as DeviceRecord);
      } catch {
        // Skip corrupt entries — don't poison the entire list for one bad row.
      }
    }
    return out;
  }

  async count(userId: string): Promise<number> {
    return this.redis.hLen(this.key(userId));
  }
}
