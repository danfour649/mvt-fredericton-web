// Build-output checks (same pattern as maps-of-nb web/test/build.test.mjs):
// run after `npm run build`; asserts the dist bundle is complete and the
// game data shipped with the right shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

test('dist has an index.html that loads a module bundle', () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.match(html, /MVT Fredericton/);
  assert.match(html, /type="module"/);
  const assets = readdirSync(join(dist, 'assets'));
  assert.ok(assets.some((f) => f.endsWith('.js')), 'expected a JS bundle in dist/assets');
});

test('dist ships downtown.json with buildings and roads', () => {
  const p = join(dist, 'data', 'downtown.json');
  assert.ok(existsSync(p), 'missing dist/data/downtown.json');
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(doc.buildings.features.length > 1000, `buildings: ${doc.buildings.features.length}`);
  assert.ok(doc.roads.features.length > 150, `roads: ${doc.roads.features.length}`);
  const b = doc.buildings.features[0];
  assert.equal(b.geometry.type, 'Polygon');
  assert.ok('max_b_elev' in b.properties && 'min_g_elev' in b.properties);
});

test('dist ships the Saint John River as water features (v0.28)', () => {
  const p = join(dist, 'data', 'downtown.json');
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(doc.water, 'downtown.json has no water collection');
  assert.ok(doc.water.features.length >= 1, `water features: ${doc.water.features.length}`);
  for (const f of doc.water.features) {
    assert.equal(f.properties.NAME1, 'Saint John River');
    assert.ok(f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
  }
  assert.equal(doc.meta.counts.water, doc.water.features.length);
});

test('dist ships the full-city PMTiles archive', () => {
  const p = join(dist, 'fredericton.pmtiles');
  assert.ok(existsSync(p), 'missing dist/fredericton.pmtiles');
  assert.ok(statSync(p).size > 1_000_000, 'pmtiles suspiciously small');
});
