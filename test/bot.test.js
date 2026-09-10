import assert from 'node:assert/strict';
import test from 'node:test';
import { decideBotAction, normalizeDifficulty, BOT_DIFFICULTIES } from '../src/bot.js';

const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const cards = (text) => text.split(' ').map((code) => ({ rank: code[0], suit: suits[code[1]] }));

// 固定 rng：按序返回值，取完后停在最后一个（方便"随便什么随机数都行"的场景）。
function rngSeq(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

const legal = (overrides = {}) => ({
  actions: ['check', 'bet'],
  minRaise: 20,
  maxRaise: 2000,
  callAmount: 0,
  canAllIn: true,
  ...overrides,
});

function state(overrides = {}) {
  return {
    difficulty: 'normal',
    holeCards: cards('As Kd'),
    communityCards: [],
    legal: legal(),
    stack: 2000,
    pot: 100,
    bigBlind: 20,
    position: 2,
    playersInHand: 3,
    ...overrides,
  };
}

test('normalizeDifficulty falls back to normal for missing or invalid values', () => {
  assert.equal(normalizeDifficulty('easy'), 'easy');
  assert.equal(normalizeDifficulty('normal'), 'normal');
  assert.equal(normalizeDifficulty('hard'), 'hard');
  assert.equal(normalizeDifficulty(undefined), 'normal');
  assert.equal(normalizeDifficulty('insane'), 'normal');
  assert.deepEqual([...BOT_DIFFICULTIES], ['easy', 'normal', 'hard']);
});

test('preflop: easy raises strong hands at 24%, normal drops to 18%', () => {
  const strong = state({ holeCards: cards('As Ah'), legal: legal({ actions: ['call', 'raise'], callAmount: 20 }) });
  // rng=23：easy 加注（<24），normal 不加注（>=18）→ 跟注。
  assert.deepEqual(decideBotAction({ ...strong, difficulty: 'easy' }, rngSeq(23)), { action: 'raise', amount: 60 });
  assert.deepEqual(decideBotAction({ ...strong, difficulty: 'normal' }, rngSeq(23)), { action: 'call' });
  // rng=10：两档都加注。
  for (const difficulty of ['easy', 'normal', 'hard']) {
    assert.equal(decideBotAction({ ...strong, difficulty }, rngSeq(10)).action, 'raise');
  }
});

test('postflop set: easy only checks/calls, normal and hard value bet', () => {
  // 翻牌中三条：Jd Jh + Jc 8s 2d。
  const setup = (difficulty) => state({
    difficulty,
    holeCards: cards('Jd Jh'),
    communityCards: cards('Jc 8s 2d'),
    legal: legal({ actions: ['check', 'bet'] }),
  });
  // 无人下注：easy 沿用底牌逻辑（JJ 是对子 → 强牌加注 3BB！）。
  // easy 的旧逻辑翻牌后同样会加注，但它不看公共牌——用弱底牌中三条来体现差异。
  const weakHoleSet = (difficulty) => state({
    difficulty,
    holeCards: cards('7d 2h'),
    communityCards: cards('2c 2s 9d'), // 中三条，但底牌本身是弱牌
    legal: legal({ actions: ['check', 'bet'] }),
  });
  const easy = decideBotAction(weakHoleSet('easy'), rngSeq(99));
  assert.ok(['check', 'call'].includes(easy.action), `easy must not value bet, got ${easy.action}`);
  for (const difficulty of ['normal', 'hard']) {
    const bet = decideBotAction(weakHoleSet(difficulty), rngSeq(0));
    assert.equal(bet.action, 'bet', `${difficulty} must value bet a set`);
    assert.ok(bet.amount >= 20 && bet.amount <= 2000);
  }
});

test('weak hand facing a big bet: easy calls 65% of the time, hard folds by pot odds', () => {
  // 翻牌后弱牌（A 高），面对 300 的下注，底池 100。
  const facing = (difficulty) => state({
    difficulty,
    holeCards: cards('Ah 7d'),
    communityCards: cards('2c 9s Kd'),
    legal: legal({ actions: ['fold', 'call', 'raise'], callAmount: 300, minRaise: 620, maxRaise: 2000 }),
    pot: 100,
  });
  // easy：底牌 A7 牌面和 21 非强牌，callAmount 300 > 3BB=60，300 >= stack/4=500 不成立 →
  // 第三个条件 callAmount < stack/4（500）成立且 rng=40 < 65 → 跟注。
  assert.deepEqual(decideBotAction(facing('easy'), rngSeq(40)), { action: 'call' });
  assert.deepEqual(decideBotAction(facing('easy'), rngSeq(80)), { action: 'fold' });
  // hard：弱牌面对下注，赔率 300/400 = 75% 远超 1/4，且 rng=99 不在 12% bluff 内 → 弃牌。
  const hard = decideBotAction(facing('hard'), rngSeq(99, 99));
  assert.equal(hard.action, 'fold');
  // hard：听牌（这里不是听牌）bluff 优先听牌——弱牌直接 bluff 分支也是 12%。
  const hardBluff = decideBotAction(facing('hard'), rngSeq(5));
  assert.equal(hardBluff.action, 'raise');
});

test('flush draw: hard semi-bluffs at 12%, normal mostly gives up', () => {
  // 同花听：As Ks + Qs 7s 2d。
  const facing = (difficulty) => state({
    difficulty,
    holeCards: cards('As Ks'),
    communityCards: cards('Qs 7s 2d'),
    legal: legal({ actions: ['fold', 'call', 'raise'], callAmount: 200, minRaise: 440, maxRaise: 2000 }),
    pot: 300,
  });
  // normal：听牌按中等处理，跟注门槛 callAmount ≤ pot/3 = 100，200 > 100 → 不跟；
  // rng=50 不在 8% bluff 内 → 弃牌。
  assert.equal(decideBotAction(facing('normal'), rngSeq(50, 50)).action, 'fold');
  // normal：rng=3 落在 8% bluff 内 → 加注半池。
  const normalBluff = decideBotAction(facing('normal'), rngSeq(3));
  assert.equal(normalBluff.action, 'raise');
  // hard：rng=5 落在 12% 内且优先听牌半 bluff → 加注。
  const hardBluff = decideBotAction(facing('hard'), rngSeq(5));
  assert.equal(hardBluff.action, 'raise');
  // hard：rng=50 不 bluff；赔率 200/500 = 40% > 听牌门槛 1/3 → 弃牌。
  assert.equal(decideBotAction(facing('hard'), rngSeq(50, 50)).action, 'fold');
  // hard：听牌赔率合适时（callAmount=100，pot=300 → 25% ≤ 1/3）跟注。
  const cheap = state({
    difficulty: 'hard',
    holeCards: cards('As Ks'),
    communityCards: cards('Qs 7s 2d'),
    legal: legal({ actions: ['fold', 'call', 'raise'], callAmount: 100, minRaise: 220, maxRaise: 2000 }),
    pot: 300,
  });
  assert.equal(decideBotAction(cheap, rngSeq(50, 50)).action, 'call');
});

test('hard steals from late position with two high cards, normal does not', () => {
  // 两张高牌但非强牌（JT 牌面和 22 < 24），无人加注，按钮位。
  const stealSpot = (difficulty) => state({
    difficulty,
    holeCards: cards('Jd Tc'),
    communityCards: [],
    legal: legal({ actions: ['call', 'raise'], callAmount: 20 }),
    position: 0,
  });
  // normal：JT 非强牌，callAmount=20 ≤ 3BB=60 → 跟注。
  assert.deepEqual(decideBotAction(stealSpot('normal'), rngSeq(5)), { action: 'call' });
  // hard：rng=5 < 30 偷盲 → 加注；rng=40 → 落入 callAmount ≤ 3BB 跟注。
  assert.equal(decideBotAction(stealSpot('hard'), rngSeq(5)).action, 'raise');
  assert.deepEqual(decideBotAction(stealSpot('hard'), rngSeq(40)), { action: 'call' });
});

test('hard keeps firing on turn and river with strong hands', () => {
  const turnStrong = (difficulty) => state({
    difficulty,
    holeCards: cards('Qd Qh'),
    communityCards: cards('Qc 7s 2d 9h'), // 转牌三条
    legal: legal({ actions: ['check', 'bet'] }),
    pot: 400,
  });
  // normal：70% 价值下注，rng=80 → 过牌。
  assert.equal(decideBotAction(turnStrong('normal'), rngSeq(80)).action, 'check');
  // hard：转牌连续开火拉高到 90%，rng=80 → 仍下注，且 3/4 底池。
  const fired = decideBotAction(turnStrong('hard'), rngSeq(80));
  assert.equal(fired.action, 'bet');
  assert.equal(fired.amount, 300); // callAmount 0 + 400 * 0.75
});

test('every decision is legal across randomized spots', () => {
  const RANKS = '23456789TJQKA';
  const SUIT_LIST = ['clubs', 'diamonds', 'hearts', 'spades'];
  let seed = 42;
  const next = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
  const drawCards = () => Array.from({ length: 2 + [0, 3, 4, 5][next(4)] }, () => ({
    rank: RANKS[next(13)], suit: SUIT_LIST[next(4)],
  }));
  const actionSets = [
    { actions: ['check', 'bet'], callAmount: 0 },
    { actions: ['fold', 'call', 'raise'], callAmount: 40 },
    { actions: ['check'], callAmount: 0 },
    { actions: ['fold', 'call'], callAmount: 2000 },
    { actions: ['fold', 'call', 'raise'], callAmount: 0 },
  ];
  for (let round = 0; round < 3000; round += 1) {
    const difficulty = BOT_DIFFICULTIES[next(3)];
    const holeCards = drawCards();
    const communityCards = drawCards().slice(2);
    const base = actionSets[next(actionSets.length)];
    const current = state({
      difficulty,
      holeCards,
      communityCards,
      legal: legal({ ...base, minRaise: base.actions.includes('check') && base.callAmount === 0 ? 20 : 240, maxRaise: 2000 }),
      stack: [0, 500, 2000][next(3)],
      pot: [0, 60, 400, 5000][next(4)],
      position: next(6),
      playersInHand: 2 + next(5),
    });
    const decision = decideBotAction(current, () => next(100));
    assert.ok(['check', 'call', 'fold', 'bet', 'raise'].includes(decision.action), `${difficulty} illegal action ${decision.action}`);
    assert.ok(current.legal.actions.includes(decision.action), `${difficulty} ${decision.action} not in ${current.legal.actions}`);
    if (decision.action === 'bet' || decision.action === 'raise') {
      assert.ok(Number.isInteger(decision.amount), 'amount must be integer');
      assert.ok(decision.amount >= current.legal.minRaise && decision.amount <= current.legal.maxRaise,
        `amount ${decision.amount} outside ${current.legal.minRaise}~${current.legal.maxRaise}`);
    }
  }
});

test('malformed state never throws and falls back safely', () => {
  assert.deepEqual(decideBotAction(null), { action: 'fold' });
  assert.deepEqual(decideBotAction({ legal: null }), { action: 'fold' });
  assert.deepEqual(decideBotAction({ legal: { actions: [] } }), { action: 'fold' });
  // 决策金额非法时夹取到合法区间。
  const clamped = decideBotAction(state({
    holeCards: cards('As Ah'),
    legal: legal({ actions: ['call', 'raise'], callAmount: 20, minRaise: 20, maxRaise: 40 }),
  }), rngSeq(0));
  assert.ok(clamped.amount >= 20 && clamped.amount <= 40, JSON.stringify(clamped));
});
