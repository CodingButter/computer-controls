// The capture worklet: Float32 frames from the mic graph become 16-bit PCM
// for the realtime session. It does exactly one conversion and nothing else —
// resampling to 16 kHz is the AudioContext's job (the context is constructed
// at that rate), and deciding whether audio may leave the machine is the
// mouth's job. A worklet that made policy decisions would be a second gate
// nobody audits.
class Pcm16Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length) {
      const out = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        const sample = Math.max(-1, Math.min(1, channel[i]));
        out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      // Transferred, not copied: this runs on the audio thread at 128-frame
      // cadence, and a copy per block is garbage the render quantum pays for.
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm16-capture", Pcm16Capture);
