/**
 * Control-scheme resolution — pure seams for the boot-time default
 * (FOLLOW iteration 2).
 *
 * FOLLOW is the default scheme now, but the choice is persisted
 * (localStorage `mvt-input-scheme`), so changing the code default
 * alone never reaches an existing player — Daniel's phone included.
 * The migration is one-time and versioned: the first boot WITHOUT
 * the `mvt-scheme-default-v32` flag forces FOLLOW and writes the
 * flag (and the scheme); every boot after that honours whatever
 * the player picked in settings, forever.
 */

export const SCHEMES = ['stick', 'drag', 'buttons', 'tilt', 'follow'] as const;
export type Scheme = (typeof SCHEMES)[number];

export const SCHEME_STORAGE_KEY = 'mvt-input-scheme';
export const SCHEME_MIGRATION_KEY = 'mvt-scheme-default-v32';
export const DEFAULT_SCHEME: Scheme = 'follow';

export function isScheme(v: string | null | undefined): v is Scheme {
  return !!v && (SCHEMES as readonly string[]).includes(v);
}

export interface InitialScheme {
  scheme: Scheme;
  /** True when this boot performed the one-time migration — the
   *  caller must persist BOTH the scheme and the migration flag. */
  migrate: boolean;
}

export function resolveInitialScheme(
  stored: string | null,
  migrationDone: boolean,
): InitialScheme {
  if (!migrationDone) return { scheme: DEFAULT_SCHEME, migrate: true };
  return { scheme: isScheme(stored) ? stored : DEFAULT_SCHEME, migrate: false };
}
