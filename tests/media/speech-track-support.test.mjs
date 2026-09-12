import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsMeetingTrackSpeech, startMeetingTrackSpeech } from '../../lib/media/speech-track-support.ts';

const chrome = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36',
  vendor: 'Google Inc.',
  userAgentData: { brands: [{ brand: 'Chromium', version: '135' }, { brand: 'Google Chrome', version: '135' }, { brand: 'Not_A Brand', version: '24' }], mobile: false, platform: 'Linux' },
};
const audio = { kind: 'audio', readyState: 'live', enabled: true };

test('unsupported browsers never invoke even a legacy start that silently ignores arguments', () => {
  let microphoneStarts = 0;
  const legacyRecognition = { start() { microphoneStarts++; } };
  const cases = [
    { ...chrome, userAgentData: undefined },
    { ...chrome, userAgent: chrome.userAgent.replace('135.0', '134.0') },
    { ...chrome, userAgentData: { ...chrome.userAgentData, brands: [{ brand: 'Chromium', version: '134' }] } },
    { ...chrome, userAgentData: { ...chrome.userAgentData, mobile: true } },
    { ...chrome, userAgentData: { ...chrome.userAgentData, platform: 'Android' } },
    { ...chrome, userAgentData: { ...chrome.userAgentData, platform: 'Chrome OS' } },
    { ...chrome, userAgentData: { ...chrome.userAgentData, platform: 'Unknown' } },
    { ...chrome, vendor: 'Apple Computer, Inc.' },
    { ...chrome, userAgent: chrome.userAgent + ' Edg/135.0' },
    { ...chrome, userAgentData: { ...chrome.userAgentData, brands: [{ brand: 'Chromium', version: '135' }, { brand: 'Unknown browser', version: '135' }] } },
  ];
  for (const browser of cases) {
    assert.equal(supportsMeetingTrackSpeech(browser), false);
    assert.equal(startMeetingTrackSpeech(legacyRecognition, audio, browser), false);
  }
  assert.equal(microphoneStarts, 0);
});

test('allowlisted desktop browsers receive exactly the existing meeting audio track', () => {
  for (const platform of ['Windows', 'macOS', 'Linux']) {
    let argumentsReceived;
    const recognition = { start(...args) { argumentsReceived = args; } };
    assert.equal(startMeetingTrackSpeech(recognition, audio, { ...chrome, userAgentData: { ...chrome.userAgentData, platform } }), true);
    assert.deepEqual(argumentsReceived, [audio]);
    assert.equal(argumentsReceived[0], audio);
  }
});

test('missing live audio and recognition errors never fall back to another input', () => {
  let starts = 0;
  const recognition = { start() { starts++; throw new Error('recognition unavailable'); } };
  for (const track of [{ ...audio, kind: 'video' }, { ...audio, readyState: 'ended' }, { ...audio, enabled: false }]) {
    assert.equal(startMeetingTrackSpeech(recognition, track, chrome), false);
  }
  assert.equal(starts, 0);
  assert.throws(() => startMeetingTrackSpeech(recognition, audio, chrome), /recognition unavailable/);
  assert.equal(starts, 1);
});
