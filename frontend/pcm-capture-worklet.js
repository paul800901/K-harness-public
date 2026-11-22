// Collects microphone samples (the context runs at 16 kHz) into 100 ms frames for the voice call.
class KPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(1600);
    this.length = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.frame[this.length++] = input[i];
        if (this.length === this.frame.length) {
          this.port.postMessage(this.frame);
          this.frame = new Float32Array(1600);
          this.length = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('k-pcm-capture', KPcmCapture);
