import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/audio.js', import.meta.url), 'utf8');
const planner = readFileSync(new URL('../public/chip-plan.js', import.meta.url), 'utf8');

function harness({ preferences, supported = true } = {}) {
  let now = 100000;
  let timerId = 0;
  const timers = new Map();
  const sources = [];
  const contexts = [];
  const notices = [];
  const storage = new Map(preferences ? [['tongzhuo-audio', JSON.stringify(preferences)]] : []);
  const setTimer = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, time: now + delay });
    return id;
  };
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.time <= target).sort((a, b) => a[1].time - b[1].time)[0];
      if (!entry) break;
      now = entry[1].time;
      timers.delete(entry[0]);
      entry[1].callback();
    }
    now = target;
  }
  class Element {
    constructor() { this.listeners = new Map(); this.attributes = new Map(); this.value = ''; }
    addEventListener(name, callback) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(callback);
      this.listeners.set(name, listeners);
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    async fire(name) { for (const callback of this.listeners.get(name) || []) await callback({ target: this }); }
  }
  class Param {
    constructor() { this.value = 0; }
    setValueAtTime(value) { this.value = value; }
    setTargetAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
    exponentialRampToValueAtTime(value) { this.value = value; }
    cancelScheduledValues() {}
  }
  class Node {
    constructor() {
      for (const name of ['gain', 'frequency', 'Q', 'pan', 'threshold', 'knee', 'ratio']) this[name] = new Param();
    }
    connect() {}
    disconnect() {}
  }
  class AudioContext {
    constructor() {
      this.state = 'suspended';
      this.sampleRate = 44100;
      this.destination = new Node();
      contexts.push(this);
    }
    get currentTime() { return now / 1000; }
    async resume() { this.state = 'running'; }
    createGain() { return new Node(); }
    createDynamicsCompressor() { return new Node(); }
    createBiquadFilter() { return new Node(); }
    createStereoPanner() { return new Node(); }
    createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createSource(kind) {
      const node = new Node();
      node.kind = kind;
      node.start = time => { node.startedAt = time * 1000; sources.push(node); };
      node.stop = time => {
        if (node.endTimer) timers.delete(node.endTimer);
        node.stoppedAt = time * 1000;
        node.endTimer = setTimer(() => node.onended?.(), Math.max(0, node.stoppedAt - now));
      };
      return node;
    }
    createOscillator() { return this.createSource('tone'); }
    createBufferSource() { return this.createSource('noise'); }
  }
  const document = new Element();
  document.hidden = false;
  const button = new Element();
  const volumeInput = new Element();
  const scope = {
    document,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: setTimer, clearTimeout: id => timers.delete(id),
    performance: { now: () => now }, Date: { now: () => now },
  };
  if (supported) scope.AudioContext = AudioContext;
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(planner, scope);
  vm.runInContext(script, scope);
  const audio = scope.createTableAudio({ button, volumeInput, notify: (...args) => notices.push(args) });
  return { audio, button, volumeInput, document, advance, sources, contexts, notices, storage, now: () => now };
}

const player = (id, seat, stack, bet = 0) => ({ id, seat, stack, bet, inHand: true, hasCards: true, folded: false });
const playing = () => ({
  code: 'TABLE1', phase: 'playing', handNumber: 1, turnId: 1, selfId: 'a', turnSeat: 0,
  dealerSeat: 0, round: 'river', board: [1, 2, 3, 4, 5], result: [],
  players: [player('a', 0, 900, 100), player('b', 1, 900, 100)],
});
const finished = () => ({
  ...playing(), phase: 'finished', turnId: 2, turnSeat: null,
  players: [player('a', 0, 1100), player('b', 1, 900)], result: [{ id: 'a', amount: 200 }],
});

test('sound remains silent until enabled, and saved enable still requires a browser gesture', async () => {
  const env = harness();
  env.audio.update(playing(), finished());
  env.advance(5000);
  assert.equal(env.contexts.length, 0);
  assert.equal(env.button.attributes.get('aria-pressed'), 'false');
  await env.button.fire('click');
  assert.equal(env.contexts.length, 1);
  assert.ok(env.sources.length > 0);
  assert.equal(JSON.parse(env.storage.get('tongzhuo-audio')).enabled, true);

  const restored = harness({ preferences: { enabled: true, volume: 25 } });
  restored.audio.update(playing(), finished());
  assert.equal(restored.contexts.length, 0);
  await restored.document.fire('pointerdown');
  assert.equal(restored.contexts[0].state, 'running');
  assert.equal(restored.sources.length, 0);
});

test('settlement audio waits for card reveal, does not replay, and reconnect is silent', async () => {
  const env = harness({ preferences: { enabled: true, volume: 35 } });
  await env.document.fire('pointerdown');
  env.audio.update(playing(), finished(), true, 1800);
  env.advance(2200);
  const collectingSources = env.sources.length;
  assert.ok(collectingSources > 0);
  env.advance(200);
  assert.ok(env.sources.length > collectingSources, 'Award plays after the board reveal.');
  env.advance(2000);
  const allSources = env.sources.length;
  env.audio.update(finished(), finished());
  env.audio.update(null, finished(), false);
  env.advance(5000);
  assert.equal(env.sources.length, allSources);
});

test('disconnect, mute, and hidden tabs cancel pending awards and live warning cues', async () => {
  const env = harness({ preferences: { enabled: true, volume: 35 } });
  await env.document.fire('pointerdown');
  env.audio.update(playing(), finished(), true, 1800);
  env.audio.cancel();
  const count = env.sources.length;
  env.advance(5000);
  env.audio.tick({ ...playing(), turnDeadline: env.now() + 4000 });
  env.audio.reaction({ id: 'r1', code: 'TABLE1', reactionId: 'rose' });
  assert.equal(env.sources.length, count);

  env.audio.update(playing(), finished(), true, 1800);
  await env.button.fire('click');
  const mutedCount = env.sources.length;
  env.advance(5000);
  assert.equal(env.sources.length, mutedCount);
  await env.button.fire('click');
  env.advance(1000);
  env.audio.update(playing(), finished(), true, 1800);
  env.document.hidden = true;
  await env.document.fire('visibilitychange');
  const hiddenCount = env.sources.length;
  env.advance(5000);
  assert.equal(env.sources.length, hiddenCount);
});

test('countdown cues occur only once per second on the local turn; reactions stay in the current room', async () => {
  const env = harness({ preferences: { enabled: true, volume: 35 } });
  await env.document.fire('pointerdown');
  const state = { ...playing(), turnDeadline: env.now() + 5000 };
  env.audio.update(null, state, false);
  env.audio.tick({ ...state, turnSeat: 1 });
  assert.equal(env.sources.length, 0);
  env.audio.tick(state);
  const count = env.sources.length;
  assert.equal(count, 1);
  env.audio.tick(state);
  assert.equal(env.sources.length, count);
  env.advance(1000);
  env.audio.tick(state);
  assert.equal(env.sources.length, count + 1);
  env.audio.reaction({ id: 'wrong', code: 'OTHER', reactionId: 'rose' });
  assert.equal(env.sources.length, count + 1);
  env.audio.reaction({ id: 'right', code: state.code, reactionId: 'rose' });
  const roseCount = env.sources.length;
  assert.ok(roseCount > count + 1);
  env.advance(1000);
  env.audio.reaction({ id: 'right', code: state.code, reactionId: 'rose' });
  assert.equal(env.sources.length, roseCount);
});

test('browsers without audio keep table controls usable and report the failed explicit enable', async () => {
  const env = harness({ supported: false });
  await env.button.fire('click');
  assert.equal(env.button.attributes.get('aria-pressed'), 'false');
  assert.equal(env.notices.length, 1);
  assert.equal(env.notices[0][1], true);
  assert.doesNotThrow(() => env.audio.update(playing(), finished()));
});
