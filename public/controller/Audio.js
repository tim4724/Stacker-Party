'use strict';

var ControllerAudio = (function () {
  var audioCtx = null;
  var muted = false;
  var primed = false;
  var noiseBuffer = null;

  function getCtx() {
    if (!audioCtx) {
      // iOS Lockdown Mode removes the Web Audio API outright: no constructor at all.
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      noiseBuffer = null; // buffer is context-specific, must regenerate
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () {});
    }
    return audioCtx;
  }

  function prime() {
    if (primed) return;
    var ctx = getCtx();
    if (!ctx) return;
    primed = true;
    var buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  }

  function tick() {
    if (muted) return;
    var ctx = getCtx();
    if (!ctx) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 150;
    osc.type = 'sine';
    gain.gain.setValueAtTime(1.0, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
    osc.onended = function() { gain.disconnect(); };
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.04);
  }

  function lineClear(count) {
    if (muted) return;
    var ctx = getCtx();
    if (!ctx) return;
    // Triple is the top tier with the casual bag (max 3-row piece extent);
    // quads are unreachable. count >= 3 gets the 500 Hz reward tone.
    var baseFreq = count >= 3 ? 500 : count >= 2 ? 440 : 380;
    var duration = 0.15;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(baseFreq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.onended = function() { gain.disconnect(); };
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }

  function drop() {
    if (muted) return;
    var ctx = getCtx();
    if (!ctx) return;
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.1);
    gain.gain.setValueAtTime(0.9, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.onended = function() { gain.disconnect(); };
    osc.start(t);
    osc.stop(t + 0.1);
    if (!noiseBuffer) {
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
      var data = noiseBuffer.getChannelData(0);
      for (var i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    var noise = ctx.createBufferSource();
    var nGain = ctx.createGain();
    noise.buffer = noiseBuffer;
    noise.connect(nGain);
    nGain.connect(ctx.destination);
    nGain.gain.setValueAtTime(0.36, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    noise.onended = function() { nGain.disconnect(); };
    noise.start(t);
  }

  function hold() {
    if (muted) return;
    var ctx = getCtx();
    if (!ctx) return;
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(500, t);
    osc.frequency.exponentialRampToValueAtTime(250, t + 0.08);
    gain.gain.setValueAtTime(0.6, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.onended = function() { gain.disconnect(); };
    osc.start(t);
    osc.stop(t + 0.08);
  }

  function setMuted(val) { muted = !!val; }
  function isMuted() { return muted; }

  return { prime: prime, tick: tick, lineClear: lineClear, drop: drop, hold: hold, setMuted: setMuted, isMuted: isMuted };
})();
