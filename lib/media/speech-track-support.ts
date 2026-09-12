/**
 * Conservative allowlist, not a permission/capture probe. Calling start(track)
 * on a legacy implementation may silently call its microphone-only overload.
 * Chromium exposes no separate feature detector for the track overload.
 * Desktop shipment: https://chromestatus.com/feature/5178378197139456
 * Stable platforms (Linux/Mac/Win), MediaStreamTrackWebSpeech:
 * https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/runtime_enabled_features.json5
 * Keep unknown browsers, mobile and ChromeOS disabled rather than testing start().
 */
export type SpeechBrowserInfo = {
  userAgent: string;
  vendor: string;
  userAgentData?: {
    brands: readonly { brand: string; version: string }[];
    mobile: boolean;
    platform: string;
  };
};

export function supportsMeetingTrackSpeech(browser: SpeechBrowserInfo): boolean {
  const hints = browser.userAgentData;
  if (!hints || hints.mobile || !["Windows", "macOS", "Linux"].includes(hints.platform)) return false;
  if (browser.vendor !== "Google Inc." || /Android|iPhone|iPad|CrOS|Edg\/|OPR\//i.test(browser.userAgent)) return false;
  const version = browser.userAgent.match(/(?:Chrome|HeadlessChrome)\/(\d+)\./)?.[1];
  if (!version || Number(version) < 135) return false;
  const brands = hints.brands.filter(item => !/^Not(?:[^a-z]|$)/i.test(item.brand));
  if (!brands.length || brands.some(item => !["Chromium", "Google Chrome"].includes(item.brand))) return false;
  return brands.some(item => item.brand === "Chromium") && brands.every(item => /^\d+$/.test(item.version) && Number(item.version) >= 135);
}

/** Never falls back to start() without the meeting-owned audio track. */
export function startMeetingTrackSpeech(
  recognition: { start(track: MediaStreamTrack): void },
  track: MediaStreamTrack,
  browser: SpeechBrowserInfo,
): boolean {
  if (!supportsMeetingTrackSpeech(browser) || track.kind !== "audio" || track.readyState !== "live" || !track.enabled) return false;
  recognition.start(track);
  return true;
}
