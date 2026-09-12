import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFaceResult, jpegDimensions, emotionNames } from '../lib/face-emotion.ts';

test('face results discard identifiers and reject ambiguous or malformed predictions', () => {
  const emotion = Object.fromEntries(Object.keys(emotionNames).map(name => [name, name === 'neutral' ? 100 : 0]));
  const face = { face_token: 'private-token', attributes: { emotion } };
  const result = parseFaceResult({ faces: [face], image_id: 'private-image' });
  assert.equal(result.status, 'ok');
  assert.equal(result.scores[0].name, 'neutral');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(parseFaceResult({ faces: [] }).reason, 'no_face');
  assert.equal(parseFaceResult({ faces: [face, face] }).reason, 'multiple_faces');
  assert.equal(parseFaceResult({ faces: [{ attributes: { emotion: { neutral: 100 } } }] }).status, 'unavailable');
  assert.equal(parseFaceResult({ faces: [{ attributes: { emotion, blur: { blurness: { value: 80, threshold: 50 } } } }] }).reason, 'low_quality');
  assert.throws(() => parseFaceResult({ error_message: 'failed' }));
});

test('JPEG dimensions reject truncated and non-JPEG payloads', () => {
  assert.equal(jpegDimensions(new Uint8Array()), null);
  assert.equal(jpegDimensions(new Uint8Array([255, 216, 255, 192, 0, 20])), null);
  assert.deepEqual(jpegDimensions(new Uint8Array([255, 216, 255, 192, 0, 8, 8, 1, 104, 2, 128, 1])), { width: 640, height: 360 });
});
