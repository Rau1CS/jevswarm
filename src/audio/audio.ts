/**
 * Procedural soundscape (WebAudio, no assets): wind, fire bed + crackle, rotor hum,
 * radio-style UI notifications, critical alert, suppression drop. Deliberately quiet.
 */
export class SoundScape {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private windG!: GainNode;
  private fireG!: GainNode;
  private rotorG!: GainNode;
  private noise!: AudioBuffer;
  private fireLevel = 0;
  muted = false;

  start(): void {
    if (this.ctx) return;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(comp).connect(ctx.destination);
    // Shared noise buffer.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < data.length; i++) {
      const w = Math.random() * 2 - 1;
      b = (b + 0.02 * w) / 1.02; // brown-ish
      data[i] = w * 0.5 + b * 3;
    }
    // Wind.
    this.windG = ctx.createGain();
    this.windG.gain.value = 0.08;
    const wn = this.loopNoise();
    const wl = ctx.createBiquadFilter();
    wl.type = 'lowpass';
    wl.frequency.value = 420;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 180;
    lfo.connect(lfoG).connect(wl.frequency);
    lfo.start();
    wn.connect(wl).connect(this.windG).connect(this.master);
    // Fire bed.
    this.fireG = ctx.createGain();
    this.fireG.gain.value = 0;
    const fn = this.loopNoise();
    const fb = ctx.createBiquadFilter();
    fb.type = 'bandpass';
    fb.frequency.value = 700;
    fb.Q.value = 0.6;
    fn.connect(fb).connect(this.fireG).connect(this.master);
    // Rotors: detuned saws + blade-pass tremolo.
    this.rotorG = ctx.createGain();
    this.rotorG.gain.value = 0;
    const rl = ctx.createBiquadFilter();
    rl.type = 'lowpass';
    rl.frequency.value = 850;
    const trem = ctx.createGain();
    trem.gain.value = 0.7;
    const am = ctx.createOscillator();
    am.frequency.value = 31;
    const amG = ctx.createGain();
    amG.gain.value = 0.3;
    am.connect(amG).connect(trem.gain);
    am.start();
    for (const f of [184, 191, 203, 212]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.05;
      o.connect(g).connect(rl);
      o.start();
    }
    const wash = this.loopNoise();
    const wb = ctx.createBiquadFilter();
    wb.type = 'bandpass';
    wb.frequency.value = 1600;
    wb.Q.value = 1.2;
    const wg = ctx.createGain();
    wg.gain.value = 0.25;
    wash.connect(wb).connect(wg).connect(rl);
    rl.connect(trem).connect(this.rotorG).connect(this.master);
  }

  private loopNoise(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 1.5);
    return s;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.1);
  }

  /** fire, drones, wind: 0..1 proximity-weighted levels. */
  setLevels(fire: number, drones: number, wind: number): void {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime;
    this.fireLevel = fire;
    this.fireG.gain.setTargetAtTime(fire * 0.22, t, 0.4);
    this.rotorG.gain.setTargetAtTime(drones * 0.16, t, 0.3);
    this.windG.gain.setTargetAtTime(0.05 + wind * 0.08, t, 0.8);
    // Crackle.
    if (Math.random() < fire * 0.5) this.burst(2200 + Math.random() * 3000, 0.02 + Math.random() * 0.03, fire * (0.05 + Math.random() * 0.1), 'highpass');
  }

  private burst(freq: number, dur: number, gain: number, type: BiquadFilterType, sweepTo?: number): void {
    const c = this.ctx!;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, c.currentTime + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(0, Math.random());
    s.stop(c.currentTime + dur + 0.05);
  }

  private tone(freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine', glideTo?: number): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime + start);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, c.currentTime + start + dur);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(0, c.currentTime + start);
    g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(bp).connect(g).connect(this.master);
    o.start(c.currentTime + start);
    o.stop(c.currentTime + start + dur + 0.05);
  }

  blip(): void {
    if (!this.ctx) return;
    this.tone(1320, 0, 0.07, 0.05, 'sine', 900);
  }
  radio(): void {
    if (!this.ctx) return;
    this.burst(1800, 0.06, 0.03, 'bandpass');
    this.tone(1050, 0.04, 0.06, 0.05, 'square');
    this.tone(1560, 0.12, 0.08, 0.05, 'square');
  }
  alert(): void {
    if (!this.ctx) return;
    [0, 0.16, 0.32].forEach((s, i) => this.tone(i % 2 ? 988 : 740, s, 0.13, 0.06, 'square'));
  }
  drop(): void {
    if (!this.ctx) return;
    this.burst(3200, 1.3, 0.28, 'lowpass', 300);
  }
  whoosh(): void {
    if (!this.ctx) return;
    this.burst(300, 2.2, 0.2, 'lowpass', 1400);
  }
  get fire(): number {
    return this.fireLevel;
  }
}
