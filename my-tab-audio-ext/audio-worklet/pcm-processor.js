// audio-worklet/pcm-processor.js
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.chunkSize = opts.chunkSize || 2048;
    this.buffer = new Float32Array(0);
    this.meterEveryNChunks = Math.max(1, opts.meterEveryNChunks || 8);
    this._chunksSinceMeter = 0;
  }

  _emitChunks() {
    while (this.buffer.length >= this.chunkSize) {
      const slice = this.buffer.subarray(0, this.chunkSize);

      // ---- meter (rms/peak) ----
      this._chunksSinceMeter++;
      if (this._chunksSinceMeter >= this.meterEveryNChunks) {
        this._chunksSinceMeter = 0;

        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < slice.length; i++) {
          const v = slice[i];
          const av = Math.abs(v);
          if (av > peak) peak = av;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / slice.length);
        this.port.postMessage({ type: "meter", rms, peak });
      }

      // ---- pcm int16 ----
      const out = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        let s = Math.max(-1, Math.min(1, slice[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: "pcm-int16", payload: out.buffer }, [out.buffer]);

      this.buffer = this.buffer.subarray(this.chunkSize);
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const ch = input[0];
      const merged = new Float32Array(this.buffer.length + ch.length);
      merged.set(this.buffer, 0);
      merged.set(ch, this.buffer.length);
      this.buffer = merged;
      this._emitChunks();
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
