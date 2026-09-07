import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/chip-plan.js';

const planChipEffects = globalThis.planChipEffects;
const empty = () => ({ newHand: false, bets: [], collections: [], payouts: [] });
const player = (id, stack = 1000, bet = 0, fields = {}) => ({ id, stack, bet, inHand: true, ...fields });
const state = (players, fields = {}) => ({
  code: 'TABLE1', phase: 'playing', handNumber: 1, round: 'preflop', players, result: [], ...fields,
});

test('initial and reconnect baselines, different rooms and older hands have no effects', () => {
  const current = state([player('a', 990, 10)]);
  assert.deepEqual(planChipEffects(null, current), empty());
  assert.deepEqual(planChipEffects(current, null), empty());
  assert.deepEqual(planChipEffects(current, { ...current, code: 'TABLE2' }), empty());
  assert.deepEqual(planChipEffects({ ...current, handNumber: 2 }, current), empty());
  assert.deepEqual(planChipEffects(current, current), empty());
});

test('new hand posts blinds, including a bot that just replenished its stack', () => {
  const previous = state([player('a'), player('b', 0)], { phase: 'finished' });
  const next = state([player('a', 990, 10), player('b', 980, 20)], { handNumber: 2 });
  assert.deepEqual(planChipEffects(previous, next), {
    newHand: true,
    bets: [{ id: 'a', amount: 10, allIn: false }, { id: 'b', amount: 20, allIn: false }],
    collections: [], payouts: [],
  });
});

test('first manually started hand animates blinds for previously waiting seats', () => {
  const previous = state([player('a', 1000, 0, { inHand: false }), player('b', 1000, 0, { inHand: false })], {
    phase: 'lobby', handNumber: 0, round: null,
  });
  const next = state([player('a', 990, 10), player('b', 980, 20)]);
  assert.equal(planChipEffects(previous, next).bets.length, 2);
});

test('a raise animates only the additional payment and does not collect current bets', () => {
  const previous = state([player('a', 990, 10), player('b', 980, 20)]);
  const next = state([player('a', 940, 60), player('b', 980, 20)]);
  assert.deepEqual(planChipEffects(previous, next), {
    ...empty(), bets: [{ id: 'a', amount: 50, allIn: false }],
  });
});

test('a street-ending call collects both previous bets and the final payment', () => {
  const previous = state([player('a', 940, 60), player('b', 980, 20)]);
  const next = state([player('a', 940), player('b', 940)], { round: 'flop' });
  assert.deepEqual(planChipEffects(previous, next), {
    ...empty(), bets: [{ id: 'b', amount: 40, allIn: false }],
    collections: [{ id: 'a', amount: 60 }, { id: 'b', amount: 60 }],
  });
});

test('folded bets enter the pot even when the betting street is unchanged', () => {
  const previous = state([player('a', 940, 60), player('b', 980, 20), player('c', 940, 60)]);
  const next = state([player('a', 940, 60), player('b', 980, 0, { folded: true }), player('c', 940, 60)]);
  assert.deepEqual(planChipEffects(previous, next), {
    ...empty(), collections: [{ id: 'b', amount: 20 }],
  });
});

test('a winning final all-in call is recovered from its gross award', () => {
  const previous = state([player('a', 0, 1000), player('b', 700, 300)], { round: 'river' });
  const next = state([player('a', 0), player('b', 2000)], {
    phase: 'finished', round: 'river', result: [{ id: 'b', amount: 2000 }],
  });
  assert.deepEqual(planChipEffects(previous, next), {
    ...empty(), bets: [{ id: 'b', amount: 700, allIn: true }],
    collections: [{ id: 'a', amount: 1000 }, { id: 'b', amount: 1000 }],
    payouts: [{ id: 'b', amount: 2000 }],
  });
});

test('uncalled excess returned in an award is not mistaken for a new bet', () => {
  const previous = state([player('a', 400, 600), player('b', 200, 200)]);
  const next = state([player('a', 600), player('b', 800)], {
    phase: 'finished', round: 'river', result: [{ id: 'a', amount: 200 }, { id: 'b', amount: 800 }],
  });
  assert.deepEqual(planChipEffects(previous, next), {
    ...empty(), bets: [{ id: 'b', amount: 200, allIn: true }],
    collections: [{ id: 'a', amount: 600 }, { id: 'b', amount: 400 }],
    payouts: [{ id: 'a', amount: 200 }, { id: 'b', amount: 800 }],
  });
});

test('a split award can pay multiple winners without producing phantom payments', () => {
  const previous = state([player('a', 800, 100), player('b', 800, 100)], { round: 'river' });
  const next = state([player('a', 1000), player('b', 1000)], {
    phase: 'finished', round: 'river', result: [{ id: 'a', amount: 200 }, { id: 'b', amount: 200 }],
  });
  const plan = planChipEffects(previous, next);
  assert.deepEqual(plan.bets, []);
  assert.deepEqual(plan.collections, [{ id: 'a', amount: 100 }, { id: 'b', amount: 100 }]);
  assert.deepEqual(plan.payouts, [{ id: 'a', amount: 200 }, { id: 'b', amount: 200 }]);
});

test('a hand finishing on its forced bets still pushes, collects and pays once', () => {
  const previous = state([player('a', 5), player('b', 10)], { phase: 'finished' });
  const next = state([player('a', 0), player('b', 15)], {
    handNumber: 2, phase: 'finished', round: 'river', result: [{ id: 'b', amount: 15 }],
  });
  assert.deepEqual(planChipEffects(previous, next), {
    newHand: true,
    bets: [{ id: 'a', amount: 5, allIn: true }, { id: 'b', amount: 10, allIn: true }],
    collections: [{ id: 'a', amount: 5 }, { id: 'b', amount: 10 }],
    payouts: [{ id: 'b', amount: 15 }],
  });
  assert.deepEqual(planChipEffects(next, next), empty());
});

test('repeated finished states, rebuys and joins do not replay awards', () => {
  const previous = state([player('a', 0), player('b', 2000)], {
    phase: 'finished', result: [{ id: 'b', amount: 2000 }],
  });
  const next = { ...previous, players: [player('a'), player('b', 2000), player('c', 1000, 0, { inHand: false })] };
  assert.deepEqual(planChipEffects(previous, previous), empty());
  assert.deepEqual(planChipEffects(previous, next), empty());
});

test('an instant blind showdown accounts for a bot replenished before posting', () => {
  const previous = state([player('a', 5), player('bot', 0, 0, { isBot: true })], { phase: 'finished' });
  const next = state([player('a', 0), player('bot', 1005, 0, { isBot: true })], {
    buyIn: 1000, handNumber: 2, phase: 'finished', round: 'river', result: [{ id: 'bot', amount: 25 }],
  });
  assert.deepEqual(planChipEffects(previous, next), {
    newHand: true,
    bets: [{ id: 'a', amount: 5, allIn: true }, { id: 'bot', amount: 20, allIn: false }],
    collections: [{ id: 'a', amount: 5 }, { id: 'bot', amount: 20 }],
    payouts: [{ id: 'bot', amount: 25 }],
  });
});

test('waiting or absent players and a canceled hand do not become betting effects', () => {
  const previous = state([player('a', 1000, 0, { inHand: false }), player('b'), player('gone', 900, 100)]);
  const next = state([player('a', 900, 100, { inHand: false }), player('b'), player('new', 900, 100)]);
  assert.deepEqual(planChipEffects(previous, next), empty());
  assert.deepEqual(planChipEffects(previous, { ...next, phase: 'lobby', round: null }), empty());
});
