// 电脑陪练决策：可注入 RNG 的纯函数，三档难度（easy / normal / hard）。
// - easy   ：原 botAction 逻辑（只看底牌，对子或牌面和 ≥24 为强牌，24% 频率加注 3BB）。
// - normal ：翻牌前同 easy 但加注频率降到 18%；翻牌后用 pokersolver 看成牌——
//            两对及以上价值下注（70%，约 1/2~2/3 底池），一对/听牌过牌-跟注（≤1/3 底池），
//            弱牌基本弃牌、8% 低频 bluff（约 1/2 底池）。
// - hard   ：在 normal 基础上加底池赔率（一对及以下 ≤1/4、听牌 ≤1/3、两对+ ≤1/2）、
//            后位偷盲/偷池（两张 T+ 30%）、bluff 提到 12% 且优先听牌、
//            价值下注 3/4 底池且转牌河牌连续开火。
// 所有下注额都经 legal.minRaise/maxRaise 夹取；任何非法动作兜底 check→call→fold，绝不抛异常。
import { randomInt } from 'node:crypto';
import solver from 'pokersolver';

const { Hand } = solver;
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const rankValue = (rank) => '23456789TJQKA'.indexOf(rank) + 2;

export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'];
export function normalizeDifficulty(value) {
  return BOT_DIFFICULTIES.includes(value) ? value : 'normal';
}
export const DIFFICULTY_LABELS = { easy: '易', normal: '普', hard: '难' };

const EASY = { preflopRaise: 24 };
const PROFILES = {
  normal: {
    preflopRaise: 18, bluff: 8, valueBetFreq: 70, valueSize: 0.55,
    reraiseFreq: 50, reraiseSize: 0.65, mediumCallPot: 1 / 3,
    odds: false, steal: 0, bluffPrefersDraw: false, aggroLate: false,
  },
  hard: {
    preflopRaise: 18, bluff: 12, valueBetFreq: 70, valueSize: 0.75,
    reraiseFreq: 60, reraiseSize: 0.75, mediumCallPot: 1 / 3,
    odds: true, steal: 30, bluffPrefersDraw: true, aggroLate: true,
  },
};

const cardText = (card) => card.rank + card.suit[0];
const betOrRaise = (legal) => (legal.actions.includes('raise') ? 'raise' : 'bet');
const clampAmount = (legal, amount) => Math.min(legal.maxRaise, Math.max(legal.minRaise, Math.round(amount)));
// 目标总下注额 = 跟上当前注 + 底池的一定比例。
const potTarget = (legal, pot, fraction) => clampAmount(legal, legal.callAmount + pot * fraction);

function hasFlushDraw(cards) {
  return SUITS.some((suit) => cards.filter((card) => card.suit === suit).length === 4);
}
function hasStraightDraw(cards) {
  const values = new Set(cards.map((card) => rankValue(card.rank)));
  if (values.has(14)) values.add(1); // A 也算 1，可组成 A-2-3-4-5
  for (let low = 1; low + 4 <= 14; low += 1) {
    let hits = 0;
    for (let value = low; value < low + 5; value += 1) if (values.has(value)) hits += 1;
    if (hits >= 4) return true;
  }
  return false;
}

// 翻牌后分类：strong=两对及以上；medium=一对或听牌（同花听/顺子听）；weak=其他。
function postflopCategory(holeCards, communityCards) {
  const all = [...holeCards, ...communityCards];
  const made = Hand.solve(all.map(cardText)).rank; // pokersolver：1 高牌 … 2 一对 3 两对 4 三条 …
  const draw = made <= 2 && (hasFlushDraw(all) || hasStraightDraw(all));
  if (made >= 3) return { category: 'strong', draw: false, made };
  if (made === 2 || draw) return { category: 'medium', draw, made };
  return { category: 'weak', draw: false, made };
}

// 翻牌前简化逻辑（easy 全街沿用；normal/hard 翻牌前使用，加注频率按档调整）。
function simpleAction(state, profile, rng) {
  const { holeCards, legal, stack, bigBlind, position } = state;
  const ranks = holeCards.map((card) => rankValue(card.rank));
  const strong = ranks[0] === ranks[1] || ranks[0] + ranks[1] >= 24;
  const choice = rng();
  const canAggress = legal.minRaise !== null && legal.minRaise <= legal.maxRaise;
  // hard：后位（按钮/CO）无人加注且两张高牌 T+，30% 偷盲。
  if (profile.steal && canAggress && legal.callAmount <= bigBlind
    && position !== null && position <= 1 && ranks.every((rank) => rank >= 10) && choice < profile.steal) {
    return { action: betOrRaise(legal), amount: clampAmount(legal, bigBlind * 3) };
  }
  if (canAggress && strong && choice < profile.preflopRaise) {
    return { action: betOrRaise(legal), amount: clampAmount(legal, bigBlind * 3) };
  }
  if (legal.actions.includes('check')) return { action: 'check' };
  if (legal.actions.includes('call')
    && (strong || legal.callAmount <= bigBlind * 3 || (legal.callAmount < stack / 4 && rng() < 65))) {
    return { action: 'call' };
  }
  return { action: 'fold' };
}

function postflopAction(state, profile, rng) {
  const { holeCards, communityCards, legal, pot, position } = state;
  const { category, draw } = postflopCategory(holeCards, communityCards);
  const street = communityCards.length; // 3 翻牌 / 4 转牌 / 5 河牌
  const facingBet = !legal.actions.includes('check');
  const canAggress = legal.minRaise !== null && legal.minRaise <= legal.maxRaise;
  const bluffing = () => rng() < profile.bluff;

  if (!facingBet) {
    if (category === 'strong') {
      // hard：转牌/河牌超对、顶对以上连续开火（频率拉高到 90%）。
      const freq = profile.aggroLate && street >= 4 ? Math.max(profile.valueBetFreq, 90) : profile.valueBetFreq;
      if (canAggress && rng() < freq) return { action: betOrRaise(legal), amount: potTarget(legal, pot, profile.valueSize) };
      return { action: 'check' };
    }
    // hard：后位用两张高牌扩大下注范围偷池。
    if (profile.steal && canAggress && position !== null && position <= 1
      && holeCards.every((card) => rankValue(card.rank) >= 10) && rng() < profile.steal) {
      return { action: betOrRaise(legal), amount: potTarget(legal, pot, 0.5) };
    }
    if (category === 'weak' && canAggress && bluffing()) {
      return { action: betOrRaise(legal), amount: potTarget(legal, pot, 0.5) };
    }
    return { action: 'check' };
  }

  // 面对下注。
  const odds = legal.callAmount > 0 ? legal.callAmount / (pot + legal.callAmount) : 0;
  if (category === 'strong') {
    // 被加注后强牌加注/跟注；顶对大跟注兜底跟到底。
    if (canAggress && rng() < profile.reraiseFreq) {
      return { action: betOrRaise(legal), amount: potTarget(legal, pot, profile.reraiseSize) };
    }
    if (legal.actions.includes('call') && (!profile.odds || odds <= 0.5)) return { action: 'call' };
    if (legal.actions.includes('call')) return { action: 'call' };
    return { action: 'fold' };
  }
  // hard：bluff 优先选听牌（半 bluff）。
  if (profile.bluffPrefersDraw && draw && canAggress && bluffing()) {
    return { action: betOrRaise(legal), amount: potTarget(legal, pot, 0.5) };
  }
  if (profile.odds) {
    // 底池赔率：一对及以下 ≤1/4 才跟，听牌放宽到 1/3。
    const threshold = draw ? 1 / 3 : 1 / 4;
    if (legal.actions.includes('call') && odds <= threshold) return { action: 'call' };
  } else if (category === 'medium') {
    if (legal.actions.includes('call') && legal.callAmount <= pot * profile.mediumCallPot) return { action: 'call' };
  }
  if (canAggress && bluffing()) return { action: betOrRaise(legal), amount: potTarget(legal, pot, 0.5) };
  return { action: 'fold' };
}

function fallback(legal) {
  if (legal?.actions?.includes('check')) return { action: 'check' };
  if (legal?.actions?.includes('call')) return { action: 'call' };
  return { action: 'fold' };
}

// 校验并修正决策：动作必须在 legal.actions 内；bet/raise 金额必须是 min~max 的整数。
function sanitize(decision, legal) {
  if (decision && legal.actions.includes(decision.action)) {
    if (decision.action === 'bet' || decision.action === 'raise') {
      if (legal.minRaise === null || legal.maxRaise === null || legal.minRaise > legal.maxRaise) return fallback(legal);
      const amount = Math.round(decision.amount);
      if (Number.isInteger(amount) && amount >= legal.minRaise && amount <= legal.maxRaise) {
        return { action: decision.action, amount };
      }
      return { action: decision.action, amount: clampAmount(legal, amount) };
    }
    return { action: decision.action };
  }
  return fallback(legal);
}

export function decideBotAction(state, rng = () => randomInt(100)) {
  try {
    const legal = state?.legal;
    if (!legal || !Array.isArray(legal.actions) || legal.actions.length === 0) return { action: 'fold' };
    const difficulty = normalizeDifficulty(state.difficulty);
    const decision = difficulty === 'easy' || (state.communityCards?.length ?? 0) < 3
      ? simpleAction(state, difficulty === 'easy' ? EASY : PROFILES[difficulty], rng)
      : postflopAction(state, PROFILES[difficulty], rng);
    return sanitize(decision, legal);
  } catch {
    return fallback(state?.legal);
  }
}
