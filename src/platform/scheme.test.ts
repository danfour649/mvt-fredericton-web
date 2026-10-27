/**
 * Scheme resolution: FOLLOW is the default, and the one-time
 * versioned migration is what gets existing players (whose old
 * scheme is already persisted) onto it. After the migration flag
 * exists, the player's own settings pick rules — the migration
 * must never fire twice.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveInitialScheme,
  isScheme,
  DEFAULT_SCHEME,
  SCHEMES,
} from './scheme';

describe('resolveInitialScheme — the v32 migration', () => {
  it('forces FOLLOW for an existing player with an old scheme persisted', () => {
    // Daniel's phone: stick (or anything) saved, no migration flag.
    for (const stored of ['stick', 'drag', 'buttons', 'tilt']) {
      const r = resolveInitialScheme(stored, false);
      expect(r.scheme).toBe('follow');
      expect(r.migrate).toBe(true);
    }
  });

  it('forces FOLLOW for a brand-new player too (nothing stored)', () => {
    const r = resolveInitialScheme(null, false);
    expect(r.scheme).toBe('follow');
    expect(r.migrate).toBe(true);
  });

  it('after migration, whatever the player picked sticks', () => {
    for (const stored of SCHEMES) {
      const r = resolveInitialScheme(stored, true);
      expect(r.scheme).toBe(stored);
      expect(r.migrate).toBe(false);
    }
  });

  it('after migration, a corrupt stored value falls back to FOLLOW', () => {
    expect(resolveInitialScheme('banana', true).scheme).toBe('follow');
    expect(resolveInitialScheme('', true).scheme).toBe('follow');
    expect(resolveInitialScheme(null, true).scheme).toBe('follow');
  });

  it('the default scheme is follow', () => {
    expect(DEFAULT_SCHEME).toBe('follow');
  });
});

describe('isScheme', () => {
  it('accepts exactly the five schemes', () => {
    for (const s of SCHEMES) expect(isScheme(s)).toBe(true);
    expect(isScheme('FOLLOW')).toBe(false);
    expect(isScheme(null)).toBe(false);
    expect(isScheme(undefined)).toBe(false);
  });
});
