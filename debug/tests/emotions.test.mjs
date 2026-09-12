import test from "node:test";
import assert from "node:assert/strict";
import { isEmotionOrigin, parseEmotionMessage } from "../lib/emotions.ts";

test("EVI relay requires a loopback host and exact local app origin", () => {
  assert.equal(isEmotionOrigin("http://localhost:3001", "127.0.0.1:3002"), true);
  for (const origin of [undefined, "null", "https://evil.test", "http://localhost:3001.evil.test", "http://localhost:3003", "http://localhost:3001/path"]) {
    assert.equal(isEmotionOrigin(origin, "127.0.0.1:3002"), false);
  }
  assert.equal(isEmotionOrigin("http://localhost:3001", "evil.test:3002"), false);
});

test("only audio user events become observations; missing scores remain unknown", () => {
  assert.equal(parseEmotionMessage({ type: "assistant_message" }), null);
  assert.equal(parseEmotionMessage({ type: "user_message", from_text: true }), null);
  const event = { type: "user_message", from_text: false, interim: false, message: { content: "Hello" }, time: { begin: 100, end: 900 } };
  assert.deepEqual(parseEmotionMessage(event).scores, []);
  const result = parseEmotionMessage({ ...event, models: { prosody: { scores: { Anger: .2, Calmness: .8, invalid: "0.9", negative: -1, infinite: Infinity } } } });
  assert.deepEqual(result.scores, [{ name: "Calmness", score: .8 }, { name: "Anger", score: .2 }]);
  assert.equal(result.startMs, 100); assert.equal(result.text, "Hello");
  assert.equal("models" in result, false);
});
