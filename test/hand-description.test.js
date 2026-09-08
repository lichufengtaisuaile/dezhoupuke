import assert from 'node:assert/strict';
import test from 'node:test';
import { describeHand } from '../hand-description.js';

const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const cards = text => text.split(' ').map(code => ({ rank: code[0], suit: suits[code[1]] }));
const describe = (hole, board = '') => describeHand(cards(hole), board ? cards(board) : []);
const ranks = hand => hand.cards.map(card => card.rank).join('');

test('two starting cards describe only a pair or high card', () => {
  assert.deepEqual(describe('Ah Ad'), {
    name: '一对', detail: 'A 一对', cards: cards('Ah Ad'), complete: false,
  });
  assert.equal(describe('As Ks').name, '高牌');
  assert.equal(describe('As Ks').detail, 'A 高牌 · K');
  assert.equal(describe('8s 9s').name, '高牌');
  assert.equal(describeHand(null), null);
  assert.equal(describeHand([]), null);
});

const examples = [
  ['Ah 8c', 'Kd Qs 9c 5s 2h', '高牌', 'A 高牌 · K、Q、9、8', 'AKQ98'],
  ['Ah Ac', 'Kd Qs 9c 5s 2h', '一对', 'A 一对 · K、Q、9 踢脚牌', 'AAKQ9'],
  ['Ah Kc', 'Ad Ks Qc 5s 2h', '两对', 'A 和 K 两对 · Q 踢脚牌', 'AAKKQ'],
  ['Qh Qc', 'Qd As 9c 5s 2h', '三条', 'Q 三条 · A、9 踢脚牌', 'QQQA9'],
  ['8h 9c', 'Td Js Qc 5s 2h', '顺子', 'Q 高顺子', 'QJT98'],
  ['Ah 9h', 'Kh 7h 3h Qs 2c', '同花', '红桃同花 · A、K、9、7、3', 'AK973'],
  ['Ah Ac', 'Ad Ks Kc 5s 2h', '葫芦', 'A 三条带 K 一对', 'AAAKK'],
  ['Qh Qc', 'Qd Qs Ac 5s 2h', '四条', 'Q 四条 · A 踢脚牌', 'QQQQA'],
  ['8h 9h', 'Th Jh Qh 5s 2c', '同花顺', '红桃 Q 高同花顺', 'QJT98'],
  ['Ah Kh', 'Qh Jh Th 5s 2c', '皇家同花顺', '红桃 10、J、Q、K、A', 'AKQJT'],
];
for (const [hole, board, name, detail, expectedRanks] of examples) {
  test(`describes ${name} with the winning ranks and best five cards`, () => {
    const result = describe(hole, board);
    assert.equal(result.name, name);
    assert.equal(result.detail, detail);
    assert.equal(result.complete, true);
    assert.equal(result.cards.length, 5);
    assert.equal(ranks(result), expectedRanks);
    const available = [...cards(hole), ...cards(board)];
    for (const card of result.cards) assert.ok(available.some(candidate => candidate.rank === card.rank && candidate.suit === card.suit));
  });
}

test('wheel straights keep the actual ace and identify five as the high card', () => {
  const straight = describe('Ac 2s', '3h 4d 5c Qs Kh');
  assert.equal(straight.detail, '5 高顺子');
  assert.equal(ranks(straight), '5432A');
  assert.deepEqual(straight.cards[4], cards('Ac')[0]);
  const flush = describe('Ac 2c', '3c 4c 5c Qs Kh');
  assert.equal(flush.detail, '梅花 5 高同花顺');
  assert.equal(ranks(flush), '5432A');
});

test('a shared best board produces equal descriptions regardless of hole cards', () => {
  const board = 'As Ks Qs Js Ts';
  const first = describe('2c 2d', board);
  const second = describe('Ah Ad', board);
  assert.deepEqual(first, second);
  assert.deepEqual(first.cards, cards(board));
});

test('uses the higher trips for a full house and the third pair only as a kicker', () => {
  assert.equal(describe('Ac Ad', 'Ah Ks Kc Kd 2s').detail, 'A 三条带 K 一对');
  assert.equal(describe('Ac Ad', 'Kh Ks Qh Qd 2s').detail, 'A 和 K 两对 · Q 踢脚牌');
});

test('flop and turn updates leave inputs unchanged and show complete best hands', () => {
  const hole = cards('Ah Ad');
  const board = cards('Kh Kd 2s');
  const before = structuredClone({ hole, board });
  assert.equal(describeHand(hole, board).name, '两对');
  assert.equal(describeHand(hole, [...board, ...cards('As')]).name, '葫芦');
  assert.deepEqual({ hole, board }, before);
});
