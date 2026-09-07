(function () {
  'use strict';

  const chips = value => Number.isFinite(value) ? Math.max(0, value) : 0;

  globalThis.planChipEffects = function (previous, next) {
    const plan = { newHand: false, bets: [], collections: [], payouts: [] };
    if (!previous || !next || previous.code !== next.code) return plan;
    if (!['playing', 'finished'].includes(next.phase) || next.handNumber < previous.handNumber) return plan;

    plan.newHand = next.handNumber > previous.handNumber;
    if (!plan.newHand && previous.phase !== 'playing') return plan;

    const finished = next.phase === 'finished';
    const awards = new Map();
    if (finished) {
      for (const result of next.result ?? []) {
        const amount = chips(result.amount);
        if (amount > 0) awards.set(result.id, (awards.get(result.id) ?? 0) + amount);
      }
      plan.payouts = [...awards].map(([id, amount]) => ({ id, amount }));
    }

    const before = new Map((previous.players ?? []).map(player => [player.id, player]));
    const collectRound = finished || previous.round !== next.round;
    for (const player of next.players ?? []) {
      const old = before.get(player.id);
      if (!old || !player.inHand || (!plan.newHand && !old.inHand)) continue;
      const award = awards.get(player.id) ?? 0;
      const previousStack = plan.newHand && old.isBot && old.stack === 0
        ? chips(next.buyIn) : chips(old.stack);
      // Final snapshots already include winnings, so restore the pre-award stack.
      const paid = plan.newHand && !finished
        ? chips(player.bet)
        : Math.max(0, previousStack - chips(player.stack) + award);
      if (paid > 0) {
        plan.bets.push({ id: player.id, amount: paid, allIn: chips(player.stack) - award === 0 });
      }

      const previousBet = plan.newHand ? 0 : chips(old.bet);
      const amount = collectRound
        ? previousBet + paid
        : Math.max(0, previousBet + paid - chips(player.bet));
      if ((!plan.newHand || finished) && amount > 0) {
        plan.collections.push({ id: player.id, amount });
      }
    }
    return plan;
  };
})();
