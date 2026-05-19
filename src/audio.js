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
