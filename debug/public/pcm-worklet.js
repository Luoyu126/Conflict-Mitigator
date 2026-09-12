class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(Math.round(sampleRate / 10));
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      const bounded = Math.max(-1, Math.min(1, sample));
      this.samples[this.offset++] = Math.round(bounded * (bounded < 0 ? 32768 : 32767));
      if (this.offset === this.samples.length) {
        // Explicit little endian: the EVI session declares linear16.
        const buffer = new ArrayBuffer(this.samples.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < this.samples.length; i++) view.setInt16(i * 2, this.samples[i], true);
        this.port.postMessage(buffer, [buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
