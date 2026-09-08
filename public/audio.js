(function () {
  'use strict';

  const preferenceKey = 'tongzhuo-audio';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  window.createTableAudio = function ({ button, volumeInput, notify = () => {} } = {}) {
    let enabled = false;
    let volume = 35;
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
      enabled = saved?.enabled === true;
      if (Number.isFinite(saved?.volume)) volume = clamp(saved.volume, 0, 100);
    } catch { /* Sound preferences must not prevent joining a table. */ }

    let context;
    let master;
    let noiseBuffer;
    let latest = null;
    let handKey = '';
    let queueEnd = 0;
    let warningKey = '';
    let lastReactionAt = -Infinity;
    const timers = new Set();
    const voices = new Set();
    const reactions = new Set();

    function save() {
      try { localStorage.setItem(preferenceKey, JSON.stringify({ enabled, volume })); } catch { /* Optional storage. */ }
    }
    function renderControls() {
      if (button) {
        const label = enabled ? '\u5173\u95ed\u97f3\u6548' : '\u5f00\u542f\u97f3\u6548';
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        button.setAttribute('aria-pressed', String(enabled));
        button.innerHTML = `<i data-lucide="${enabled && volume > 0 ? 'volume-2' : 'volume-x'}" aria-hidden="true"></i>`;
        window.lucide?.createIcons();
      }
      if (volumeInput) {
        volumeInput.min = '0';
        volumeInput.max = '100';
        volumeInput.step = '1';
        volumeInput.value = String(volume);
        volumeInput.setAttribute('aria-label', '\u97f3\u91cf');
        volumeInput.setAttribute('title', `\u97f3\u91cf ${volume}%`);
      }
    }
    function ready() {
      return enabled && volume > 0 && !document.hidden && context?.state === 'running';
    }
    function setMaster() {
      if (master) master.gain.setTargetAtTime(enabled ? volume / 100 * 0.32 : 0, context.currentTime, 0.025);
    }
    async function unlock(explicit = false) {
      if (!enabled || document.hidden) return false;
      try {
        if (!context) {
          const Audio = window.AudioContext || window.webkitAudioContext;
          if (!Audio) throw new Error('Audio unavailable');
          context = new Audio();
          master = context.createGain();
          master.gain.value = volume / 100 * 0.32;
          const compressor = context.createDynamicsCompressor();
          compressor.threshold.value = -12;
          compressor.knee.value = 10;
          compressor.ratio.value = 3;
          master.connect(compressor);
          compressor.connect(context.destination);
          noiseBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.5), context.sampleRate);
          const data = noiseBuffer.getChannelData(0);
          for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
        }
        if (context.state === 'suspended') await context.resume();
        setMaster();
        return ready();
      } catch {
        if (explicit) {
          enabled = false;
          cancel();
          save();
          renderControls();
          notify('\u5f53\u524d\u6d4f\u89c8\u5668\u6682\u65f6\u65e0\u6cd5\u64ad\u653e\u97f3\u6548', true);
        }
        return false;
      }
    }
    function later(play, delay = 0) {
      if (!ready()) return;
      if (delay <= 0) { play(); return; }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (ready()) play();
      }, delay);
      timers.add(timer);
    }
    function voice({ frequency = 440, endFrequency, type = 'sine', noise = false,
      duration = 0.1, gain = 0.2, delay = 0, pan = 0, cutoff = 2400, filterType = 'lowpass' } = {}) {
      if (!ready() || voices.size >= 64) return;
      const source = noise ? context.createBufferSource() : context.createOscillator();
      const envelope = context.createGain();
      const filter = context.createBiquadFilter();
      const stereo = context.createStereoPanner?.();
      const start = context.currentTime + delay;
      const end = start + duration;
      if (noise) {
        source.buffer = noiseBuffer;
      } else {
        source.type = type;
        source.frequency.setValueAtTime(frequency, start);
        if (endFrequency) source.frequency.exponentialRampToValueAtTime(endFrequency, end);
      }
      filter.type = filterType;
      filter.frequency.value = cutoff;
      filter.Q.value = noise ? 0.6 : 0.4;
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.linearRampToValueAtTime(gain, start + Math.min(0.008, duration / 4));
      envelope.gain.exponentialRampToValueAtTime(0.0001, end);
      source.connect(filter);
      filter.connect(envelope);
      if (stereo) {
        stereo.pan.value = clamp(pan, -0.8, 0.8);
        envelope.connect(stereo);
        stereo.connect(master);
      } else envelope.connect(master);
      const item = { source, envelope };
      voices.add(item);
      source.onended = () => {
        voices.delete(item);
        source.disconnect();
        filter.disconnect();
        envelope.disconnect();
        stereo?.disconnect();
      };
      source.start(start);
      source.stop(end + 0.02);
    }
    function card(pan = 0, flip = false) {
      voice({ noise: true, filterType: 'bandpass', cutoff: flip ? 1300 : 3200,
        duration: flip ? 0.075 : 0.12, gain: flip ? 0.28 : 0.2, pan });
      if (flip) voice({ frequency: 210, endFrequency: 125, duration: 0.055, gain: 0.11, pan });
    }
    function clack(pan = 0, count = 3, spacing = 0.038) {
      for (let index = 0; index < count; index++) {
        const delay = index * spacing;
        const pitch = 1250 + Math.random() * 600;
        voice({ frequency: pitch, endFrequency: pitch * 0.69, duration: 0.055, gain: 0.14, delay, pan });
        voice({ noise: true, filterType: 'highpass', cutoff: 1750, duration: 0.024, gain: 0.19, delay, pan });
      }
    }
    function chime(frequencies, gain = 0.14, spacing = 0.09) {
      frequencies.forEach((frequency, index) => {
        voice({ frequency, duration: 0.24, gain, delay: index * spacing });
        voice({ frequency: frequency * 2, duration: 0.14, gain: gain * 0.17, delay: index * spacing });
      });
    }
    function allIn(pan) {
      voice({ frequency: 132, endFrequency: 66, duration: 0.32, gain: 0.3, cutoff: 700, pan });
      voice({ noise: true, cutoff: 580, duration: 0.16, gain: 0.12, pan });
      clack(pan, 5, 0.05);
    }
    function panFor(state, id) {
      const self = state.players?.find(player => player.id === state.selfId);
      const player = state.players?.find(player => player.id === id);
      if (!self || !player) return 0;
      return [0, -0.65, -0.65, 0, 0.65, 0.65][(player.seat - self.seat + 6) % 6];
    }
    function clearAudio() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const { source, envelope } of voices) {
        try {
          const now = context.currentTime;
          envelope.gain.cancelScheduledValues(now);
          envelope.gain.setTargetAtTime(0.0001, now, 0.01);
          source.stop(now + 0.035);
        } catch { /* A source may have ended in the same task. */ }
      }
      queueEnd = 0;
    }
    function cancel() {
      clearAudio();
      latest = null;
    }
    function update(previous, next, animate = true, dealDelay = 0) {
      latest = next;
      const key = next ? `${next.code}:${next.handNumber}` : '';
      if (key !== handKey) {
        clearAudio();
        handKey = key;
        warningKey = '';
        reactions.clear();
      }
      if (!next || !animate || document.hidden) { clearAudio(); return; }
      if (!ready() || !previous || previous.code !== next.code || next.handNumber < previous.handNumber) return;
      const plan = window.planChipEffects(previous, next);
      const now = performance.now();
      const start = Math.max(0, Math.min(650, queueEnd - now));
      const collectDelay = start + (plan.bets.length ? 600 : 0);
      const payoutDelay = Math.max(collectDelay + (plan.collections.length ? 620 : 0), dealDelay + 100);

      // Share the visual chip schedule so the final call, collection, and award stay distinct.
      plan.bets.forEach((bet, index) => later(() => {
        const pan = panFor(next, bet.id);
        if (bet.allIn) allIn(pan);
        else clack(pan, Math.min(5, 2 + Math.floor(Math.log10(Math.max(1, bet.amount)))));
      }, start + index * 40));
      if (plan.collections.length) later(() => {
        voice({ noise: true, cutoff: 1700, duration: 0.2, gain: 0.16 });
        clack(0, 6, 0.048);
      }, collectDelay + 220);
      if (plan.payouts.length) later(() => {
        clack(0, 5, 0.045);
        chime([523.25, 659.25, 783.99], 0.12, 0.095);
      }, payoutDelay + 420);
      if (plan.bets.length || plan.collections.length || plan.payouts.length) {
        queueEnd = now + (plan.payouts.length ? payoutDelay + 850 : plan.collections.length ? collectDelay + 620 : start + 580);
      }

      const newHand = previous.handNumber !== next.handNumber;
      let boardDelay = 0;
      if (newHand) {
        const players = next.players.filter(player => player.hasCards && player.inHand).sort((a, b) =>
          ((a.seat - next.dealerSeat - 1 + 6) % 6) - ((b.seat - next.dealerSeat - 1 + 6) % 6));
        for (let round = 0; round < 2; round++) players.forEach((player, index) => {
          const delay = (round * players.length + index) * 100;
          const pan = panFor(next, player.id);
          later(() => card(pan), delay);
          if (player.cards?.length) later(() => card(pan, true), delay + 380);
        });
        boardDelay = players.length * 200 + 480;
      }
      const previousBoardCount = newHand ? 0 : (previous.board?.length || 0);
      for (let index = previousBoardCount; index < (next.board?.length || 0); index++) {
        const runoutPause = index >= 3 ? (index - Math.max(2, previousBoardCount - 1)) * 220 : 0;
        const delay = boardDelay + (index - previousBoardCount) * 140 + runoutPause;
        later(() => card(), delay);
        later(() => card(0, true), delay + 380);
      }
      if (!newHand) for (const player of next.players) {
        const old = previous.players.find(item => item.id === player.id);
        if (!player.cards?.length || !old?.hasCards || old.cards?.length) continue;
        player.cards.forEach((_, index) => later(() => card(panFor(next, player.id), true), index * 100));
      }

      if (!newHand && previous.phase === 'playing') {
        const actor = previous.players.find(player => player.seat === previous.turnSeat);
        const current = next.players.find(player => player.id === actor?.id);
        if (current?.folded && !actor.folded) {
          later(() => {
            voice({ noise: true, cutoff: 1200, duration: 0.17, gain: 0.16, pan: panFor(next, current.id) });
          }, start);
        } else if (current?.inHand && !current.folded && previous.turnId !== next.turnId &&
          !plan.bets.some(bet => bet.id === current.id)) {
          later(() => {
            voice({ frequency: 170, endFrequency: 95, duration: 0.065, gain: 0.2, pan: panFor(next, current.id) });
            voice({ frequency: 180, endFrequency: 100, duration: 0.06, gain: 0.12, delay: 0.09, pan: panFor(next, current.id) });
          }, start);
        }
      }
      const self = next.players.find(player => player.id === next.selfId);
      if (next.phase === 'playing' && self?.seat === next.turnSeat &&
        (newHand || previous.turnId !== next.turnId || previous.turnSeat !== next.turnSeat)) {
        const turn = next.turnId;
        later(() => {
          if (latest?.phase === 'playing' && latest.turnId === turn && latest.turnSeat === self.seat) chime([659.25, 880], 0.105);
        }, Math.max(80, dealDelay + 80));
      }
    }
    function tick(state) {
      if (!ready() || !latest || !state || state.phase !== 'playing' || !state.turnDeadline) return;
      const self = state.players.find(player => player.id === state.selfId);
      if (!self || self.seat !== state.turnSeat) return;
      const seconds = Math.ceil((state.turnDeadline - Date.now()) / 1000);
      if (seconds < 1 || seconds > 5) return;
      const key = `${state.code}:${state.handNumber}:${state.turnId}:${seconds}`;
      if (warningKey === key) return;
      warningKey = key;
      voice({ frequency: seconds <= 2 ? 880 : 740, duration: 0.075, gain: 0.13 });
    }
    function reaction(event) {
      if (!ready() || !latest || event?.code !== latest.code || reactions.has(event.id)) return;
      if (event.id) reactions.add(event.id);
      if (reactions.size > 100) reactions.delete(reactions.values().next().value);
      const now = performance.now();
      if (now - lastReactionAt < 350) return;
      lastReactionAt = now;
      if (event.reactionId === 'rose') {
        chime([784, 987.77, 1174.66], 0.09, 0.085);
        voice({ noise: true, cutoff: 2200, duration: 0.18, gain: 0.07 });
      } else if (event.reactionId === 'applause') {
        for (let index = 0; index < 3; index++) voice({ noise: true, filterType: 'bandpass', cutoff: 950,
          duration: 0.065, gain: 0.13, delay: index * 0.075 });
      } else chime([660, 830], 0.075, 0.07);
    }

    button?.addEventListener('click', async () => {
      enabled = !enabled;
      if (!enabled) clearAudio();
      save();
      renderControls();
      setMaster();
      if (enabled && await unlock(true)) chime([659.25, 880], 0.09);
    });
    volumeInput?.addEventListener('input', () => {
      const next = Number(volumeInput.value);
      volume = Number.isFinite(next) ? clamp(next, 0, 100) : volume;
      if (volume === 0) clearAudio();
      setMaster();
      save();
      renderControls();
      if (enabled) void unlock();
    });
    document.addEventListener('pointerdown', () => { if (enabled) void unlock(); }, { passive: true });
    document.addEventListener('keydown', () => { if (enabled) void unlock(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearAudio(); });
    renderControls();
    return { update, reaction, tick, cancel };
  };
})();
