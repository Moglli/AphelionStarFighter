/**
 * @file Audio system — procedural SFX via Web Audio API + a slow ambient drone.
 *
 * Everything is synthesized at runtime: no asset files ship in the bundle.
 * Future audio packs (Phase 3) can swap in sample-based playback via the
 * same {@link AudioSystem} interface.
 *
 * The system subscribes to the event bus on construction. Game code emits
 * events ({@link events}); this module decides what to play. Volumes are
 * pulled from {@link saveStore}.settings and respected on every emission.
 *
 * Autoplay rules: browsers block AudioContext from starting until a user
 * gesture. We lazy-create the context on the first user interaction
 * (pointerdown / keydown) and resume on every subsequent gesture.
 */

import { events } from "./events.js";
import { saveStore } from "./save.js";

const MAX_VOICES = 24;
const AMBIENT_BASE_HZ = 55;

class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.musicNodes = null;
    this.voices = 0;
    this.unlocked = false;
    this._installUnlockListeners();
    this._subscribe();
  }

  _installUnlockListeners() {
    if (typeof window === "undefined") return;
    const unlock = () => {
      this._ensureContext();
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      this.unlocked = true;
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });
    window.addEventListener("touchstart", unlock, { passive: true });
  }

  _ensureContext() {
    if (this.ctx) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      console.warn("[audio] Web Audio API unavailable");
      return;
    }
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this._applyVolumes();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
  }

  _applyVolumes() {
    if (!this.ctx) return;
    const s = saveStore.get().settings;
    if (this.sfxBus) this.sfxBus.gain.value = s.sfxVolume;
    if (this.musicBus) this.musicBus.gain.value = s.musicVolume;
  }

  setVolumes({ sfx, music }) {
    saveStore.update((data) => {
      if (typeof sfx === "number") data.settings.sfxVolume = sfx;
      if (typeof music === "number") data.settings.musicVolume = music;
    });
    this._applyVolumes();
  }

  /** Subscribe to gameplay events. Audio decisions live here, not in game code. */
  _subscribe() {
    events.on("weaponFired", ({ ship, kind }) => {
      if (!ship) return;
      // Throttle: AI fleets fire constantly; only player + nearby ships
      // play SFX so the audio bed stays readable.
      if (!ship.isPlayer && this.voices >= MAX_VOICES * 0.5) return;
      if (kind === "missile") this.missileLaunch(ship.isPlayer ? 1 : 0.55);
      else if (kind === "laser") this.laserBeam(ship.isPlayer ? 1 : 0.55);
      else if (kind === "broadside") this.broadside(ship.isPlayer ? 1 : 0.55);
      else this.cannonShot(ship.isPlayer ? 1 : 0.4);
    });
    events.on("hit", ({ ship, layer, byPlayer }) => {
      // Only emit SFX when the player is the one dealing damage, to
      // avoid an AI-vs-AI cacophony.
      if (!byPlayer && !ship.isPlayer) return;
      if (layer === "shield") this.shieldPing(0.7);
      else if (layer === "armor") this.armorClang(0.85);
      else this.hullThud(0.9);
    });
    events.on("shipDestroyed", ({ ship, byPlayer }) => {
      const isBig = ship.klass === "cruiser" || ship.klass === "battleship"
                 || ship.klass === "carrier";
      this.explosion(isBig ? 1.0 : 0.6, byPlayer ? 1.1 : 0.7);
    });
    events.on("playerDestroyed", () => this.explosion(1.2, 1.2));
    events.on("matchEnded", ({ winner }) => {
      this.matchSting(winner === "blue");
      this.musicFadeOut();
    });
    events.on("uiClick", () => this.uiTap());
    events.on("waveStarted", () => this.uiTap(1200, 0.06));
  }

  // ---------------------------------------------------------------------
  // Voice plumbing.
  // ---------------------------------------------------------------------

  _node(type, freq) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  _envelope(node, dest, attack, decay, peak) {
    const g = this.ctx.createGain();
    const now = this.ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
    node.connect(g);
    g.connect(dest);
    return { gain: g, end: now + attack + decay };
  }

  _track(end) {
    this.voices++;
    const ms = Math.max(50, (end - this.ctx.currentTime) * 1000 + 80);
    setTimeout(() => { this.voices = Math.max(0, this.voices - 1); }, ms);
  }

  _noiseBuffer(duration) {
    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * duration));
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  _playReady() {
    if (!this.unlocked) return false;
    this._ensureContext();
    if (!this.ctx) return false;
    if (this.voices >= MAX_VOICES) return false;
    return true;
  }

  // ---------------------------------------------------------------------
  // SFX procedures.
  // ---------------------------------------------------------------------

  cannonShot(level = 1) {
    if (!this._playReady()) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.08);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1400;
    bp.Q.value = 4;
    const e = this._envelope(bp, this.sfxBus, 0.002, 0.07, 0.35 * level);
    src.connect(bp);
    src.start();
    src.stop(e.end);
    this._track(e.end);
  }

  broadside(level = 1) {
    if (!this._playReady()) return;
    // Big slow boom: low sine thump + noise body.
    const sine = this._node("sine", 90);
    const eSine = this._envelope(sine, this.sfxBus, 0.005, 0.45, 0.6 * level);
    sine.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.4);
    sine.start();
    sine.stop(eSine.end);

    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.3);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 800;
    const eN = this._envelope(lp, this.sfxBus, 0.005, 0.3, 0.4 * level);
    src.connect(lp);
    src.start();
    src.stop(eN.end);
    this._track(eN.end);
  }

  missileLaunch(level = 1) {
    if (!this._playReady()) return;
    const osc = this._node("sawtooth", 380);
    osc.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.35);
    const e = this._envelope(osc, this.sfxBus, 0.01, 0.34, 0.28 * level);
    osc.start();
    osc.stop(e.end);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this._noiseBuffer(0.3);
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1200;
    const eN = this._envelope(hp, this.sfxBus, 0.005, 0.28, 0.18 * level);
    noise.connect(hp);
    noise.start();
    noise.stop(eN.end);
    this._track(e.end);
  }

  laserBeam(level = 1) {
    if (!this._playReady()) return;
    const osc = this._node("sawtooth", 2200);
    osc.frequency.exponentialRampToValueAtTime(900, this.ctx.currentTime + 0.45);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    osc.connect(lp);
    const e = this._envelope(lp, this.sfxBus, 0.01, 0.45, 0.32 * level);
    osc.start();
    osc.stop(e.end);
    this._track(e.end);
  }

  shieldPing(level = 1) {
    if (!this._playReady()) return;
    const osc = this._node("sine", 1500);
    osc.frequency.exponentialRampToValueAtTime(2400, this.ctx.currentTime + 0.12);
    const e = this._envelope(osc, this.sfxBus, 0.001, 0.13, 0.18 * level);
    osc.start();
    osc.stop(e.end);
    this._track(e.end);
  }

  armorClang(level = 1) {
    if (!this._playReady()) return;
    const osc = this._node("triangle", 380);
    osc.frequency.exponentialRampToValueAtTime(120, this.ctx.currentTime + 0.18);
    const e = this._envelope(osc, this.sfxBus, 0.001, 0.2, 0.28 * level);
    osc.start();
    osc.stop(e.end);
    this._track(e.end);
  }

  hullThud(level = 1) {
    if (!this._playReady()) return;
    const osc = this._node("square", 110);
    osc.frequency.exponentialRampToValueAtTime(50, this.ctx.currentTime + 0.12);
    const e = this._envelope(osc, this.sfxBus, 0.001, 0.14, 0.24 * level);
    osc.start();
    osc.stop(e.end);
    this._track(e.end);
  }

  explosion(scale = 1, level = 1) {
    if (!this._playReady()) return;
    const dur = 0.45 + scale * 0.4;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600 + scale * 1200;
    lp.frequency.exponentialRampToValueAtTime(120, this.ctx.currentTime + dur);
    const e = this._envelope(lp, this.sfxBus, 0.005, dur, 0.55 * level);
    src.connect(lp);
    src.start();
    src.stop(e.end);

    const thump = this._node("sine", 70);
    thump.frequency.exponentialRampToValueAtTime(28, this.ctx.currentTime + dur * 0.8);
    const eT = this._envelope(thump, this.sfxBus, 0.005, dur * 0.9, 0.45 * level);
    thump.start();
    thump.stop(eT.end);
    this._track(e.end);
  }

  matchSting(victory) {
    if (!this._playReady()) return;
    const root = victory ? 220 : 130;
    const intervals = victory ? [0, 7, 12, 16] : [0, -3, -5, -7];
    for (let i = 0; i < intervals.length; i++) {
      const freq = root * Math.pow(2, intervals[i] / 12);
      const osc = this._node("triangle", freq);
      const e = this._envelope(osc, this.sfxBus, 0.02, 0.6, 0.22);
      osc.start(this.ctx.currentTime + i * 0.18);
      osc.stop(e.end + i * 0.18);
    }
    this._track(this.ctx.currentTime + 1.4);
  }

  uiTap(freq = 800, dur = 0.05) {
    if (!this._playReady()) return;
    const osc = this._node("sine", freq);
    const e = this._envelope(osc, this.sfxBus, 0.001, dur, 0.18);
    osc.start();
    osc.stop(e.end);
    this._track(e.end);
  }

  // ---------------------------------------------------------------------
  // Ambient pad — two slowly detuned sines with an LFO-swept lowpass.
  // Fades in when a match starts, out when it ends.
  // ---------------------------------------------------------------------

  musicStart() {
    if (!this.unlocked) return;
    this._ensureContext();
    if (!this.ctx || this.musicNodes) return;
    const a = this._node("sine", AMBIENT_BASE_HZ);
    const b = this._node("sine", AMBIENT_BASE_HZ * 1.503);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    const lfo = this._node("sine", 0.08);
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 350;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    const g = this.ctx.createGain();
    g.gain.value = 0;
    a.connect(lp);
    b.connect(lp);
    lp.connect(g);
    g.connect(this.musicBus);
    const now = this.ctx.currentTime;
    g.gain.linearRampToValueAtTime(0.5, now + 3.0);
    a.start();
    b.start();
    lfo.start();
    this.musicNodes = { a, b, lp, lfo, g };
  }

  musicFadeOut() {
    if (!this.ctx || !this.musicNodes) return;
    const { a, b, lfo, g } = this.musicNodes;
    const now = this.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + 1.5);
    setTimeout(() => {
      try { a.stop(); b.stop(); lfo.stop(); } catch (_e) {}
      this.musicNodes = null;
    }, 1700);
  }
}

export const audio = new AudioSystem();

if (typeof window !== "undefined") {
  window.audio = audio;
}
// Procedural Geometry Dash-style soundtrack synthesised via Web Audio.
// No samples loaded — every voice (kick, snare, hat, sub-bass, bass,
// lead) is generated on the fly from oscillators + filtered noise.
// Patterns are 16th-note arrays at a fixed tempo; a lookahead scheduler
// queues notes 200 ms ahead so timing stays solid even when the
// main thread is busy with gameplay.

const BPM = 154;
const STEPS_PER_BAR = 16;
const BARS = 4;
const TOTAL_STEPS = STEPS_PER_BAR * BARS;
const SECONDS_PER_STEP = 60 / BPM / 4; // 16th notes
const SCHEDULER_TICK_MS = 25;           // how often we wake to schedule
const LOOKAHEAD_S = 0.20;               // how far ahead we queue

// Note frequencies (A minor / Aeolian — the GD default mood).
const A2 = 110.00, C3 = 130.81, D3 = 146.83, E3 = 164.81, F3 = 174.61, G3 = 196.00;
const F2 = 87.31,  G2 = 98.00;
const A3 = 220.00, C4 = 261.63, D4 = 293.66, E4 = 329.63, F4 = 349.23, G4 = 392.00;
const A4 = 440.00, B4 = 493.88, C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880.00;

// 4-on-the-floor kick + ghost notes for energy.
const KICK = [
  1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,1,0,
  1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,1,1,
  1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,1,0,
  1,0,0,0, 1,0,0,0, 1,0,0,1, 1,0,1,1,
];
// Snare on 2 and 4 of every bar.
const SNARE = [
  0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0,
  0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0,
  0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0,
  0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,1,1,
];
// 8th-note hi-hat, with louder ticks on the off-beats (handled in the
// synth by treating 2 as "open"). Last bar adds 16th-note runs.
const HAT = [
  1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,2,0,
  1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0,
  1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,2,0,
  1,1,1,1, 1,0,1,0, 1,1,1,1, 1,1,1,1,
];

// Bass-line root notes per chord. 8th-note rhythm with a 5th flourish
// in the second half of each chord. Numbers are Hz; 0 = rest.
const BASS = [
  // Am
  A2, 0, A2, 0,  A2, 0, A2, 0,   E3, 0, A2, 0,  A2, 0, A2, A2,
  // F
  F2, 0, F2, 0,  F2, 0, F2, 0,   C3, 0, F2, 0,  F2, 0, F2, F2,
  // C
  C3, 0, C3, 0,  C3, 0, C3, 0,   G3, 0, C3, 0,  C3, 0, C3, C3,
  // G
  G2, 0, G2, 0,  G2, 0, G2, 0,   D3, 0, G2, 0,  G2, 0, G2, G2,
];

// Sub-bass: just the root on the downbeat of each bar, doubled an octave
// down for floor-shaking weight.
const SUB = [
  A2/2, 0,0,0, 0,0,0,0, A2/2, 0,0,0, 0,0,0,0,
  F2/2, 0,0,0, 0,0,0,0, F2/2, 0,0,0, 0,0,0,0,
  C3/2, 0,0,0, 0,0,0,0, C3/2, 0,0,0, 0,0,0,0,
  G2/2, 0,0,0, 0,0,0,0, G2/2, 0,0,0, 0,0,0,0,
];

// Lead melody over the i-VI-III-VII progression. Two passes of a four-
// note phrase per bar with rhythmic variation.
const LEAD = [
  // Am — ascending arpeggio
  A4, 0, 0, 0, C5, 0, 0, 0,  E5, 0, 0, 0, A5, 0, E5, 0,
  // F — descending phrase
  F5, 0, 0, 0, E5, 0, 0, 0,  D5, 0, 0, 0, C5, 0, A4, 0,
  // C — bright pickup
  C5, 0, E5, 0, G5, 0, 0, 0,  E5, 0, C5, 0, G4, 0, 0, 0,
  // G — descent into next loop
  G4, 0, B4, 0, D5, 0, 0, 0,  B4, 0, G4, 0, D4, 0, 0, 0,
];

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.layerGain = {};
    this.muted = false;
    this.playing = false;
    this.timer = null;
    this.nextNoteTime = 0;
    this.step = 0;
    this.noiseBuf = null;
  }

  // Lazy-init the audio graph. Must be called from a user-gesture
  // handler the first time (browser autoplay policy).
  _ensureCtx() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    // Compressor catches simultaneous-voice transients so the mix
    // never clips even at full volume.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.18;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.32;
    this.compressor.connect(this.master);
    this.master.connect(this.ctx.destination);

    // Per-layer gain buses for mix balance.
    const mk = (v) => {
      const g = this.ctx.createGain();
      g.gain.value = v;
      g.connect(this.compressor);
      return g;
    };
    this.layerGain.kick  = mk(1.10);
    this.layerGain.snare = mk(0.70);
    this.layerGain.hat   = mk(0.40);
    this.layerGain.sub   = mk(0.85);
    this.layerGain.bass  = mk(0.65);
    this.layerGain.lead  = mk(0.55);

    // One-shot white-noise buffer reused by snare and hat each tick.
    const len = Math.floor(this.ctx.sampleRate * 0.4);
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  start() {
    this._ensureCtx();
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this.timer = setInterval(() => this._scheduler(), SCHEDULER_TICK_MS);
  }

  stop() {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.linearRampToValueAtTime(this.muted ? 0 : 0.32, now + 0.05);
    }
  }

  // Lookahead scheduler — Chris Wilson's classic Web Audio pattern.
  // Wakes every 25 ms and queues every step whose start time falls
  // within the next 200 ms.
  _scheduler() {
    if (!this.ctx) return;
    while (this.nextNoteTime < this.ctx.currentTime + LOOKAHEAD_S) {
      this._scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += SECONDS_PER_STEP;
      this.step = (this.step + 1) % TOTAL_STEPS;
    }
  }

  _scheduleStep(step, t) {
    if (KICK[step])  this._kick(t);
    if (SNARE[step]) this._snare(t);
    if (HAT[step])   this._hat(t, HAT[step] === 2);
    if (SUB[step])   this._sub(SUB[step], t);
    if (BASS[step])  this._bass(BASS[step], t);
    if (LEAD[step])  this._lead(LEAD[step], t);
  }

  // --- Voices ------------------------------------------------------------

  _kick(t) {
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(1.0, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g); g.connect(this.layerGain.kick);
    o.start(t); o.stop(t + 0.20);
    // Click transient for snap.
    const c = this.ctx.createOscillator();
    c.type = "triangle";
    c.frequency.value = 1500;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.4, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
    c.connect(cg); cg.connect(this.layerGain.kick);
    c.start(t); c.stop(t + 0.015);
  }

  _snare(t) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    n.connect(bp); bp.connect(g); g.connect(this.layerGain.snare);
    n.start(t, Math.random() * 0.1); n.stop(t + 0.16);
    // Tonal body — gives the snare "crack" pitch.
    const o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.06);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.35, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
    o.connect(og); og.connect(this.layerGain.snare);
    o.start(t); o.stop(t + 0.12);
  }

  _hat(t, open) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    const dur = open ? 0.16 : 0.04;
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(open ? 0.5 : 0.35, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(this.layerGain.hat);
    n.start(t, Math.random() * 0.2); n.stop(t + dur + 0.02);
  }

  _sub(freq, t) {
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.8, t + 0.01);
    g.gain.setValueAtTime(0.8, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    o.connect(g); g.connect(this.layerGain.sub);
    o.start(t); o.stop(t + 0.6);
  }

  // Bass — sawtooth through a resonant lowpass with a snappy filter
  // envelope. The classic synth-bass timbre.
  _bass(freq, t) {
    const o = this.ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = freq;
    const o2 = this.ctx.createOscillator();
    o2.type = "square";
    o2.frequency.value = freq * 0.5; // sub-octave for weight
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 8;
    f.frequency.setValueAtTime(2200, t);
    f.frequency.exponentialRampToValueAtTime(280, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.55, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(f); o2.connect(f); f.connect(g); g.connect(this.layerGain.bass);
    o.start(t); o.stop(t + 0.25);
    o2.start(t); o2.stop(t + 0.25);
  }

  // Lead — square + detuned saw through a resonant lowpass for the
  // bright "synth lead" timbre. Slightly longer release for melodic
  // continuity.
  _lead(freq, t) {
    const o1 = this.ctx.createOscillator();
    o1.type = "square";
    o1.frequency.value = freq;
    const o2 = this.ctx.createOscillator();
    o2.type = "sawtooth";
    o2.frequency.value = freq * 1.005;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 3600;
    f.Q.value = 4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.008);
    g.gain.setValueAtTime(0.35, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(this.layerGain.lead);
    o1.start(t); o1.stop(t + 0.35);
    o2.start(t); o2.stop(t + 0.35);
  }
}
