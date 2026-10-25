import { describe, it, expect } from 'vitest';
import { MISSIONS, MissionRunner, SPAWN_POS, SPAWN_GRID } from './missions';
import { mvtGridToLngLat, unproject } from './geo';

describe('mission definitions carry the desktop payouts and steps', () => {
  it('queen_street_errand: $150, two interact steps', () => {
    const m = MISSIONS.find((x) => x.id === 'queen_street_errand')!;
    expect(m.payout).toBe(150);
    expect(m.steps.map((s) => s.id)).toEqual(['pickup', 'dropoff']);
    expect(m.steps.map((s) => s.gridPos)).toEqual([
      [8.8, 28],
      [48, 28],
    ]);
  });

  it('cap_wheels: $250, steal then deliver', () => {
    const m = MISSIONS.find((x) => x.id === 'cap_wheels')!;
    expect(m.payout).toBe(250);
    expect(m.steps.map((s) => s.kind)).toEqual(['steal_vehicle', 'deliver_vehicle']);
    expect(m.steps[1].gridPos).toEqual([-58, 32]);
    expect(m.steps[1].radius).toBe(12);
  });

  it('all desktop grid positions convert to the Queen St / downtown area', () => {
    const all: Array<[number, number]> = [
      SPAWN_GRID,
      ...MISSIONS.flatMap((m) => [
        m.startGridPos,
        ...m.steps.filter((s) => s.gridPos).map((s) => s.gridPos!),
      ]),
    ];
    for (const [x, z] of all) {
      const ll = mvtGridToLngLat(x, z);
      // All within ~150 m of City Hall: the desktop starts are a tight cluster.
      expect(Math.abs(ll.lat - 45.96315)).toBeLessThan(0.002);
      expect(Math.abs(ll.lng - -66.6428)).toBeLessThan(0.002);
    }
  });

  it('spawn core position unprojects to Queen St', () => {
    const ll = unproject(SPAWN_POS.x, SPAWN_POS.z);
    expect(ll.lat).toBeCloseTo(45.9629, 3);
  });
});

describe('MissionRunner state machine', () => {
  it('walks the errand end to end', () => {
    const r = new MissionRunner();
    const errand = MISSIONS.find((x) => x.id === 'queen_street_errand')!;
    expect(r.start(errand)).toBe(true);
    expect(r.currentStep?.id).toBe('pickup');
    // Too far away: no completion.
    expect(r.tryInteract({ x: 9999, z: 9999 })).toBe(false);
    expect(r.tryInteract(errand.steps[0].pos!)).toBe(true);
    expect(r.currentStep?.id).toBe('dropoff');
    expect(r.tryInteract(errand.steps[1].pos!)).toBe(true);
    expect(r.active).toBeNull();
    expect(r.completed.has('queen_street_errand')).toBe(true);
    const evts = r.drainEvents();
    expect(evts.map((e) => e.type)).toEqual(['started', 'step', 'completed']);
  });

  it('cap_wheels: steal completes on entering a parked car, drop on arrival in a car', () => {
    const r = new MissionRunner();
    const cap = MISSIONS.find((x) => x.id === 'cap_wheels')!;
    r.start(cap);
    r.update(cap.steps[1].pos!, true); // delivering before stealing does nothing
    expect(r.currentStep?.id).toBe('steal');
    r.notifyEnteredParkedCar();
    expect(r.currentStep?.id).toBe('drop');
    r.update(cap.steps[1].pos!, false); // on foot does not count
    expect(r.currentStep?.id).toBe('drop');
    r.update(cap.steps[1].pos!, true);
    expect(r.active).toBeNull();
    expect(r.completed.has('cap_wheels')).toBe(true);
  });

  it('completed missions are not available again', () => {
    const r = new MissionRunner(['queen_street_errand']);
    expect(r.available().map((m) => m.id)).toEqual([
      'cap_wheels',
      'downtown_burner',
      'george_street_drop',
    ]);
  });

  it('downtown_burner is timed; george_street_drop is a two-step foot job', () => {
    const burner = MISSIONS.find((x) => x.id === 'downtown_burner')!;
    expect(burner.timeLimitSec).toBe(80);
    expect(burner.payout).toBe(400);
    expect(burner.steps.map((s) => s.kind)).toEqual(['steal_vehicle', 'deliver_vehicle']);
    const drop = MISSIONS.find((x) => x.id === 'george_street_drop')!;
    expect(drop.timeLimitSec).toBeUndefined();
    expect(drop.payout).toBe(300);
    expect(drop.steps.map((s) => s.kind)).toEqual(['interact', 'interact']);
  });

  it('timed mission fails on expiry and can be re-taken', () => {
    const r = new MissionRunner();
    const burner = MISSIONS.find((x) => x.id === 'downtown_burner')!;
    r.start(burner);
    expect(r.timeLeft).toBe(80);
    r.tick(30);
    expect(r.active?.id).toBe('downtown_burner');
    r.tick(60);
    expect(r.active).toBeNull();
    expect(r.completed.has('downtown_burner')).toBe(false);
    expect(r.drainEvents().map((e) => e.type)).toEqual(['started', 'failed']);
    expect(r.available().map((m) => m.id)).toContain('downtown_burner');
  });
});
