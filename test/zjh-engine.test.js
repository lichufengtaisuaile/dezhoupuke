import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyZjhAction,
  compareZjhHands,
  createZjhRound,
  evaluateZjhHand,
  legalZjhActions,
  snapshotZjh,
  ZJH_RULES,
} from '../src/zjh-engine.js';

const c = (rank, suit = 'clubs') => ({ rank, suit });
const hands = {
  trips: [c('A'), c('A', 'diamonds'), c('A', 'hearts')],
  straightFlush: [c('Q', 'hearts'), c('K', 'hearts'), c('A', 'hearts')],
  flush: [c('A', 'spades'), c('9', 'spades'), c('3', 'spades')],
  straight: [c('4'), c('5', 'diamonds'), c('6', 'hearts')],
  wheel: [c('A'), c('2', 'diamonds'), c('3', 'hearts')],
  pair: [c('K'), c('K', 'diamonds'), c('8', 'hearts')],
  high: [c('A'), c('J', 'diamonds'), c('8', 'hearts')],
  special235: [c('2'), c('3', 'diamonds'), c('5', 'hearts')],
};
const distinctThreeHands = [
  [c('A'), c('J', 'diamonds'), c('8', 'hearts')],
  [c('K'), c('K', 'diamonds'), c('7', 'spades')],
  [c('Q', 'spades'), c('9', 'spades'), c('4', 'spades')],
];

function players(count = 3, stack = 1000) {
  return Array.from({ length: count }, (_, seat) => ({
    id: `player-${seat}`,
    accountId: `account-${seat}`,
    name: `玩家${seat}`,
    seat,
    stack,
  }));
}

function deckWith(firstHands) {
  const dealt = [];
  for (let index = 0; index < 3; index += 1) {
    for (const hand of firstHands) dealt.push(hand[index]);
  }
  return dealt;
}

test('炸金花牌型顺序、A23 小顺与同类踢脚比较正确', () => {
  const ordered = ['high', 'pair', 'straight', 'flush', 'straightFlush', 'trips'];
  assert.deepEqual(ordered.map(name => evaluateZjhHand(hands[name]).name), ZJH_RULES.handOrder);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareZjhHands(hands[ordered[index]], hands[ordered[index - 1]]), 1);
  }
  assert.equal(evaluateZjhHand(hands.wheel).name, '顺子');
  assert.equal(compareZjhHands(hands.straight, hands.wheel), 1);
  assert.equal(compareZjhHands([c('A'), c('J', 'diamonds'), c('9', 'hearts')], hands.high), 1);
});

test('杂色 235 默认只吃豹子，关闭后按普通单张计算', () => {
  assert.equal(evaluateZjhHand(hands.special235).special235, true);
  assert.equal(compareZjhHands(hands.special235, hands.trips), 1);
  assert.equal(compareZjhHands(hands.special235, hands.trips, { twoThreeFiveBeatsTrips: false }), -1);
  assert.equal(compareZjhHands(hands.special235, hands.pair), -1);
  assert.equal(compareZjhHands([c('2', 'spades'), c('3', 'spades'), c('5', 'spades')], hands.trips), -1);
});

test('开局收取底注、轮庄发牌并保持筹码守恒', () => {
  const tablePlayers = players(3);
  const round = createZjhRound({
    players: tablePlayers,
    minBet: 10,
    dealerSeat: 1,
    deck: deckWith(distinctThreeHands),
  });
  assert.equal(round.turnSeat, 2);
  assert.equal(round.pot, 30);
  assert.deepEqual(round.players.map(player => player.stack), [990, 990, 990]);
  assert.equal(round.players.reduce((sum, player) => sum + player.stack, 0) + round.pot, 3000);
  assert.deepEqual(round.players[0].cards, distinctThreeHands[0]);
});

test('看牌不换操作人，明牌跟注为暗牌两倍，加注按底注步长', () => {
  let round = createZjhRound({ players: players(3), minBet: 10, dealerSeat: 2,
    deck: deckWith(distinctThreeHands) });
  assert.equal(round.turnSeat, 0);
  round = applyZjhAction(round, 0, { action: 'peek' });
  assert.equal(round.turnSeat, 0);
  assert.equal(legalZjhActions(round, 0).callAmount, 20);
  round = applyZjhAction(round, 0, { action: 'call' });
  assert.equal(round.players[0].stack, 970);
  round = applyZjhAction(round, 1, { action: 'raise', bet: 20 });
  assert.equal(round.currentBet, 20);
  assert.equal(round.players[1].stack, 970);
  assert.throws(() => applyZjhAction(round, 2, { action: 'raise', bet: 25 }), /整数倍/);
  assert.equal(round.players.reduce((sum, player) => sum + player.stack, 0) + round.pot, 3000);
});

test('主动比牌支付当前费用，同牌由发起者输，最后赢家获得完整底池', () => {
  const tied = [c('A'), c('J', 'diamonds'), c('8', 'hearts')];
  let round = createZjhRound({ players: players(2), minBet: 10, dealerSeat: 1, deck: deckWith([tied, tied.map((card, i) => ({ ...card, suit: ['spades', 'clubs', 'diamonds'][i] }))]) });
  round = applyZjhAction(round, 0, { action: 'compare', targetSeat: 1 });
  assert.equal(round.phase, 'finished');
  assert.equal(round.result.winnerSeat, 1);
  assert.equal(round.finalPot, 30);
  assert.equal(round.players[0].stack, 980);
  assert.equal(round.players[1].stack, 1020);
  assert.equal(round.players.reduce((sum, player) => sum + player.stack, 0), 2000);
});

test('暗牌阶段不向浏览器下发牌面，看牌后仅自己可见，最终比牌才公开双方牌面', () => {
  let round = createZjhRound({ players: players(3), minBet: 10, dealerSeat: 2,
    deck: deckWith([
      [c('A'), c('A', 'diamonds'), c('A', 'hearts')],
      [c('K'), c('K', 'diamonds'), c('8', 'spades')],
      [c('Q'), c('J', 'diamonds'), c('7', 'hearts')],
    ]) });
  const privateView = snapshotZjh(round, 0);
  assert.equal(privateView.players[0].cards, undefined);
  assert.equal(privateView.players[1].cards, undefined);
  round = applyZjhAction(round, 0, { action: 'peek' });
  assert.equal(snapshotZjh(round, 0).players[0].cards.length, 3);
  assert.equal(snapshotZjh(round, 1).players[0].cards, undefined);
  round = applyZjhAction(round, 0, { action: 'compare', targetSeat: 1 });
  assert.equal(snapshotZjh(round, 2).players[0].cards, undefined);
  round = applyZjhAction(round, 2, { action: 'fold' });
  assert.equal(round.phase, 'finished');
  assert.equal(snapshotZjh(round, 2).players[2].cards.length, 3);
});

test('超过固定轮数后只能弃牌或比牌，避免无限跟注', () => {
  const round = createZjhRound({ players: players(2), minBet: 10, dealerSeat: 1,
    deck: deckWith(distinctThreeHands.slice(0, 2)) });
  round.bettingRound = ZJH_RULES.maxBettingRounds + 1;
  assert.deepEqual(legalZjhActions(round, 0).actions.sort(), ['compare', 'fold', 'peek']);
});
