import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/mahjong/effects.js', import.meta.url), 'utf8');
const context = { module: { exports: {} } };
vm.runInNewContext(source, context);
const { createMahjongEffects, planMahjongEffects } = context.module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const plan = (before, after) => plain(planMahjongEffects(before, after));
function snapshot(turn = 1, overrides = {}) {
  const result = {
    code: 'MOTION', selfId: 'me', phase: 'playing',
    players: Array.from({ length: 4 }, (_, seat) => ({ seat, id: seat ? `opponent-${seat}` : 'me', stack: 2000 })),
    round: { id: 'round-a', turnId: turn, turnSeat: 0, wallCount: 59, events: [], lastDiscard: null, drawnTile: 'p5',
      players: Array.from({ length: 4 }, (_, seat) => ({ seat, handCount: seat ? 13 : 14, hand: seat ? [] : ['m1', 'p5'], melds: [], discards: [] })) }
  };
  return { ...result, ...overrides, round: overrides.round === null ? null : { ...result.round, ...overrides.round } };
}

test('effects seed initial/reconnected rounds and animate only a live initial deal', () => {
  const waiting = snapshot(0, { phase: 'waiting', round: null });
  assert.deepEqual(plan(null, snapshot()), []);
  assert.deepEqual(plan(waiting, snapshot()), [{ kind: 'deal' }]);
  assert.deepEqual(plan(waiting, snapshot(5)), []);
  assert.deepEqual(plan(snapshot(20, { phase: 'finished' }), snapshot(1, { round: { id: 'round-b' } })), [{ kind: 'deal' }]);
  assert.deepEqual(plan(snapshot(), snapshot(2, { code: 'OTHER' })), []);
  assert.deepEqual(plan(snapshot(), snapshot(2, { selfId: 'another-person' })), []);
});

test('discard identity suppresses duplicate reactions and opponent draws never use hidden faces', () => {
  const before = snapshot();
  const discard = { id: 2, seat: 0, kind: 'discard', tile: 'm1' };
  const after = snapshot(2, { round: { turnSeat: 1, wallCount: 58, lastDiscard: discard, drawnTile: 's9' } });
  assert.deepEqual(plan(before, after), [
    { kind: 'discard', seat: 0, tile: 'm1' }, { kind: 'draw', seat: 1, tile: null, delay: 160 }
  ]);
  assert.deepEqual(plan(after, after), []);
  assert.deepEqual(plan(after, snapshot()), []);
  assert.deepEqual(plan(after, snapshot(3, { round: { lastDiscard: { ...discard, claimed: true }, wallCount: 58 } })), []);
  assert.deepEqual(plan(before, snapshot(2, { round: { lastDiscard: { ...discard, kind: 'robKong' } } })), []);
});

test('settlements show all winners once, share a bounded particle budget, and preserve deltas', () => {
  const event = {
    id: 'round-a:1', kind: 'hu', selfDraw: false,
    winners: [1, 2, 3].map((seat) => ({ seat, hand: { multiplier: 16, tiles: ['m9', 'p1'] } })),
    changes: [{ seat: 0, delta: -480 }, ...[1, 2, 3].map((seat) => ({ seat, delta: 160 }))]
  };
  const after = snapshot(2, { round: { events: [event] } });
  const effects = plan(snapshot(), after);
  const winners = effects.filter((item) => item.kind === 'callout');
  assert.equal(winners.length, 3);
  assert.equal(winners.reduce((sum, winner) => sum + winner.particles, 0), 24);
  assert.equal(effects.filter((item) => item.kind === 'chips').reduce((sum, change) => sum + change.delta, 0), 0);
  assert.equal(JSON.stringify(effects).includes('m9'), false);
  assert.equal(effects.some((item) => item.kind === 'draw'), false, 'self/ron hu does not invent a draw');
  assert.deepEqual(plan(after, snapshot(3, { round: { events: [event] } })), []);
});

test('peng and concealed kong use public summaries without reading concealed meld tiles', () => {
  const before = snapshot();
  const after = snapshot(2);
  after.round.players[1].melds.push({ kind: 'peng', tiles: ['m3', 'm3', 'm3'] });
  after.round.events.push({ id: 'round-a:1', kind: 'gang', seat: 2, gangKind: 'concealedGang', tile: null, changes: [] });
  const effects = plan(before, after);
  assert.equal(effects.length, 2);
  assert.deepEqual(effects.map((item) => [item.seat, item.label]), [[1, '碰'], [2, '杠']]);
  assert.equal(JSON.stringify(effects).includes('m3'), false);
  assert.equal(effects[1].detail, '暗杠');
});

function browserHarness({ reduced = false, animationSupport = true, mediaSupport = true } = {}) {
  const animations = [];
  const timers = new Map();
  let nextTimer = 1;
  const listeners = new Map();
  const register = (key) => (name, fn) => listeners.set(`${key}:${name}`, fn);
  const remove = (key) => (name) => listeners.delete(`${key}:${name}`);
  const media = { matches: reduced, addEventListener: register('media'), removeEventListener: remove('media') };
  const win = { matchMedia: () => media, setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, addEventListener: register('window'), removeEventListener: remove('window') };
  if (!mediaSupport) win.matchMedia = undefined;
  const doc = { hidden: false, defaultView: win, addEventListener: register('document'), removeEventListener: remove('document') };
  class Node {
    constructor() { this.ownerDocument = doc; this.children = []; this.dataset = {}; this.style = {}; this.className = ''; this.hidden = false; this.queries = new Map(); this.allQueries = new Map(); this.classList = { contains: (name) => this.className.split(' ').includes(name) }; }
    setAttribute() {}
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
    getBoundingClientRect() { return { left: 100, top: 100, width: 44, height: 60 }; }
    querySelector(selector) { return this.queries.get(selector) || null; }
    querySelectorAll(selector) { return this.allQueries.get(selector) || []; }
    animate(frames, options) {
      const animation = { frames, options, cancelled: false, node: this, cancel() { this.cancelled = true; this.oncancel?.(); } };
      animations.push(animation);
      return animation;
    }
  }
  doc.createElement = () => new Node();
  doc.body = new Node();
  const root = new Node();
  const table = new Node();
  const hand = new Node();
  const tile = new Node(); tile.dataset = { tile: 'm1', handIndex: '0' }; tile.className = 'is-selected is-drawn';
  const chip = new Node();
  hand.allQueries.set('[data-hand-index]', [tile]);
  hand.allQueries.set('[data-tile]', [tile]);
  hand.queries.set('.is-drawn', tile);
  root.allQueries.set('.mj-hidden-hand', []);
  root.queries.set('[data-chip-seat="0"]', chip);
  root.queries.set('#mj-last-discard .mj-tile', tile);
  root.queries.set('#mj-round-result', new Node());
  for (let seat = 0; seat < 4; seat++) root.queries.set(`[data-player-seat="${seat}"]`, new Node());
  if (!animationSupport) root.animate = undefined;
  const effects = createMahjongEffects({ root, table, hand, tileMarkup: () => '<span class="mj-tile">public tile</span>' });
  const receive = (next) => effects.update(next, effects.capture());
  return { effects, receive, animations, timers, listeners, media, doc, root, finish() { for (const fn of [...timers.values()]) fn(); } };
}

test('visibility, resize and reduced motion cancel active effects and do not replay on return', () => {
  for (const trigger of ['document:visibilitychange', 'window:resize', 'media:change']) {
    const harness = browserHarness();
    harness.receive(snapshot());
    const after = snapshot(2, { round: { lastDiscard: { id: 2, seat: 0, tile: 'm1', kind: 'discard' } } });
    harness.receive(after);
    assert.ok(harness.animations.length > 0);
    assert.ok(harness.doc.body.children[0].children.length > 0);
    harness.listeners.get(trigger)();
    assert.ok(harness.animations.every((animation) => animation.cancelled));
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.doc.body.children[0].children.length, 0);
    const count = harness.animations.length;
    harness.receive(after);
    assert.equal(harness.animations.length, count);
    harness.effects.destroy();
    assert.equal(harness.listeners.size, 0);
    assert.equal(harness.doc.body.children.length, 0);
  }
});

test('late old snapshots cannot roll back the animation baseline and replay a discard', () => {
  const harness = browserHarness();
  const before = snapshot();
  const after = snapshot(2, { round: { lastDiscard: { id: 2, seat: 0, tile: 'm1', kind: 'discard' } } });
  harness.receive(before);
  harness.receive(after);
  const count = harness.animations.length;
  harness.receive(before);
  harness.receive(after);
  assert.equal(harness.animations.length, count);
  harness.finish();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.doc.body.children[0].children.length, 0);
  harness.effects.destroy();
});

test('reduced motion and missing browser animation APIs leave final DOM and gameplay untouched', () => {
  for (const options of [{ reduced: true }, { animationSupport: false }, { mediaSupport: false }]) {
    const harness = browserHarness(options);
    harness.receive(snapshot(0, { phase: 'waiting', round: null }));
    harness.receive(snapshot());
    assert.equal(harness.animations.length, 0);
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.doc.body.children.length, 0);
    harness.effects.destroy();
  }
});
