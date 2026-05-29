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

// Mix levels. MASTER_TRIM is the fixed global output gain (headroom
// before the destination). SFX_BUS_LEVEL is the SFX bus gain at 100%
// volume — both chosen to preserve the original full-volume loudness
// now that music + SFX have independent volume controls.
const MASTER_TRIM = 0.32;
const SFX_BUS_LEVEL = 0.55;

// Waveshaper saturation curve — drives the "gritty" character of the
// combat SFX. `k` is the drive amount: tanh-shaped soft clip that adds
// odd harmonics (grind) without the harsh fold-over of a hard clip.
// k≈2 = warm edge, k≈6 = aggressive saturation. Built once and cached
// on the audio instance (the Float32Array is the expensive part; the
// WaveShaperNode that references it is cheap to allocate per voice).
function makeGritCurve(k) {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;          // fixed global output trim
    this.compressor = null;      // gentle master safety limiter (final stage)
    this.sfxComp = null;         // dedicated SFX limiter (SFX path only)
    this.layerGain = {};
    this.musicGain = null;       // music bus (all soundtrack layers)
    this.sfxGain = null;         // SFX bus (separate from music)
    this.muted = false;          // music mute flag (P key) — layers over musicVolume
    this.sfxMuted = false;       // SFX mute flag — layers over sfxVolume
    // Independent 0..1 channel volumes (the Settings sliders). Effective
    // bus gain = (muted ? 0 : volume[ × bus base]). Defaults match the
    // save schema; main.js restores the persisted values at boot.
    this.musicVolume = 0.6;
    this.sfxVolume = 0.8;
    this.playing = false;
    this.timer = null;
    this.nextNoteTime = 0;
    this.step = 0;
    this.noiseBuf = null;
    // Per-frame SFX rate caps. TWO budgets so the constant chatter of
    // light weapons (dozens of fighters firing autocannon every frame)
    // can't starve the heavy, impactful sounds (broadside / explosion /
    // big impacts). Without the separate reserve, a busy brawl spent its
    // whole budget on "pew" and the "THUD" got dropped — the exact bug
    // that made the mix feel arcade. Heavy voices draw from `_heavyBudget`
    // so a doom-boom is essentially always heard.
    this._sfxBudget = 0;
    this._sfxMaxPerFrame = 7;
    this._heavyBudget = 0;
    this._heavyMaxPerFrame = 5;
    // Concurrent live voices — total sub-voices (each _burst/_tone =
    // one) currently scheduled. Per-frame budget caps NEW voices, but
    // each voice lingers ~0.1-0.5s, so concurrent count climbs beyond
    // the frame budget. iOS Safari (Capacitor target) starts dropping
    // new voices silently above ~32 simultaneous source nodes — that's
    // the "SFX cuts out mid-battle" bug. Hard cap below; new light
    // voices get rejected when we'd breach it, heavy voices get more
    // slack so big guns are never lost.
    this._liveVoices = 0;
    // Tuned for mobile safety: 24 is comfortably below the iOS cap,
    // and a heavy voice (_gunReport spawns 3-4 sub-voices) can still
    // fit even when light chatter holds the rest.
    this._maxLiveVoices = 28;
  }

  // Lazy-init the audio graph. Must be called from a user-gesture
  // handler the first time (browser autoplay policy).
  _ensureCtx() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    // Final master safety limiter — a GENTLE brick-wall that only catches
    // true sum peaks so the output never clips. Kept deliberately soft
    // (high threshold, fast release): the SFX bus has its own dedicated
    // limiter (sfxComp) BEFORE this stage, so heavy weapon fire is already
    // tamed here and this master stage barely engages. That is what keeps
    // a capital broadside from ducking the MUSIC — previously a single hard
    // compressor (-14 / ratio 6 / 0.18s release) sat both buses, so a hot
    // SFX sum clamped the whole mix ~10dB and the slow release couldn't
    // recover between rapid shots → the soundtrack + SFX "died" mid-battle.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -3;
    this.compressor.knee.value = 4;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.002;
    this.compressor.release.value = 0.08;
    // Fixed global output trim (headroom before the destination). NOT
    // touched by mute/volume anymore — music + SFX each have their own
    // bus below, so the two channels are fully independent.
    this.master = this.ctx.createGain();
    this.master.gain.value = MASTER_TRIM;
    this.compressor.connect(this.master);
    this.master.connect(this.ctx.destination);

    // Music bus — ALL soundtrack layers route here, then to the
    // compressor. Gives music a single volume control independent of
    // SFX. Effective gain = muted ? 0 : musicVolume (1.0 == the old
    // full music level).
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.muted ? 0 : this.musicVolume;
    this.musicGain.connect(this.compressor);

    // Per-layer gain buses for mix balance, feeding the music bus.
    const mk = (v) => {
      const g = this.ctx.createGain();
      g.gain.value = v;
      g.connect(this.musicGain);
      return g;
    };
    this.layerGain.kick  = mk(1.10);
    this.layerGain.snare = mk(0.70);
    this.layerGain.hat   = mk(0.40);
    this.layerGain.sub   = mk(0.85);
    this.layerGain.bass  = mk(0.65);
    this.layerGain.lead  = mk(0.55);

    // SFX bus — separate from the music bus so the two channels are
    // independently volume-controlled + mutable. SFX_BUS_LEVEL is the
    // 100%-volume reference (kept higher than music so impact thunks
    // read above the kick + snare). Both buses share the compressor so
    // the final mix never clips.
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxMuted ? 0 : this.sfxVolume * SFX_BUS_LEVEL;
    // Global SFX tone ceiling — a low-pass on the WHOLE sfx bus so NO
    // piercing high content can ever reach the player. WW2 guns +
    // artillery are dominated by sub-1kHz energy with crack "presence" to
    // ~2kHz; everything above is the "high-pitched"/tinny zone the design
    // must avoid. This is a hard guarantee on top of removing high sources
    // per-voice — even saturation-regenerated harmonics get clamped here.
    // (Music is on its own bus and is unaffected.)
    this.sfxLowpass = this.ctx.createBiquadFilter();
    this.sfxLowpass.type = "lowpass";
    this.sfxLowpass.frequency.value = 2400;
    this.sfxLowpass.Q.value = 0.5;
    // Dedicated SFX limiter — controls the SFX sum so a wall of weapon
    // fire (esp. overlapping capital broadsides) is caught transparently
    // WITHOUT the long sustained ducking that read as "sound died". A fast
    // release (0.06s) lets the level snap back between shots, and because
    // this sits only on the SFX path, the music bus is never ducked by it.
    this.sfxComp = this.ctx.createDynamicsCompressor();
    this.sfxComp.threshold.value = -9;
    this.sfxComp.knee.value = 6;
    this.sfxComp.ratio.value = 8;
    this.sfxComp.attack.value = 0.003;
    this.sfxComp.release.value = 0.06;
    this.sfxGain.connect(this.sfxLowpass);
    this.sfxLowpass.connect(this.sfxComp);
    this.sfxComp.connect(this.compressor);

    // Convolution reverb send — a shared "vast dark void / cathedral"
    // space that every combat voice can bleed into. This is the single
    // biggest "real-life / cinematic 40k" upgrade: instead of clean dry
    // synth blips, weapons + impacts + explosions now ring out into a
    // huge reverberant hall. ONE convolver processes the summed sends
    // (cheap), then a darkening lowpass + return gain into the SFX bus
    // so the tail tracks the SFX volume + gets compressed with the dry.
    this._reverb = this.ctx.createConvolver();
    this._reverb.buffer = this._makeImpulse(1.7, 2.6);
    this._reverbLP = this.ctx.createBiquadFilter();
    this._reverbLP.type = "lowpass";
    this._reverbLP.frequency.value = 3200; // dark, smoky tail (no fizz)
    this._reverbReturn = this.ctx.createGain();
    this._reverbReturn.gain.value = 0.85;
    this._reverb.connect(this._reverbLP);
    this._reverbLP.connect(this._reverbReturn);
    this._reverbReturn.connect(this.sfxGain);

    // White-noise buffer reused by snare + hat + every SFX noise layer.
    // Long enough (2 s) to source the extended rumble tails of the
    // reworked explosions without having to loop.
    const len = Math.floor(this.ctx.sampleRate * 2.0);
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Cached saturation curves for the gritty combat voices (see
    // makeGritCurve). Soft = a warm edge on light weapons + ricochets;
    // hard = the aggressive chest-thumping grind on heavy cannons,
    // broadsides + explosions. Driven harder than the old arcade pass
    // for a coarser, more industrial 40k bite.
    this._gritSoft = makeGritCurve(3.0);
    this._gritHard = makeGritCurve(9.0);
  }

  // Build a stereo exponential-decay noise impulse response — a smooth,
  // dark reverb tail that reads as an enormous enclosed space. `decay`
  // controls how fast it dies (higher = tighter).
  _makeImpulse(duration = 1.7, decay = 2.6) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * duration);
    const buf = this.ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const env = Math.pow(1 - i / n, decay);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
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
    // Defensive reset: if a previous battle ended with the ctx
    // suspended, some onended callbacks may not have fired and the
    // live-voice count could be stale. Clamp it here so a new battle
    // starts with a clean accounting (real lingering voices will still
    // run their cleanup; the cleaned-once guard makes the decrement
    // safe even if we reset midway).
    this._liveVoices = 0;
  }

  stop() {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Tab hidden / app backgrounded — silence EVERYTHING immediately. The
  // music scheduler + AudioContext run independently of the game's RAF
  // loop, so a hidden tab would otherwise keep playing the soundtrack and
  // any ringing SFX tails. Halting the scheduler stops new music notes;
  // suspending the whole context freezes audio-clock output so nothing
  // (music or in-flight SFX) is audible while away.
  suspendAll() {
    this.stop();
    if (this.ctx && this.ctx.state === "running") {
      this.ctx.suspend().catch(() => {});
    }
  }

  // Tab visible again — un-suspend the graph so audio can play. Music
  // restart is left to the caller (the frame loop decides whether the
  // soundtrack should be running for the current game state), so we only
  // wake the context here; UI/SFX voices work again immediately.
  resumeCtx() {
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  }

  // ---- Music channel ----------------------------------------------------
  // Ramp the music bus to its effective level (0 when muted, else the
  // current volume). Safe to call before the graph exists — the value is
  // applied at _ensureCtx time from the stored fields.
  _rampMusic() {
    if (!this.musicGain || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.linearRampToValueAtTime(this.muted ? 0 : this.musicVolume, now + 0.05);
  }

  toggleMute() { this.setMuted(!this.muted); }

  // Music mute flag (the P-key quick-mute). Layers OVER the volume so
  // un-muting restores the slider level. Independent of the SFX channel.
  setMuted(m) {
    if (this.muted === m) return;
    this.muted = m;
    this._rampMusic();
  }
  isMuted() { return this.muted; }

  // Music volume 0..1 (the Settings slider). 1.0 == original full level.
  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    this._rampMusic();
  }
  getMusicVolume() { return this.musicVolume; }

  // ---- SFX channel ------------------------------------------------------
  _rampSfx() {
    if (!this.sfxGain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const target = this.sfxMuted ? 0 : this.sfxVolume * SFX_BUS_LEVEL;
    this.sfxGain.gain.cancelScheduledValues(now);
    this.sfxGain.gain.linearRampToValueAtTime(target, now + 0.05);
  }

  setSfxMuted(m) {
    if (this.sfxMuted === m) return;
    this.sfxMuted = m;
    this._rampSfx();
  }
  isSfxMuted() { return this.sfxMuted; }

  // SFX volume 0..1 (the Settings slider). 1.0 == original full level.
  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    this._rampSfx();
  }
  getSfxVolume() { return this.sfxVolume; }

  // Each game frame the main loop calls this to reset the per-frame
  // budget. Returns true while the budget is positive so the caller
  // can short-circuit before doing any voice synthesis work.
  tickSfxBudget() {
    this._sfxBudget = this._sfxMaxPerFrame;
    this._heavyBudget = this._heavyMaxPerFrame;
  }

  // `heavy` voices (broadside / heavy cannon / explosions / big impacts /
  // module deaths) draw from a separate reserved budget so they're never
  // dropped in favour of light-weapon chatter.
  //
  // Two gates:
  //   1. Per-frame budget (reset by tickSfxBudget) caps NEW voices per
  //      animation frame so a wall of fire events can't allocate a
  //      thousand nodes in one tick.
  //   2. Concurrent live-voice cap protects against the iOS / Capacitor
  //      audio-node ceiling. Light voices get rejected at maxLiveVoices -
  //      headroom so a heavy voice landing in the same frame still has
  //      slot to spawn its 3-4 sub-voices cleanly.
  _sfxOk(heavy = false) {
    if (!this.ctx || this.sfxMuted || this.sfxVolume <= 0) return false;
    // One heavy call (e.g. _gunReport) spawns 3-4 sub-voices internally,
    // so the gate has to leave room for that whole burst — not just one
    // slot — or peak live count climbs past the iOS node ceiling. Light
    // voices reserve enough headroom that a heavy call landing in the
    // same frame can still spawn its full burst cleanly.
    if (heavy) {
      // Allow a heavy call when we have room for its sub-voices.
      // Effective ceiling = _maxLiveVoices (matches iOS ~32 cap).
      if (this._liveVoices > this._maxLiveVoices - 4) return false;
      if (this._heavyBudget <= 0) return false;
      this._heavyBudget--;
      return true;
    }
    // Light voices give heavy a wide berth — reserve 8 slots so heavy
    // can spawn its sub-voices without bumping into light chatter.
    if (this._liveVoices >= this._maxLiveVoices - 8) return false;
    if (this._sfxBudget <= 0) return false;
    this._sfxBudget--;
    return true;
  }

  // --- Gritty synth toolkit ----------------------------------------------
  // Shared building blocks for the combat voices. Each schedules ONE
  // sub-voice (a filtered noise burst or a pitched tone) and connects to
  // the SFX bus, optionally through a saturation stage for grit. A weapon
  // or impact "voice" is just a stack of two or three of these — keeps the
  // per-voice code short and the timbres consistent.

  // Build a fresh WaveShaper referencing a cached curve. `amount` >= 1
  // selects the hard (aggressive) curve; otherwise the soft (warm) curve.
  // 2x oversampling tames the aliasing the saturation would otherwise add.
  _grit(amount) {
    const ws = this.ctx.createWaveShaper();
    ws.curve = amount >= 1 ? this._gritHard : this._gritSoft;
    ws.oversample = "2x";
    return ws;
  }

  // Route a finished sub-voice's output into the shared reverb send so
  // it rings out into the void. `amount` 0..1 scales the wet level.
  _sendReverb(node, amount) {
    if (!(amount > 0) || !this._reverb) return null;
    const s = this.ctx.createGain();
    s.gain.value = amount;
    node.connect(s);
    s.connect(this._reverb);
    return s;
  }

  // Free a finished voice's node chain. Web Audio does NOT auto-disconnect
  // the gain/filter/waveshaper/reverb-send nodes downstream of a stopped
  // source — they linger connected to the bus until GC, and under
  // sustained battle fire the live-node count spikes high enough to glitch
  // the context (SFX cut out, then recover when GC catches up). Hooking
  // the source's `onended` to disconnect the whole chain frees them
  // deterministically and keeps the node count bounded.
  //
  // Also tracks `_liveVoices` so `_sfxOk` can reject new voices when
  // the concurrent count is high. Each call to _disconnectOnEnd
  // counts as one live voice — _burst/_tone create one source, so
  // this maps 1:1 with sub-voices.
  _disconnectOnEnd(source, nodes) {
    this._liveVoices++;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this._liveVoices = Math.max(0, this._liveVoices - 1);
      for (const nd of nodes) { try { nd.disconnect(); } catch (_e) { /* already gone */ } }
    };
    source.onended = cleanup;
  }

  // Filtered noise burst — the "spit" / "crack" / "rupture" / "rumble"
  // textures. `attack` lets slow swells (rumble tails) ease in instead
  // of snapping. `reverb` bleeds the burst into the shared space.
  _burst(t, { peak, dur, type = "lowpass", f0, f1, Q = 1, grit = 0, delay = 0, rate = 1, attack = 0.004, reverb = 0 }) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.playbackRate.value = rate;
    const flt = this.ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(f0, t + delay);
    if (f1 && f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + delay + dur);
    flt.Q.value = Q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + delay);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + delay + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
    n.connect(flt); flt.connect(g);
    let out = g;
    const nodes = [n, flt, g];
    if (grit > 0) { const ws = this._grit(grit); g.connect(ws); out = ws; nodes.push(ws); }
    out.connect(this.sfxGain);
    const rs = this._sendReverb(out, reverb);
    if (rs) nodes.push(rs);
    // Random start offset into the long noise buffer so repeated bursts
    // don't phase-lock into an obvious tone.
    n.start(t + delay, Math.random() * 1.5); n.stop(t + delay + dur + 0.05);
    this._disconnectOnEnd(n, nodes);
  }

  // Pitched tone — the "boom" / "body" / "ping" / "thump" textures.
  // Saturating a sine through the grit stage turns it square-ish (adds
  // harmonic punch); a square/saw gets a coarser grind. `reverb` bleeds
  // it into the shared space.
  _tone(t, { peak, dur, type = "sine", f0, f1, grit = 0, delay = 0, attack = 0.004, reverb = 0 }) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t + delay);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + delay + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + delay);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + delay + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
    o.connect(g);
    let out = g;
    const nodes = [o, g];
    if (grit > 0) { const ws = this._grit(grit); g.connect(ws); out = ws; nodes.push(ws); }
    out.connect(this.sfxGain);
    const rs = this._sendReverb(out, reverb);
    if (rs) nodes.push(rs);
    o.start(t + delay); o.stop(t + delay + dur + 0.05);
    this._disconnectOnEnd(o, nodes);
  }

  // Chest-thump sub-bass layer — a deep sine punch that pitch-drops into
  // the floor. The defining "weight" of every heavy impact + report.
  _thump(t, { peak, dur, f0 = 150, f1 = 34, delay = 0, reverb = 0 }) {
    this._tone(t, { type: "sine", f0, f1, dur, peak, delay, reverb, grit: 0.3 });
  }

  // --- WW2 thump palette -------------------------------------------------
  // The whole combat soundscape is built from these. NO high-frequency
  // crack transients anywhere — the "report" punch comes from a FAST
  // ATTACK on a low-mid noise body + a deep sub, never a piercing click.

  // Universal gun report. `size` 0 = light machine gun, 1 = heavy WW2
  // artillery piece (every large-ship cannon). Scales the body depth,
  // the sub thump, and (size ≥ 0.5) adds a rolling artillery tail.
  _gunReport(t, { v, size = 0, reverb = 0 } = {}) {
    const bodyCut = 1200 - size * 700;                 // 1200 (MG) .. 500 (artillery)
    const bodyDur = 0.07 + size * 0.20;
    this._burst(t, { type: "lowpass", f0: bodyCut, f1: Math.max(110, bodyCut * 0.18),
                     dur: bodyDur, peak: (0.36 + size * 0.10) * v, Q: 1.1, grit: 1, attack: 0.0015, reverb });
    this._thump(t, { f0: 150 - size * 58, f1: 46 - size * 22, dur: 0.11 + size * 0.5,
                     peak: (0.42 + size * 0.42) * v, reverb: reverb * 0.6 });
    if (size >= 0.5) {
      // Heavy artillery — a low report rolling off across the battlefield.
      this._burst(t, { type: "lowpass", f0: 360, f1: 70, dur: 0.5 + size * 0.7, peak: 0.26 * v,
                       Q: 0.8, grit: 0.4, attack: 0.05, delay: 0.05, reverb: reverb + 0.18 });
    }
  }

  // One consistent impact thud — every round/shell hitting shield, armour
  // or hull reads the same: a low-mid impact + a sub. `size` scales it
  // (light cannon → heavy shell). No metallic pings, no high ring.
  _impactThud(t, { v, size = 0.3, reverb = 0 } = {}) {
    this._burst(t, { type: "lowpass", f0: 1100 - size * 450, f1: 150, dur: 0.10 + size * 0.16,
                     peak: (0.40 + size * 0.15) * v, Q: 1.2, grit: 0.85, attack: 0.0015, reverb });
    this._thump(t, { f0: 132 - size * 30, f1: 38, dur: 0.13 + size * 0.18,
                     peak: (0.46 + size * 0.25) * v, reverb: reverb * 0.5 });
  }

  // --- Weapon fire voices ------------------------------------------------
  // One distinct timbre per weapon MODULE. `weapon`:
  //   "autocannon" — fighter/bomber bow gun (light, punchy spit)
  //   "ringcannon" — frigate ring battery (sharp, rapid kinetic)
  //   "heavycannon" — cruiser/carrier forward salvo (deep boom + crack)
  //   "broadside"  — battleship broadside (the heaviest — thunder + sub)
  sfxWeapon({ weapon = "autocannon", volume = 1 } = {}) {
    const heavy = weapon === "broadside" || weapon === "heavycannon" || weapon === "cruisercannon";
    if (!this._sfxOk(heavy)) return;
    if (volume <= 0.02) return;
    const t = this.ctx.currentTime;
    const v = volume;
    // One WW2 thump family, scaling from light MG to heavy artillery.
    // `size` is the only knob; `_gunReport` adds the rolling artillery
    // tail itself above 0.5. No high-frequency cracks anywhere.
    switch (weapon) {
      case "broadside":      // battleship — heaviest WW2 siege/naval artillery
        // Loudest gun on the field — boosted so it dominates the mix.
        // Per-shot v cranked from 1.6 → 2.1 to make BB broadsides feel
        // genuinely massive (the live-voice cap below means each shot
        // gets its own slot, so the extra gain comes through cleanly
        // instead of getting stacked-and-ducked by the limiter).
        this._gunReport(t, { v: v * 2.1, size: 1.0, reverb: 0.42 });
        // A short extra-deep second sub so the biggest gun caves the
        // chest. Kept SHORT (sustained subs duck the dynamics between
        // rapid salvos); the report carries the weight, this is the
        // floor punch.
        this._thump(t, { f0: 70, f1: 20, dur: 0.4, peak: 0.7 * v, reverb: 0.22 });
        break;
      case "heavycannon":    // carrier / Thren heavy cannon — field artillery
        // Same loud heavy-artillery report as the BB-class capitals, with
        // the rolling low tail (size >= 0.5 in _gunReport). Boosted to
        // match the battleship/cruiser presence. 1.5 → 1.9.
        this._gunReport(t, { v: v * 1.9, size: 0.85, reverb: 0.34 });
        break;
      case "cruisercannon":  // strike cruiser — field artillery piece
        // 1.5 → 1.8 — cruisers fire more often than BBs, so leave a
        // little headroom below broadside.
        this._gunReport(t, { v: v * 1.8, size: 0.65, reverb: 0.26 });
        break;
      case "ringcannon":     // frigate ring battery — heavy machine gun
        this._gunReport(t, { v, size: 0.30 });
        break;
      case "autocannon":
      default:               // fighter/bomber bow gun — machine gun
        this._gunReport(t, { v, size: 0.14 });
        break;
    }
  }

  // Point-defence = FLAK CANNONS. A small low airburst "crump" — a quick,
  // quiet gun report so a PD ring reads as rapid flak ("crump-crump"),
  // never a high tick. Brief + modest (fires fast + gated upstream).
  sfxPdFire({ volume = 1 } = {}) {
    if (!this._sfxOk()) return;
    if (volume <= 0.03) return;
    this._gunReport(this.ctx.currentTime, { v: volume * 0.55, size: 0.0 });
  }

  // --- Impact voices -----------------------------------------------------
  // Distinct timbre per defence LAYER, further coloured by the SOURCE
  // weapon. `layer`: "shield" | "armor" | "hull". `source`: "cannon"
  // (light kinetic), "heavy" (cruiser/BB shell), "missile", "pd", "laser".
  // Impacts all read the SAME — one consistent low thud, regardless of
  // shield / armour / hull. Only the SOURCE scales its size: a light
  // cannon round is a small thud, a heavy shell a big one, a missile
  // detonates. No metallic pings, no energy shimmer, no high content.
  sfxImpact({ layer = "hull", source = "cannon", volume = 1 } = {}) {
    const heavy = source === "heavy" || source === "missile";
    if (!this._sfxOk(heavy)) return;
    if (volume <= 0.03) return;
    const t = this.ctx.currentTime;
    const v = volume;

    // A missile LANDING detonates — rolling-thunder blast (small).
    if (source === "missile") { this._detonation(t, { volume: v, intensity: 0.34 }); return; }

    const size = source === "heavy" || source === "laser" ? 0.6
      : source === "pd" ? 0.1
      : 0.32; // cannon
    this._impactThud(t, { v, size, reverb: heavy ? 0.14 : 0 });
  }

  // Back-compat wrapper. Older callers pass `kind` = ship class; map it
  // to the per-module weapon voice.
  sfxCannon({ volume = 1, kind = "fighter" } = {}) {
    const weapon = kind === "battleship" ? "broadside"
      : (kind === "cruiser" || kind === "carrier") ? "heavycannon"
      : kind === "frigate" ? "ringcannon"
      : "autocannon";
    this.sfxWeapon({ weapon, volume });
  }

  // Missile launch — a WW2 gun-style thump (the charge lighting) followed
  // by a low, gritty motor whoosh pitching down as the missile departs.
  // Thumping like the guns; no high ignition crack.
  sfxMissile({ volume = 1 } = {}) {
    if (!this._sfxOk()) return;
    if (volume <= 0.02) return;
    const t = this.ctx.currentTime;
    const v = volume;
    this._gunReport(t, { v, size: 0.4, reverb: 0.12 });   // launch thump
    // Low motor whoosh sweeping down (lowpass, no high), tailing into the void.
    this._burst(t, { type: "lowpass", f0: 800, f1: 200, dur: 0.5, peak: 0.30 * v, Q: 1.0,
                     grit: 0.6, attack: 0.03, delay: 0.03, reverb: 0.14 });
  }

  // Back-compat wrapper. Maps the old boolean `shielded` to the layered
  // impact dispatcher. New callers should emit `layer` + `source`.
  sfxHit({ shielded = false, volume = 1, source = "cannon" } = {}) {
    this.sfxImpact({ layer: shielded ? "shield" : "hull", source, volume });
  }

  // Heavy-laser sustained beam — INTENTIONALLY SILENT.
  // The sustained 3s oscillator stack was the worst offender for the
  // "SFX cuts out mid-battle" bug: each beam held 4 oscillators alive
  // for its full lifetime, and in a fight with several BB lasers + a
  // few carriers' heavy lasers the live-voice count blew past the
  // mobile audio-node cap (browsers, esp iOS Safari/Capacitor, throttle
  // hard above ~32 simultaneous source nodes). The energy-weapon read
  // is carried visually (the beam is loud and obvious on-screen); the
  // SFX is no loss. Function preserved as a no-op so callers (main.js
  // event subscriber) don't have to gate.
  sfxBeam(_opts = {}) {
    return;
  }

  // Cluster missile bloom — a parent warhead splitting into its children.
  // A gritty splitting crack + a few quick noise "scatter" bursts fanning
  // out (the multiple tracks). ALL NOISE now — the old pitched triangle
  // sparkle (up to 1800Hz) was the high-pitched "ding" heard in cluster-
  // heavy cruiser fights.
  sfxMissileBloom({ volume = 1 } = {}) {
    if (!this._sfxOk()) return;
    if (volume <= 0.02) return;
    const t = this.ctx.currentTime;
    const v = volume;
    // Cluster warhead splitting — a low "shred" + a couple of low scatter
    // thuds (the tracks fanning out). All low-pass, no high ticks.
    this._burst(t, { type: "lowpass", f0: 1100, f1: 300, dur: 0.16, peak: 0.40 * v, Q: 1.0, grit: 0.8, reverb: 0.12 });
    for (let i = 0; i < 2; i++) {
      this._burst(t, { type: "lowpass", f0: 700, f1: 200, dur: 0.05, peak: 0.13 * v, Q: 1.0, grit: 0.5, delay: 0.04 + i * 0.05 });
    }
  }

  // Missile shot down by PD (or otherwise destroyed) — the warhead
  // detonates: a real (small) explosion, not a pop. Kept modest in
  // intensity so a missile-heavy fight is a crackle of mid-air blasts,
  // not a wall of capital-sized booms.
  sfxMissileIntercept({ volume = 1 } = {}) {
    if (!this._sfxOk()) return;
    if (volume <= 0.04) return;
    this._detonation(this.ctx.currentTime, { volume, intensity: 0.28 });
  }

  // Shield collapse — the field tears + the screens go dark. A low gritty
  // rupture sweeping down + a deep collapse whump. All low, no fizz.
  sfxShieldBreak({ volume = 1 } = {}) {
    if (!this._sfxOk(true)) return;
    if (volume <= 0.04) return;
    const t = this.ctx.currentTime;
    const v = volume;
    this._burst(t, { type: "lowpass", f0: 1200, f1: 200, dur: 0.36, peak: 0.42 * v, Q: 1.0, grit: 0.9, reverb: 0.16 });
    this._thump(t, { f0: 150, f1: 40, dur: 0.30, peak: 0.44 * v, reverb: 0.14 });
  }

  // Armor plate strip — a falling-plate shear: a low grinding sweep +
  // a heavy sub thump. Low-Q (no resonant steel ring), all low.
  sfxArmorStrip({ volume = 1 } = {}) {
    if (!this._sfxOk(true)) return;
    if (volume <= 0.04) return;
    const t = this.ctx.currentTime;
    const v = volume;
    this._burst(t, { type: "lowpass", f0: 900, f1: 180, dur: 0.40, peak: 0.52 * v, Q: 1.4, grit: 0.9, reverb: 0.18 });
    this._thump(t, { f0: 96, f1: 32, dur: 0.32, peak: 0.56 * v, reverb: 0.14 });
  }

  // Module blown out — a small rolling-thunder detonation (consistent with
  // every other explosion), scaling with module size.
  sfxModuleDestroyed({ volume = 1, intensity = 0.5 } = {}) {
    if (!this._sfxOk(true)) return;
    if (volume <= 0.04) return;
    this._detonation(this.ctx.currentTime, { volume, intensity: 0.2 + intensity * 0.25 });
  }

  // Carrier replenishment launch — a steam-catapult slam: a low thump +
  // a low launch whoosh. No high clank, no rising whistle.
  sfxCarrierLaunch({ volume = 1 } = {}) {
    if (!this._sfxOk()) return;
    if (volume <= 0.04) return;
    const t = this.ctx.currentTime;
    const v = volume;
    this._thump(t, { f0: 150, f1: 56, dur: 0.13, peak: 0.5 * v });
    this._burst(t, { type: "lowpass", f0: 900, f1: 360, dur: 0.32, peak: 0.28 * v, Q: 1.0,
                     grit: 0.4, attack: 0.04, delay: 0.04, reverb: 0.10 });
  }

  // Match-over victory sting — short ascending triad. Plays once
  // when the player's side wins. Bypasses the per-frame SFX budget
  // (always heard) since it's a one-shot end-of-match cue.
  sfxVictory({ volume = 1 } = {}) {
    if (!this.ctx || this.sfxMuted || this.sfxVolume <= 0) return;
    const t = this.ctx.currentTime;
    const v = volume;
    // Grim martial power-chord swell — saturated low "brass", NO cheerful
    // major third. Root + fifth + octave (A power chord) ringing into the
    // void over a deep held sub. Heroic but heavy, not arcade-bright.
    const chord = [110, 164.81, 220];
    chord.forEach((f, i) => {
      this._tone(t, { type: "sawtooth", f0: f, dur: 1.2, peak: (0.30 - i * 0.04) * v,
                      grit: 1, attack: 0.10, delay: i * 0.05, reverb: 0.30 });
    });
    this._tone(t, { type: "sine", f0: 55, dur: 1.3, peak: 0.55 * v, attack: 0.08, reverb: 0.22 });
    // Higher octave blooms in late — a sense of rising triumph.
    this._tone(t, { type: "sawtooth", f0: 330, dur: 0.9, peak: 0.15 * v, grit: 0.6,
                    attack: 0.18, delay: 0.28, reverb: 0.30 });
  }

  // Match-over defeat sting — a funereal descending drone: saturated low
  // saws collapsing, a deep sub falling away, a dread high partial, all
  // drowning in reverb. The sound of a fleet dying.
  sfxDefeat({ volume = 1 } = {}) {
    if (!this.ctx || this.sfxMuted || this.sfxVolume <= 0) return;
    const t = this.ctx.currentTime;
    const v = volume;
    this._tone(t, { type: "sawtooth", f0: 165, f1: 62, dur: 1.6, peak: 0.28 * v, grit: 1, attack: 0.10, reverb: 0.35 });
    this._tone(t, { type: "sawtooth", f0: 110, f1: 41, dur: 1.7, peak: 0.24 * v, grit: 1, attack: 0.12, delay: 0.05, reverb: 0.35 });
    // Deep sub collapse.
    this._tone(t, { type: "sine", f0: 92, f1: 34, dur: 1.9, peak: 0.6 * v, attack: 0.12, reverb: 0.22 });
    // Dread high partial bending down.
    this._tone(t, { type: "triangle", f0: 330, f1: 120, dur: 1.2, peak: 0.11 * v, grit: 0.5, attack: 0.15, reverb: 0.30 });
  }

  // Shared detonation core — a real explosion: sharp ignition CRACK,
  // saturated body BLAST sweeping down, a chest-caving sub THUMP, and a
  // long low RUMBLE ringing into the void. Used by ship deaths (big),
  // missile interceptions + missile landings (small). `intensity` 0..1
  // scales depth + length. Caller is responsible for the budget gate.
  // ROLLING THUNDER — the universal detonation. A series of overlapping
  // low booms staggered in time so the blast ROLLS out like distant
  // artillery/thunder, over a deep sub and a long low rumble tail in the
  // reverb. All low-pass: no crack, no high debris. `intensity` 0..1
  // scales depth, length + boom count. Used by ship deaths (big), missile
  // landings + interceptions + module deaths (small).
  _detonation(t, { volume = 1, intensity = 0.5 } = {}) {
    const v = volume;
    const booms = 3 + Math.round(intensity * 2);            // 3..5 rolling booms
    for (let i = 0; i < booms; i++) {
      const dl = i * (0.09 + Math.random() * 0.10);         // staggered → rolls
      const cut = 1300 - i * 170;                           // each roll a touch darker
      this._burst(t, { type: "lowpass", f0: Math.max(300, cut), f1: 85,
                       dur: 0.34 + intensity * 0.28, peak: (0.6 - i * 0.085) * v,
                       Q: 1.0, grit: 0.8, attack: 0.012 + i * 0.012, delay: dl, reverb: 0.30 + i * 0.04 });
    }
    // Deep initial sub — the gut-punch under the first boom.
    this._thump(t, { f0: 150 - intensity * 70, f1: 22, dur: 0.7 + intensity * 0.5,
                     peak: (0.7 + intensity * 0.2) * v, reverb: 0.24 });
    // Long low rumble tail rolling off into the distance.
    this._burst(t, { type: "lowpass", f0: 320, f1: 55, dur: 1.0 + intensity * 0.8, peak: 0.30 * v,
                     Q: 0.7, grit: 0.4, attack: 0.08, delay: 0.12, reverb: 0.5 });
  }

  // Ship explosion — rolling thunder, scaled by intensity (capital death
  // = huge). No high debris crackle (that read as high-pitched fizz).
  sfxExplosion({ volume = 1, intensity = 0.6 } = {}) {
    if (!this._sfxOk(true)) return;
    if (volume <= 0.02) return;
    this._detonation(this.ctx.currentTime, { volume, intensity });
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
    this._disconnectOnEnd(o, [o, g]);
    // Click transient for snap.
    const c = this.ctx.createOscillator();
    c.type = "triangle";
    c.frequency.value = 1500;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.4, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
    c.connect(cg); cg.connect(this.layerGain.kick);
    c.start(t); c.stop(t + 0.015);
    this._disconnectOnEnd(c, [c, cg]);
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
    this._disconnectOnEnd(n, [n, bp, g]);
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
    this._disconnectOnEnd(o, [o, og]);
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
    this._disconnectOnEnd(n, [n, hp, g]);
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
    this._disconnectOnEnd(o, [o, g]);
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
    this._disconnectOnEnd(o, [o, o2, f, g]);
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
    this._disconnectOnEnd(o1, [o1, o2, f, g]);
  }

  // UI tap — short, soft "click" routed through the SFX bus so it
  // respects the global SFX mute. Quieter than gameplay voices so it
  // doesn't dominate the mix. `variant`: "tap" (default, soft pop)
  // or "back" (slightly lower-pitch chirp for back/dismiss buttons).
  sfxUiTap({ variant = "tap" } = {}) {
    if (!this.ctx || this.sfxMuted || this.sfxVolume <= 0) return;
    // UI taps bypass the budget gate — they should always feel
    // responsive and never queue. They're cheap so this is fine.
    const t = this.ctx.currentTime;
    const startHz = variant === "back" ? 520 : 880;
    const endHz   = variant === "back" ? 240 : 360;
    const dur = 0.06;
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(startHz, t);
    o.frequency.exponentialRampToValueAtTime(endHz, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.sfxGain);
    o.start(t);
    o.stop(t + dur + 0.02);
    this._disconnectOnEnd(o, [o, g]);
  }
}
