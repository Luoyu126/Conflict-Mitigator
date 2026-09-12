import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_VAD_ANCHORS, VAD_ANCHORS, projectVoiceVad } from '../lib/vad.ts';
const scores = weights => Object.keys(VOICE_VAD_ANCHORS).map(name => ({ name, score: weights[name] ?? 0 }));

test('voice VAD covers all 48 labels and shares camera anchors for comparable categories', () => {
  assert.equal(Object.keys(VOICE_VAD_ANCHORS).length, 48);
  for (const [voice, face] of Object.entries({ Anger: 'anger', Fear: 'fear', Disgust: 'disgust', Sadness: 'sadness', Joy: 'happiness', Calmness: 'neutral' })) {
    const { intensity, ...point } = projectVoiceVad(scores({ [voice]: 1 }));
    assert.deepEqual(point, VAD_ANCHORS[face]);
    assert.ok(intensity >= 0 && intensity <= 1);
  }
  assert.ok(projectVoiceVad(scores({ Fear: 1 })).d < 0);
  assert.ok(projectVoiceVad(scores({ Anger: 1 })).d > 0);
  assert.equal(projectVoiceVad(scores({ Calmness: 1 })).intensity, 0);
});

test('voice mixtures normalize scores without assuming a probability distribution', () => {
  const p = projectVoiceVad(scores({ Joy: .5, Calmness: .5 }));
  assert.ok(Math.abs(p.v - .45) < 1e-12);
  const scaled = projectVoiceVad(scores({ Joy: .1, Calmness: .1 }));
  for (const key of ['v', 'a', 'd', 'intensity']) assert.ok(Math.abs(scaled[key] - p[key]) < 1e-12);
  for (let i = 0; i < 30; i++) {
    const values = scores({}).map((s, n) => ({ ...s, score: ((i * 13 + n * 17) % 100) / 100 }));
    const p = projectVoiceVad(values);
    assert.ok(p.v >= -1 && p.v <= 1 && p.a >= 0 && p.a <= 1 && p.d >= -1 && p.d <= 1);
  }
});

test('missing, duplicate, unknown, zero and malformed voice scores stay unknown', () => {
  const good = scores({ Anger: 1 });
  for (const bad of [[], good.slice(1), scores({}), scores({ Anger: NaN }), scores({ Anger: -1 }), scores({ Anger: 2 }),
    good.map(() => good[0]), good.map((s, i) => i ? s : { name: 'not-an-emotion', score: 1 })]) {
    assert.equal(projectVoiceVad(bad), null);
  }
});
