/**
 * Save/load via an INJECTED storage interface. The core never touches
 * localStorage directly — src/main.ts passes a browser-backed adapter,
 * tests pass the in-memory one below. Same shape as the desktop game's
 * SaveGame (money + completed missions), deliberately smaller.
 */

export interface StorageAdapter {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/** In-memory adapter for tests and non-browser hosts (Route C shells). */
export class MemoryStorage implements StorageAdapter {
  private map = new Map<string, string>();
  read(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  write(key: string, value: string): void {
    this.map.set(key, value);
  }
}

export interface SaveData {
  money: number;
  completedMissions: string[];
}

const SAVE_KEY = 'mvt-fredericton-web/save-v1';

export class SaveStore {
  private storage: StorageAdapter;
  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  load(): SaveData {
    try {
      const raw = this.storage.read(SAVE_KEY);
      if (!raw) return { money: 0, completedMissions: [] };
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      return {
        money: typeof parsed.money === 'number' ? parsed.money : 0,
        completedMissions: Array.isArray(parsed.completedMissions)
          ? parsed.completedMissions.filter((x) => typeof x === 'string')
          : [],
      };
    } catch {
      return { money: 0, completedMissions: [] };
    }
  }

  save(data: SaveData): void {
    this.storage.write(SAVE_KEY, JSON.stringify(data));
  }
}
