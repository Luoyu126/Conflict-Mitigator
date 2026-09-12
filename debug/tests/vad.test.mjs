import test from 'node:test';
import assert from 'node:assert/strict';
import { VAD_ANCHORS, VAD_FRESH_MS, appendVadTrail, projectVad, vadIntensity } from '../lib/vad.ts';
const make = (weights) => ({ status: 'ok', reason: null, faceCount: 1, scores: Object.keys(VAD_ANCHORS).map(name => ({ name, label: name, score: weights[name] ?? 0 })) });

test('VAD has a neutral origin, preserves positive activation, and distinguishes fear from anger', () => {
  assert.deepEqual(projectVad(make({ neutral: 100 })), { v: 0, a: 0, d: 0, intensity: 0 });
  const happy = projectVad(make({ happiness: 100 }));
  assert.ok(happy.v > 0 && happy.intensity > .6);
  const fear = projectVad(make({ fear: 100 }));
  const anger = projectVad(make({ anger: 100 }));
  assert.ok(fear.d < 0 && anger.d > 0);
  assert.equal(fear.a, anger.a);
  assert.ok(fear.intensity > .8 && anger.intensity > .8);
});

test('weighted mixtures normalize rounding and stay within documented axes and intensity bounds', () => {
  const mixture = projectVad(make({ happiness: 49, neutral: 49 }));
  assert.ok(Math.abs(mixture.v - .45) < 1e-12);
  assert.ok(Math.abs(mixture.intensity - vadIntensity(VAD_ANCHORS.happiness) / 2) < 1e-12);
  for (let i = 0; i < 100; i++) {
    const weights = Object.fromEntries(Object.keys(VAD_ANCHORS).map((name, n) => [name, (i * 17 + n * 13) % 101]));
    const p = projectVad(make(weights));
    assert.ok(p.v >= -1 && p.v <= 1 && p.a >= 0 && p.a <= 1 && p.d >= -1 && p.d <= 1);
    assert.ok(p.intensity >= 0 && p.intensity <= 1);
    assert.equal(p.intensity, vadIntensity(p));
  }
});

test('missing data is null rather than calm; malformed and duplicate scores cannot produce a vector', () => {
  const valid = make({ neutral: 100 });
  for (const bad of [
    { ...valid, status: 'unavailable' }, { ...valid, faceCount: 2 }, make({}),
    make({ neutral: NaN }), make({ neutral: -1 }), make({ neutral: 101 }),
    { ...valid, scores: valid.scores.slice(1) },
    { ...valid, scores: valid.scores.map(() => valid.scores[0]) },
    { ...valid, scores: valid.scores.map((s, i) => i ? s : { ...s, name: 'unknown' }) },
  ]) assert.equal(projectVad(bad), null);
});

test('trail resets on unknown or long gaps and has time and count bounds', () => {
  const p = VAD_ANCHORS.anger;
  let trail = [];
  for (let i = 0; i < 40; i++) trail = appendVadTrail(trail, p, i * 2000);
  assert.ok(trail.length <= 24);
  assert.ok(trail.every(s => 78000 - s.at <= 30000));
  assert.deepEqual(appendVadTrail(trail, null, 79000), []);
  assert.equal(appendVadTrail(trail, p, 78000 + VAD_FRESH_MS + 1).length, 1);
});
