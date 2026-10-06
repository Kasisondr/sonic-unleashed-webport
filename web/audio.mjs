export class MenuAudio {
  constructor(manifest, volume = 0.5) {
    this.manifest = manifest;
    this.volume = volume;
    this.buffers = new Map(); this.pending = new Map();
    this.enabled = false; this.generation = 0;
    this.musicEnabled = true; this.effectsEnabled = true;
  }
  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain(); this.gain.gain.value = this.volume;
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 256;
      this.gain.connect(this.analyser); this.analyser.connect(this.context.destination);
      this.samples = new Float32Array(this.analyser.fftSize);
    }
    await this.context.resume();
    this.enabled = this.context.state === 'running';
    return this.enabled;
  }
  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.025);
  }
  async load(name) {
    if (this.buffers.has(name)) return this.buffers.get(name);
    if (this.pending.has(name)) return this.pending.get(name);
    const promise = (async () => {
      const response = await fetch(`assets/${this.manifest[name].file}`);
      if (!response.ok) throw new Error(`Audio file unavailable: ${name}`);
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      const meta = this.manifest[name];
      if (Math.abs(buffer.duration - meta.samples / meta.sample_rate) > 0.01) throw new Error(`Audio duration mismatch: ${name}`);
      this.buffers.set(name, buffer); return buffer;
    })();
    this.pending.set(name, promise);
    try { return await promise; } finally { this.pending.delete(name); }
  }
  stopMusic() {
    this.generation++;
    if (this.music) { this.music.stop(); this.music.disconnect(); this.music = null; }
    this.track = null;
  }
  async playMusic(name) {
    if (!this.enabled || !this.musicEnabled) return;
    if (this.track === name && this.music) return;
    this.stopMusic(); const generation = this.generation;
    const buffer = await this.load(name);
    if (generation !== this.generation) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.loop = true;
    const meta = this.manifest[name];
    source.loopStart = (meta.loop_start ?? 0) / meta.sample_rate;
    source.loopEnd = (meta.loop_end ?? meta.samples) / meta.sample_rate;
    source.connect(this.gain); source.start(); this.music = source; this.track = name;
  }
  async effect(name) {
    if (!this.enabled || !this.effectsEnabled) return;
    const buffer = await this.load(name), source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.gain); source.start();
    source.onended = () => source.disconnect();
  }
  async pause() { if (this.context) await this.context.suspend(); }
  async resume() { if (this.context && this.enabled) await this.context.resume(); }
  rms() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return Math.sqrt(this.samples.reduce((sum, sample) => sum + sample * sample, 0) / this.samples.length);
  }
}
