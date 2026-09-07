import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import poker from 'poker-ts';
import solver from 'pokersolver';

const { Table } = poker;
const { Hand } = solver;
const ranks = '23456789TJQKA';
const suits = ['clubs', 'diamonds', 'hearts', 'spades'];
const cardView = (card) => ({ rank: ranks[card.rank], suit: suits[card.suit] });
const cardCode = (card) => ranks[card.rank] + suits[card.suit][0];
const playerView = (player) => player && ({
  totalChips: player.totalChips(), stack: player.stack(), betSize: player.betSize(),
});

function secureShuffle(cards) {
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
}

function evaluate(cards) {
  const result = Hand.solve(cards.map(cardCode));
  const best = result.cards.slice(0, 5).map((card) => ({
    rank: card.value === '10' ? 'T' : card.value === '1' ? 'A' : card.value,
    suit: suits.find((suit) => suit[0] === card.suit),
  }));
  const ranking = result.name === 'Straight Flush' && result.descr === 'Royal Flush'
    ? 9 : result.rank - 1;
  const strength = result.cards.slice(0, 5).reduce((value, card) =>
    value * 15 + (card.value === '1' ? 0 : ranks.indexOf(card.value) + 2), 0);
  return { result, view: { cards: best, ranking, strength } };
}

// Keep the upstream dealing and betting machinery behind one version-pinned
// adapter. Its folded-pot accounting and hand evaluator are not settlement-safe.
export function createTable(forcedBets, numSeats = 6, { shuffle = secureShuffle } = {}) {
  assert(Number.isSafeInteger(forcedBets.bigBlind) && forcedBets.bigBlind > 0);
  assert(Number.isSafeInteger(forcedBets.smallBlind) && forcedBets.smallBlind > 0);
  assert(forcedBets.smallBlind <= forcedBets.bigBlind);
  assert(Number.isSafeInteger(numSeats) && numSeats >= 2 && numSeats <= 6);
  const facade = new Table(forcedBets, numSeats);
  const table = facade._table;
  table._deck.shuffle = () => shuffle(table._deck);
  const originalStart = facade.startHand.bind(facade);
  const originalEnd = facade.endBettingRound.bind(facade);
  const originalSit = facade.sitDown.bind(facade);
  const originalSeats = facade.seats.bind(facade);
  let participants = [];
  let initialStacks = [];
  let folded = new Set();
  let actedAt = new Map();
  let settledWinners = [];
  let lastRound = null;

  function contributionPots(includeBets = false) {
    const contributions = participants.map((player, seat) => player
      ? initialStacks[seat] - (includeBets ? player.stack() : player.totalChips()) : 0);
    const levels = [...new Set(contributions.filter((value) => value > 0))].sort((a, b) => a - b);
    let previous = 0;
    const pots = [];
    for (const level of levels) {
      const contributors = contributions.flatMap((amount, seat) => amount >= level ? [seat] : []);
      const eligiblePlayers = contributors.filter((seat) => !folded.has(seat));
      const size = (level - previous) * contributors.length;
      // Folded-only upper tiers remain dead money for the preceding live pot.
      const preceding = pots[pots.length - 1];
      if (preceding && (eligiblePlayers.length === 0 ||
          eligiblePlayers.join(',') === preceding.eligiblePlayers.join(','))) preceding.size += size;
      else pots.push({ size, eligiblePlayers });
      previous = level;
    }
    return pots;
  }

  function prepareRound() {
    const dealer = table._dealer;
    const betting = dealer._bettingRound;
    if (!betting || betting === lastRound) return;
    lastRound = betting;
    actedAt = new Map();
    const round = betting._round;
    const active = betting._players.map((player) => Boolean(player && player.stack() > 0));
    round._activePlayers = active;
    round._numActivePlayers = active.filter(Boolean).length;
    if (!round._numActivePlayers) {
      round._contested = false;
      return;
    }
    let first = round._playerToAct;
    while (!active[first]) first = (first + 1) % numSeats;
    round._playerToAct = first;
    round._lastAggressiveActor = first;
    round._firstAction = true;
    // With only one funded player, nobody can contest any extra wager.
    if (round._numActivePlayers === 1) {
      betting._biggestBet = Math.max(0, ...betting._players.map((player, seat) =>
        seat !== first && player ? player.betSize() : 0));
      round._contested = betting._players[first].betSize() < betting._biggestBet;
    }
  }

  facade.sitDown = (seat, buyIn) => {
    assert(!facade.isHandInProgress(), 'Seat changes wait until the hand finishes');
    assert(Number.isSafeInteger(seat) && seat >= 0 && seat < numSeats);
    assert(Number.isSafeInteger(buyIn) && buyIn > 0);
    originalSit(seat, buyIn);
    participants = [];
  };
  facade.startHand = (button) => {
    initialStacks = facade.seats().map((player) => player?.stack ?? 0);
    folded = new Set();
    settledWinners = [];
    lastRound = null;
    originalStart(button);
    participants = table._handPlayers.slice();
    const dealer = table._dealer;
    dealer._potManager = {
      betFolded() {},
      collectBetsForm(players) {
        for (const player of players) {
          if (player) player.takeFromBet(player.betSize());
        }
      },
      pots() {
        return contributionPots().map((pot) => ({
          size: () => pot.size, eligiblePlayers: () => pot.eligiblePlayers,
        }));
      },
    };
    prepareRound();
  };
  facade.handPlayers = () => participants.map((player, seat) => folded.has(seat) ? null : playerView(player));
  facade.seats = () => participants.length ? participants.map((player) =>
    player && (facade.isHandInProgress() || player.totalChips() > 0) ? playerView(player) : null) : originalSeats();
  facade.numActivePlayers = () => participants.filter((player, seat) =>
    player && !folded.has(seat) && player.stack() > 0).length;
  facade.pots = () => contributionPots();
  facade.holeCards = () => table._dealer._holeCards.slice(0, numSeats).map((cards) =>
    cards ? cards.map(cardView) : null);
  facade.legalActions = () => {
    assert(facade.isHandInProgress() && facade.isBettingRoundInProgress());
    const dealer = table._dealer;
    const betting = dealer._bettingRound;
    const seat = dealer.playerToAct();
    const player = participants[seat];
    const biggest = betting.biggestBet();
    const minimum = betting.minRaise();
    const actions = ['fold', player.betSize() >= biggest ? 'check' : 'call'];
    const lastActionBet = actedAt.get(seat);
    const reopened = lastActionBet === undefined || lastActionBet === 0 || biggest - lastActionBet >= minimum;
    const opponentCanCall = participants.some((opponent, index) =>
      opponent && index !== seat && !folded.has(index) && opponent.stack() > 0);
    const canRaise = reopened && opponentCanCall && player.totalChips() > biggest;
    if (canRaise) actions.push(biggest === 0 ? 'bet' : 'raise');
    return {
      actions,
      callAmount: Math.min(player.stack(), Math.max(0, biggest - player.betSize())),
      chipRange: canRaise ? {
        min: Math.min(biggest + minimum, player.totalChips()),
        max: player.totalChips(),
      } : undefined,
    };
  };
  facade.actionTaken = (action, amount) => {
    const legal = facade.legalActions();
    assert(legal.actions.includes(action), 'Action is not legal');
    const dealer = table._dealer;
    const betting = dealer._bettingRound;
    const seat = dealer.playerToAct();
    const minimum = betting.minRaise();
    const biggest = betting.biggestBet();
    const aggressive = action === 'bet' || action === 'raise';
    if (aggressive) {
      assert(Number.isSafeInteger(amount), 'Bet must be a whole number');
      assert(amount >= legal.chipRange.min && amount <= legal.chipRange.max, 'Bet is outside the legal range');
    }
    if (action === 'fold') folded.add(seat);
    dealer.actionTaken({ fold: 1, check: 2, call: 4, bet: 8, raise: 16 }[action], amount);
    if (aggressive && amount - biggest < minimum) betting._minRaise = minimum;
    if (action !== 'fold') actedAt.set(seat, betting.biggestBet());
    table.updateTablePlayers();
  };
  facade.endBettingRound = () => {
    originalEnd();
    prepareRound();
  };
  facade.showdown = () => {
    assert(facade.isHandInProgress() && facade.areBettingRoundsCompleted());
    assert(!facade.isBettingRoundInProgress());
    const dealer = table._dealer;
    const pots = contributionPots(true);
    const contenders = participants.flatMap((player, seat) => player && !folded.has(seat) ? [seat] : []);
    const contested = contenders.length > 1;
    const board = table._communityCards.cards();
    const evaluations = new Map(contested ? contenders.map((seat) =>
      [seat, evaluate([...dealer._holeCards[seat], ...board])]) : []);
    settledWinners = [];
    for (const pot of pots) {
      assert(pot.eligiblePlayers.length > 0, 'Pot must have an eligible winner');
      const winningHands = contested ? Hand.winners(pot.eligiblePlayers.map((seat) => evaluations.get(seat).result)) : [];
      const winners = contested ? pot.eligiblePlayers.filter((seat) => winningHands.includes(evaluations.get(seat).result))
        : pot.eligiblePlayers;
      const clockwise = winners.slice().sort((a, b) =>
        ((a - dealer._button - 1 + numSeats) % numSeats) - ((b - dealer._button - 1 + numSeats) % numSeats));
      const share = Math.floor(pot.size / winners.length);
      const odd = pot.size % winners.length;
      clockwise.forEach((seat, index) => participants[seat].addToStack(share + (index < odd ? 1 : 0)));
      if (contested) settledWinners.push(winners.map((seat) => [
        seat, evaluations.get(seat).view, dealer._holeCards[seat].map(cardView),
      ]));
    }
    const initialTotal = initialStacks.reduce((sum, stack) => sum + stack, 0);
    const finalTotal = participants.reduce((sum, player) => sum + (player?.stack() ?? 0), 0);
    assert.equal(finalTotal, initialTotal, 'Settlement must conserve every chip');
    dealer._handInProgress = false;
    dealer._winners = [];
    participants.forEach((player, seat) => {
      if (player) table._tablePlayers[seat] = player;
    });
    table.standUpBustedPlayers();
  };
  facade.winners = () => settledWinners;
  return facade;
}
