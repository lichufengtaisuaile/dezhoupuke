import { randomInt, randomUUID } from 'node:crypto';
import { GameError } from './errors.js';

const RANKS = '23456789TJQKA';
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];

export const ZJH_RULES = Object.freeze({
  minPlayers: 2,
  maxPlayers: 8,
  maxBettingRounds: 20,
  seenMultiplier: 2,
  twoThreeFiveBeatsTripsDefault: true,
  handOrder: ['单张', '对子', '顺子', '金花', '同花顺', '豹子'],
});

function fail(message) {
  throw new GameError(message);
}

function requireThat(condition, message) {
  if (!condition) fail(message);
}

function clone(value) {
  return structuredClone(value);
}

function chips(value, label = '筹码') {
  requireThat(Number.isSafeInteger(value) && value >= 0, `${label}不正确`);
  return value;
}

function cardRank(card) {
  const rank = RANKS.indexOf(card?.rank);
  requireThat(rank >= 0 && SUITS.includes(card?.suit), '牌面数据不正确');
  return rank + 2;
}

function cardKey(card) {
  return `${card.rank}-${card.suit}`;
}

function shuffledDeck() {
  const deck = SUITS.flatMap(suit => [...RANKS].map(rank => ({ rank, suit })));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

function straightHigh(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length !== 3) return 0;
  if (sorted[0] === 2 && sorted[1] === 3 && sorted[2] === 14) return 3;
  return sorted[2] - sorted[0] === 2 ? sorted[2] : 0;
}

export function evaluateZjhHand(cards) {
  requireThat(Array.isArray(cards) && cards.length === 3, '炸金花手牌必须为三张');
  requireThat(new Set(cards.map(cardKey)).size === 3, '炸金花手牌不能重复');
  const values = cards.map(cardRank);
  const descending = [...values].sort((a, b) => b - a);
  const counts = new Map(values.map(value => [value, values.filter(item => item === value).length]));
  const flush = new Set(cards.map(card => card.suit)).size === 1;
  const high = straightHigh(values);
  const trips = counts.size === 1;
  const pair = [...counts.entries()].find(([, count]) => count === 2);
  const special235 = !flush && [...values].sort((a, b) => a - b).join(',') === '2,3,5';

  if (trips) return { category: 5, name: '豹子', tiebreak: [descending[0]], special235: false };
  if (flush && high) return { category: 4, name: '同花顺', tiebreak: [high], special235: false };
  if (flush) return { category: 3, name: '金花', tiebreak: descending, special235: false };
  if (high) return { category: 2, name: '顺子', tiebreak: [high], special235: false };
  if (pair) {
    const kicker = values.find(value => value !== pair[0]);
    return { category: 1, name: '对子', tiebreak: [pair[0], kicker], special235: false };
  }
  return { category: 0, name: '单张', tiebreak: descending, special235 };
}

function compareVector(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0) ? 1 : -1;
  }
  return 0;
}

export function compareZjhHands(leftCards, rightCards, { twoThreeFiveBeatsTrips = true } = {}) {
  const left = evaluateZjhHand(leftCards);
  const right = evaluateZjhHand(rightCards);
  if (twoThreeFiveBeatsTrips) {
    if (left.special235 && right.category === 5) return 1;
    if (right.special235 && left.category === 5) return -1;
  }
  if (left.category !== right.category) return left.category > right.category ? 1 : -1;
  return compareVector(left.tiebreak, right.tiebreak);
}

function playerAt(state, seat) {
  return state.players.find(player => player.seat === seat);
}

function activePlayers(state) {
  return state.players.filter(player => !player.folded);
}

function nextActiveSeat(state, fromSeat) {
  const seats = activePlayers(state).map(player => player.seat).sort((a, b) => a - b);
  if (!seats.length) return null;
  return seats.find(seat => seat > fromSeat) ?? seats[0];
}

function finishRound(state, winner, reason, publicRevealSeats = []) {
  const award = state.pot;
  winner.stack += award;
  state.finalPot = award;
  state.pot = 0;
  state.phase = 'finished';
  state.turnSeat = null;
  state.finishedAt = Date.now();
  state.endReason = reason;
  state.publicRevealSeats = [...new Set(publicRevealSeats)];
  state.result = {
    winnerSeat: winner.seat,
    winnerName: winner.name,
    amount: award,
    reason,
    hand: state.publicRevealSeats.includes(winner.seat) ? evaluateZjhHand(winner.cards) : null,
  };
  for (const player of state.players) player.net = player.stack - player.startStack;
}

function advance(state, actingSeat) {
  const remaining = activePlayers(state);
  if (remaining.length === 1) {
    finishRound(state, remaining[0], '其余玩家已退出');
    return;
  }
  state.actedSeats = [...new Set([...(state.actedSeats ?? []), actingSeat])]
    .filter(seat => remaining.some(player => player.seat === seat));
  if (remaining.every(player => state.actedSeats.includes(player.seat))) {
    state.bettingRound += 1;
    state.actedSeats = [];
  }
  state.turnSeat = nextActiveSeat(state, actingSeat);
  state.turnId += 1;
}

function actionCost(state, player) {
  return state.currentBet * (player.seen ? ZJH_RULES.seenMultiplier : 1);
}

export function legalZjhActions(state, seat) {
  const legal = { actions: [], callAmount: 0, raiseMin: null, raiseMax: null, compareSeats: [] };
  if (!state || state.phase !== 'playing' || state.turnSeat !== seat) return legal;
  const player = playerAt(state, seat);
  if (!player || player.folded) return legal;
  if (!player.seen) legal.actions.push('peek');
  legal.actions.push('fold');
  const cost = actionCost(state, player);
  legal.callAmount = cost;
  legal.compareSeats = activePlayers(state).filter(entry => entry.seat !== seat).map(entry => entry.seat);
  if (legal.compareSeats.length && player.stack >= cost) legal.actions.push('compare');
  if (state.bettingRound <= ZJH_RULES.maxBettingRounds && player.stack >= cost) {
    legal.actions.push('call');
    const multiplier = player.seen ? ZJH_RULES.seenMultiplier : 1;
    const affordableBase = Math.floor(player.stack / multiplier / state.minBet) * state.minBet;
    const raiseMin = state.currentBet + state.minBet;
    if (affordableBase >= raiseMin) {
      legal.actions.push('raise');
      legal.raiseMin = raiseMin;
      legal.raiseMax = affordableBase;
    }
  }
  return legal;
}

export function createZjhRound({
  players,
  minBet,
  dealerSeat = 0,
  twoThreeFiveBeatsTrips = true,
  roundId = randomUUID(),
  deck = shuffledDeck(),
}) {
  requireThat(Array.isArray(players) && players.length >= ZJH_RULES.minPlayers && players.length <= ZJH_RULES.maxPlayers,
    '炸金花需要 2–8 位玩家');
  chips(minBet, '最小下注');
  requireThat(minBet > 0, '最小下注需要大于零');
  const seats = new Set();
  const accounts = new Set();
  for (const player of players) {
    requireThat(Number.isInteger(player.seat) && player.seat >= 0 && player.seat < ZJH_RULES.maxPlayers && !seats.has(player.seat),
      '炸金花座位不正确');
    requireThat(typeof player.id === 'string' && player.id, '炸金花玩家标识不正确');
    requireThat(typeof player.accountId === 'string' && player.accountId && !accounts.has(player.accountId), '炸金花玩家账号不正确');
    chips(player.stack);
    requireThat(player.stack >= minBet, '筹码不足以支付底注');
    seats.add(player.seat);
    accounts.add(player.accountId);
  }
  requireThat(seats.has(dealerSeat), '庄家座位不在本局中');
  requireThat(Array.isArray(deck) && deck.length >= players.length * 3, '牌堆数量不足');
  const needed = deck.slice(0, players.length * 3);
  requireThat(new Set(needed.map(cardKey)).size === needed.length, '牌堆中存在重复牌');

  const roundPlayers = players.map(player => ({
    id: player.id,
    accountId: player.accountId,
    name: player.name,
    seat: player.seat,
    startStack: player.stack,
    stack: player.stack - minBet,
    contribution: minBet,
    cards: [],
    seen: false,
    folded: false,
    comparedOut: false,
    lastAction: '底注',
    net: -minBet,
  }));
  let cardIndex = 0;
  for (let card = 0; card < 3; card += 1) {
    for (const player of roundPlayers) player.cards.push(clone(needed[cardIndex++]));
  }
  const state = {
    id: String(roundId),
    phase: 'playing',
    minBet,
    currentBet: minBet,
    pot: minBet * players.length,
    finalPot: null,
    dealerSeat,
    turnSeat: null,
    turnId: 1,
    bettingRound: 1,
    actedSeats: [],
    twoThreeFiveBeatsTrips: Boolean(twoThreeFiveBeatsTrips),
    players: roundPlayers,
    comparisons: [],
    publicRevealSeats: [],
    result: null,
    endReason: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  state.turnSeat = nextActiveSeat(state, dealerSeat);
  return state;
}

export function applyZjhAction(input, seat, move) {
  const state = clone(input);
  const legal = legalZjhActions(state, seat);
  requireThat(move && typeof move.action === 'string' && legal.actions.includes(move.action), '当前不能执行这个操作');
  const player = playerAt(state, seat);

  if (move.action === 'peek') {
    player.seen = true;
    player.lastAction = '已看牌';
    state.turnId += 1;
    return state;
  }

  if (move.action === 'fold') {
    player.folded = true;
    player.lastAction = '弃牌';
    advance(state, seat);
    return state;
  }

  if (move.action === 'call') {
    const amount = actionCost(state, player);
    player.stack -= amount;
    player.contribution += amount;
    player.lastAction = player.seen ? `明跟 ${amount}` : `暗跟 ${amount}`;
    state.pot += amount;
    advance(state, seat);
    return state;
  }

  if (move.action === 'raise') {
    requireThat(Number.isSafeInteger(move.bet) && move.bet >= legal.raiseMin && move.bet <= legal.raiseMax
      && move.bet % state.minBet === 0, `加注需为最小下注 ${state.minBet} 的整数倍`);
    const amount = move.bet * (player.seen ? ZJH_RULES.seenMultiplier : 1);
    player.stack -= amount;
    player.contribution += amount;
    player.lastAction = player.seen ? `明加 ${amount}` : `暗加 ${amount}`;
    state.currentBet = move.bet;
    state.pot += amount;
    advance(state, seat);
    return state;
  }

  const targetSeat = Number(move.targetSeat);
  requireThat(legal.compareSeats.includes(targetSeat), '请选择仍在牌局中的玩家比牌');
  const target = playerAt(state, targetSeat);
  const amount = actionCost(state, player);
  player.stack -= amount;
  player.contribution += amount;
  state.pot += amount;
  const comparison = compareZjhHands(player.cards, target.cards, {
    twoThreeFiveBeatsTrips: state.twoThreeFiveBeatsTrips,
  });
  const loser = comparison > 0 ? target : player;
  loser.folded = true;
  loser.comparedOut = true;
  player.lastAction = `与 ${target.name} 比牌`;
  target.lastAction = target === loser ? '比牌落败' : '比牌胜出';
  state.comparisons.push({
    id: `${state.id}:${state.turnId}`,
    actorSeat: seat,
    targetSeat,
    loserSeat: loser.seat,
    amount,
  });
  const remaining = activePlayers(state);
  if (remaining.length === 1) {
    finishRound(state, remaining[0], '比牌获胜', [seat, targetSeat]);
  } else {
    advance(state, seat);
  }
  return state;
}

export function automaticZjhAction(state, seat) {
  const legal = legalZjhActions(state, seat);
  if (!legal.actions.length) return null;
  return { action: 'fold' };
}

export function snapshotZjh(state, viewerSeat) {
  const own = playerAt(state, viewerSeat);
  const legal = legalZjhActions(state, viewerSeat);
  return {
    id: state.id,
    phase: state.phase,
    minBet: state.minBet,
    currentBet: state.currentBet,
    pot: state.pot,
    finalPot: state.finalPot,
    dealerSeat: state.dealerSeat,
    turnSeat: state.turnSeat,
    turnId: state.turnId,
    bettingRound: state.bettingRound,
    maxBettingRounds: ZJH_RULES.maxBettingRounds,
    twoThreeFiveBeatsTrips: state.twoThreeFiveBeatsTrips,
    result: clone(state.result),
    endReason: state.endReason,
    comparisons: clone(state.comparisons),
    legal,
    players: state.players.map(player => {
      const visibleToSelf = player.seat === viewerSeat && (player.seen || state.phase === 'finished');
      const visible = visibleToSelf || state.publicRevealSeats.includes(player.seat);
      return {
        id: player.id,
        name: player.name,
        seat: player.seat,
        stack: player.stack,
        contribution: player.contribution,
        seen: player.seen,
        folded: player.folded,
        comparedOut: player.comparedOut,
        lastAction: player.lastAction,
        net: state.phase === 'finished' ? player.net : undefined,
        cards: visible ? clone(player.cards) : undefined,
        hand: visible && (player.seen || state.phase === 'finished') ? evaluateZjhHand(player.cards) : undefined,
      };
    }),
    selfHand: own?.seen ? evaluateZjhHand(own.cards) : null,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}
