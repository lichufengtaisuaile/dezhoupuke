import test from 'node:test';
import assert from 'node:assert/strict';
import { createTable } from '../engine.js';

const ranks = '23456789TJQKA';
const suits = 'cdhs';
function rigged(stacks, holes, board, blinds = { smallBlind: 10, bigBlind: 20 }) {
  const drawn = [...holes.flat(), ...board];
  assert.equal(new Set(drawn).size, drawn.length);
  const table = createTable(blinds, 6, {
    shuffle(deck) {
      const cards = new Map([...deck].map(card => [ranks[card.rank] + suits[card.suit], card]));
      const order = [...drawn, ...cards.keys().filter(code => !drawn.includes(code))];
      order.forEach((code, index) => { deck[51 - index] = cards.get(code); });
    },
  });
  stacks.forEach((stack, seat) => table.sitDown(seat, stack));
  table.startHand(0);
  table.initialTotal = stacks.reduce((sum, stack) => sum + stack, 0);
  conserve(table);
  return table;
}
function conserve(table) {
  const chips = table.seats().reduce((sum, player) => sum + (player?.totalChips ?? 0), 0);
  const pot = table.isHandInProgress() ? table.pots().reduce((sum, current) => sum + current.size, 0) : 0;
  assert.equal(chips + pot, table.initialTotal);
}
function act(table, action, amount) {
  table.actionTaken(action, amount);
  conserve(table);
}
function advance(table) {
  table.endBettingRound();
  conserve(table);
}
function finish(table) {
  let guard = 0;
  while (table.isHandInProgress()) {
    assert(++guard < 100, 'Hand must finish');
    if (table.areBettingRoundsCompleted()) {
      table.showdown();
      conserve(table);
    } else if (table.isBettingRoundInProgress()) {
      act(table, table.legalActions().actions.includes('check') ? 'check' : 'call');
    } else advance(table);
  }
}
function stacks(table, count) {
  return table.seats().slice(0, count).map(player => player?.stack ?? 0);
}

test('two trips make the higher full house', () => {
  const table = rigged([1000, 1000], [['Ah', 'Ad'], ['Qh', 'Qd']], ['Ac', 'Kh', 'Kd', 'Ks', '2c']);
  finish(table);
  assert.deepEqual(stacks(table, 2), [1020, 980]);
  assert.equal(table.winners()[0][0][1].ranking, 6);
});

test('four of a kind keeps the highest kicker', () => {
  const table = rigged([1000, 1000], [['As', '3c'], ['Kd', '4d']], ['9c', '9d', '9h', '9s', '2c']);
  finish(table);
  assert.deepEqual(stacks(table, 2), [1020, 980]);
  assert.equal(table.winners()[0][0][1].ranking, 7);
  assert(table.winners()[0][0][1].cards.some(card => card.rank === 'A'));
});

test('a board tie splits the pot and sends its odd chip left of the button', () => {
  const table = rigged([1000, 1000, 1000], [['2c', '3c'], ['4d', '5d'], ['6h', '7h']],
    ['As', 'Ks', 'Qs', 'Js', 'Ts'], { smallBlind: 1, bigBlind: 2 });
  act(table, 'call');
  act(table, 'fold');
  finish(table);
  assert.deepEqual(stacks(table, 3), [1000, 999, 1001]);
  assert.equal(table.winners()[0].length, 2);
  assert.equal(table.winners()[0][0][1].ranking, 9);
});

test('a short all-in preserves the minimum and does not reopen prior callers', () => {
  const table = rigged([1000, 130, 1000, 1000], [['2c', '3c'], ['4d', '5d'], ['6h', '7h'], ['8c', '9d']],
    ['As', 'Ks', 'Qs', 'Js', 'Ts']);
  assert.equal(table.playerToAct(), 3);
  act(table, 'raise', 100);
  act(table, 'call');
  act(table, 'raise', 130);
  assert.equal(table.legalActions().chipRange.min, 210);
  act(table, 'call');
  assert.equal(table.playerToAct(), 3);
  assert.deepEqual(table.legalActions().actions, ['fold', 'call']);
  assert.throws(() => table.actionTaken('raise', 210));
  conserve(table);
  finish(table);
});

test('cumulative short all-ins reopen action after a full raise increment', () => {
  const table = rigged([150, 200, 1000, 1000, 1000],
    [['2c', '3c'], ['4d', '5d'], ['6h', '7h'], ['8c', '9d'], ['Tc', 'Jd']],
    ['As', 'Ks', 'Qs', 'Js', 'Ts']);
  act(table, 'raise', 100);
  act(table, 'call');
  act(table, 'raise', 150);
  act(table, 'raise', 200);
  act(table, 'call');
  assert.equal(table.playerToAct(), 3);
  assert(table.legalActions().actions.includes('raise'));
  assert.equal(table.legalActions().chipRange.min, 280);
  finish(table);
});

test('an all-in from an earlier street receives the main pot and later bets form a side pot', () => {
  const table = rigged([100, 300, 500], [['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']],
    ['Ac', '2d', '3h', '4s', '9c']);
  act(table, 'raise', 100);
  act(table, 'call');
  act(table, 'call');
  advance(table);
  assert.equal(table.roundOfBetting(), 'flop');
  assert.equal(table.playerToAct(), 1);
  assert(table.handPlayers()[0]);
  act(table, 'bet', 200);
  act(table, 'call');
  advance(table);
  assert.deepEqual(table.pots(), [
    { size: 300, eligiblePlayers: [0, 1, 2] }, { size: 400, eligiblePlayers: [1, 2] },
  ]);
  finish(table);
  assert.deepEqual(stacks(table, 3), [300, 400, 200]);
});

test('folded contributions are allocated by their own contribution levels', () => {
  const table = rigged([1000, 60, 1000, 1000], [['Kh', 'Kd'], ['Ah', 'Ad'], ['Qh', 'Qd'], ['Jh', 'Jd']],
    ['2c', '3d', '4h', '8s', '9c']);
  act(table, 'raise', 100);
  act(table, 'call');
  act(table, 'call');
  act(table, 'raise', 300);
  act(table, 'fold');
  act(table, 'call');
  advance(table);
  assert.deepEqual(table.pots(), [
    { size: 240, eligiblePlayers: [0, 1, 2] }, { size: 520, eligiblePlayers: [0, 2] },
  ]);
  finish(table);
  assert.deepEqual(stacks(table, 4), [1220, 240, 700, 900]);
});

test('heads-up button posts small blind and acts first preflop, last after flop', () => {
  const table = rigged([1000, 1000], [['Ah', 'Ad'], ['Kh', 'Kd']], ['2c', '3d', '4h', '8s', '9c']);
  assert.equal(table.playerToAct(), 0);
  assert.equal(table.seats()[0].betSize, 10);
  act(table, 'call');
  assert.equal(table.playerToAct(), 1);
  act(table, 'check');
  advance(table);
  assert.equal(table.playerToAct(), 1);
  finish(table);
});

test('a short all-in blind gets no extra turn and uncalled blind chips return', () => {
  const table = rigged([1000, 5], [['Ah', 'Ad'], ['Kh', 'Kd']], ['2c', '3d', '4h', '8s', '9c']);
  assert.equal(table.isBettingRoundInProgress(), false);
  finish(table);
  assert.deepEqual(stacks(table, 2), [1005, 0]);
});

test('illegal check and noninteger raises cannot move chips', () => {
  const table = rigged([1000, 1000], [['Ah', 'Ad'], ['Kh', 'Kd']], ['2c', '3d', '4h', '8s', '9c']);
  const before = table.seats();
  assert.throws(() => table.actionTaken('check'));
  assert.throws(() => table.actionTaken('raise', 40.5));
  assert.throws(() => table.actionTaken('raise', Infinity));
  assert.deepEqual(table.seats(), before);
  conserve(table);
  finish(table);
});

test('mixed short stacks and legal random actions always finish without losing chips', () => {
  let seed = 786521;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let hand = 0; hand < 1000; hand += 1) {
    const count = 2 + random(5);
    const table = createTable({ smallBlind: 10, bigBlind: 20 }, 6);
    table.initialTotal = 0;
    for (let seat = 0; seat < count; seat += 1) {
      const stack = 1 + random(400);
      table.initialTotal += stack;
      table.sitDown(seat, stack);
    }
    table.startHand(random(count));
    conserve(table);
    let guard = 0;
    while (table.isHandInProgress()) {
      assert(++guard < 200, `Hand ${hand} must finish`);
      if (table.areBettingRoundsCompleted()) {
        table.showdown();
        conserve(table);
      } else if (table.isBettingRoundInProgress()) {
        const { actions, chipRange } = table.legalActions();
        const action = actions[random(actions.length)];
        act(table, action, chipRange ? (random(2) ? chipRange.min : chipRange.max) : undefined);
      } else advance(table);
    }
  }
});
