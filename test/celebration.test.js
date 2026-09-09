import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/celebration.js', import.meta.url), 'utf8');
const straight = '\u987a\u5b50';
const quads = '\u56db\u6761';
const royal = '\u7687\u5bb6\u540c\u82b1\u987a';
const playing = (fields = {}) => ({ code: 'TABLE1', handNumber: 1, phase: 'playing', result: [], ...fields });
const winner = (fields = {}) => ({ id: 'a', name: 'Alice', revealed: true, reason: 'showdown', hand: { name: straight, complete: true }, ...fields });
const finished = (fields = {}) => playing({ phase: 'finished', result: [winner()], ...fields });

function harness() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const allAnimations = [];
  const docListeners = new Map();
  const motionListeners = new Map();
  const windowListeners = new Map();
  const motion = { matches: false, addEventListener: (event, callback) => motionListeners.set(event, callback) };
  class Element {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.style = { setProperty(name, value) { this[name] = value; } };
    }
    append(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    setAttribute() {}
    removeAttribute(name) { if (name === 'data-celebration') delete this.dataset.celebration; }
    animate() {
      const animation = { canceled: false, cancel() { this.canceled = true; } };
      allAnimations.push(animation);
      return animation;
    }
  }
  const document = { hidden: false, createElement: () => new Element(), addEventListener: (event, callback) => docListeners.set(event, callback) };
  const window = { addEventListener: (event, callback) => windowListeners.set(event, callback) };
  vm.runInNewContext(script, {
    window, document, matchMedia: () => motion,
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const stage = new Element();
  stage.clientWidth = 390;
  stage.clientHeight = 588;
  const effects = window.createHandCelebration(stage);
  const layer = stage.children[0];
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      timers.delete(entry[0]);
      now = entry[1].at;
      entry[1].callback();
    }
    now = end;
  }
  return {
    effects, layer, advance, timers, allAnimations,
    hide() { document.hidden = true; docListeners.get('visibilitychange')(); },
    show() { document.hidden = false; docListeners.get('visibilitychange')(); },
    reduce(value) { motion.matches = value; motionListeners.get('change')(); },
    resize() { windowListeners.get('resize')(); },
  };
}

test('public settlement waits for dealing once without duplicate broadcasts extending the delay', () => {
  const { effects, layer, advance, timers } = harness();
  const next = finished();
  effects.update(playing(), next, true, 1200);
  advance(800);
  effects.update(next, { ...next }, true, 1200);
  assert.equal(layer.children.length, 0);
  assert.equal(timers.size, 1);
  advance(400);
  assert.equal(layer.dataset.celebration, straight);
  assert.ok(layer.children.length > 10);
  advance(2700);
  assert.equal(layer.children.length, 0);
  effects.update(next, next);
  advance(5000);
  assert.equal(layer.children.length, 0);
});

test('private hand descriptions, incomplete hands and weak hands never trigger particles', () => {
  for (const result of [
    [winner({ revealed: false, reason: 'folds' })],
    [winner({ hand: { name: straight, complete: false } })],
    [winner({ hand: { name: '\u4e00\u5bf9', complete: true } })],
  ]) {
    const { effects, layer, advance } = harness();
    effects.update(playing(), finished({ result }));
    advance(5000);
    assert.equal(layer.children.length, 0);
  }
});

test('first voluntary public reveal can celebrate after loading an unrevealed finished hand', () => {
  const { effects, layer, advance } = harness();
  const hidden = finished({ result: [winner({ revealed: false, reason: 'folds' })] });
  effects.update(null, hidden, false);
  const revealed = finished({ result: [winner({ reason: 'folds' })] });
  effects.update(hidden, revealed);
  advance(0);
  assert.equal(layer.dataset.celebration, straight);
  effects.cancel();
  effects.update(hidden, revealed);
  advance(0);
  assert.equal(layer.children.length, 0);
});

test('initial loading, reconnects and already public results never replay a celebration', () => {
  for (const [previous, shouldAnimate] of [[null, true], [playing(), false], [finished(), true]]) {
    const { effects, layer, advance } = harness();
    const next = finished();
    effects.update(previous, next, shouldAnimate);
    effects.update(next, next);
    advance(10000);
    assert.equal(layer.children.length, 0);
  }
});

test('next hand, room change and leaving cancel a pending effect', () => {
  for (const next of [playing({ handNumber: 2 }), playing({ code: 'TABLE2' }), null]) {
    const { effects, layer, advance, timers } = harness();
    effects.update(playing(), finished(), true, 1500);
    effects.update(finished(), next);
    advance(2000);
    assert.equal(layer.children.length, 0);
    assert.equal(timers.size, 0);
  }
});

test('hidden pages and reduced motion cancel both queued and active effects without replaying', () => {
  for (const trigger of ['hide', 'reduce']) {
    for (const delay of [0, 1000]) {
      const h = harness();
      const next = finished();
      h.effects.update(playing(), next, true, delay);
      h.advance(0);
      h[trigger](true);
      assert.ok(h.allAnimations.every(animation => animation.canceled));
      assert.equal(h.layer.children.length, 0);
      h.show();
      h.reduce(false);
      h.effects.update(next, next);
      h.advance(5000);
      assert.equal(h.layer.children.length, 0);
    }
  }
});

test('split pots use the strongest public hand and never a stronger hidden hand', () => {
  const { effects, layer, advance } = harness();
  const result = [winner(), winner({ hand: { name: quads, complete: true } }), winner({ revealed: false, hand: { name: royal, complete: true } })];
  effects.update(playing(), finished({ result }));
  advance(0);
  assert.equal(layer.dataset.celebration, quads);
  assert.equal(layer.children[0].textContent, '\u56db\u6761\u00b7\u70b8\u5f39');
});

test('rotating or resizing cancels pixel paths and cannot replay the same settlement', () => {
  const h = harness();
  const next = finished();
  h.effects.update(playing(), next);
  h.advance(0);
  assert.ok(h.layer.children.length > 0);
  h.resize();
  assert.ok(h.allAnimations.every(animation => animation.canceled));
  assert.equal(h.layer.children.length, 0);
  h.effects.update(next, next);
  h.advance(3000);
  assert.equal(h.layer.children.length, 0);
});
