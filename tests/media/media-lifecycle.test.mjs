import test from "node:test";
import assert from "node:assert/strict";
import { MeetingMediaLifecycle } from "../../lib/media/meeting-media-lifecycle.ts";

test("teardown stops existing and late captures and cancels queued device changes", async () => {
  let stopCount = 0;
  let finishCapture;
  let queuedRan = false;
  const lifecycle = new MeetingMediaLifecycle(() => { stopCount += 1; });
  const capture = lifecycle.run(() => new Promise(resolve => { finishCapture = resolve; }));
  await Promise.resolve();
  const queued = lifecycle.run(async () => { queuedRan = true; });
  const captureRejected = assert.rejects(capture, /no longer active/);
  const queuedRejected = assert.rejects(queued, /no longer active/);
  lifecycle.stop();
  assert.equal(stopCount, 1);
  finishCapture();
  await Promise.all([captureRejected, queuedRejected]);
  assert.equal(stopCount, 2);
  assert.equal(queuedRan, false);
});

test("device changes serialize and a failed capture does not block a later toggle", async () => {
  const lifecycle = new MeetingMediaLifecycle(() => {});
  const changes = [];
  const first = lifecycle.run(async () => {
    changes.push("camera-start");
    await Promise.resolve();
    changes.push("camera-error");
    throw new Error("permission denied");
  });
  const second = lifecycle.run(async () => { changes.push("microphone"); return true; });
  await assert.rejects(first, /permission denied/);
  assert.equal(await second, true);
  assert.deepEqual(changes, ["camera-start", "camera-error", "microphone"]);
});

test("effect reactivation cannot revive a queued operation from the previous mount", async () => {
  const lifecycle = new MeetingMediaLifecycle(() => {});
  let ran = false;
  const oldOperation = lifecycle.run(async () => { ran = true; });
  lifecycle.stop();
  lifecycle.activate();
  await assert.rejects(oldOperation, /no longer active/);
  assert.equal(ran, false);
  assert.equal(await lifecycle.run(async () => "new mount"), "new mount");
});
