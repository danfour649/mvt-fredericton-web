/**
 * Save/load via an INJECTED storage interface. The core never touches
 * localStorage directly — src/main.ts passes a browser-backed adapter,
 * tests pass the in-memory one below.
 *
 * v0.20 save shape (key save-v2): the run's score/multiplier are session
 * state and are NOT persisted (a fresh load starts a fresh run, GTA-style);
 * what persists across loads is the archive: district cleared flag and
 * best score ever.
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
  /** Missions completed in the archived record (kept for continuity). */
  completedMissions: string[];
  districtCleared: boolean;
  bestScore: number;
}

const SAVE_KEY = 'mvt-fredericton-web/save-v2';
const DEFAULTS: SaveData = { completedMissions: [], districtCleared: false, bestScore: 0 };

export class SaveStore {
  private storage: StorageAdapter;
  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  load(): SaveData {
    try {
      const raw = this.storage.read(SAVE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      return {
        completedMissions: Array.isArray(parsed.completedMissions)
          ? parsed.completedMissions.filter((x) => typeof x === 'string')
          : [],
        districtCleared: parsed.districtCleared === true,
        bestScore: typeof parsed.bestScore === 'number' ? parsed.bestScore : 0,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  save(data: SaveData): void {
    this.storage.write(SAVE_KEY, JSON.stringify(data));
  }
}
