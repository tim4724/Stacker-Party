'use strict';

var ControllerAudio = (function () {
  var audioCtx = null;
  var muted = false;
  var primed = false;

  function getCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function prime() {
    if (primed) return;
    primed = true;
    var ctx = getCtx();
    var buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  }

  function tick() {
    if (muted) return;
    var ctx = getCtx();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 150;
    osc.type = 'sine';
    gain.gain.setValueAtTime(1.0, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.04);
  }

  function lineClear(count) {
    if (muted) return;
    var ctx = getCtx();
    var baseFreq = count >= 4 ? 600 : count >= 3 ? 500 : count >= 2 ? 440 : 380;
    var duration = count >= 4 ? 0.25 : 0.15;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(baseFreq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }

  function drop() {
    if (muted) return;
    var ctx = getCtx();
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
    osc.start(t);
    osc.stop(t + 0.1);
    var buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    var noise = ctx.createBufferSource();
    var nGain = ctx.createGain();
    noise.buffer = buf;
    noise.connect(nGain);
    nGain.connect(ctx.destination);
    nGain.gain.setValueAtTime(0.36, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    noise.start(t);
  }

  function hold() {
    if (muted) return;
    var ctx = getCtx();
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
    osc.start(t);
    osc.stop(t + 0.08);
  }

  function setMuted(val) { muted = !!val; }
  function isMuted() { return muted; }

  return { prime: prime, tick: tick, lineClear: lineClear, drop: drop, hold: hold, setMuted: setMuted, isMuted: isMuted };
})();
