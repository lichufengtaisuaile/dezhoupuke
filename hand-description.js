import solver from 'pokersolver';

const { Hand } = solver;
const RANKS = '23456789TJQKA';
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const SUIT_NAMES = { clubs: '梅花', diamonds: '方块', hearts: '红桃', spades: '黑桃' };
const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
const rankLabel = rank => rank === 'T' ? '10' : rank;
const rankList = cards => cards.map(card => rankLabel(card.rank)).join('、');
const rankValue = rank => RANKS.indexOf(rank);

export function describeHand(holeCards, board = []) {
  if (!Array.isArray(holeCards) || holeCards.length !== 2) return null;
  const available = [...holeCards, ...board];
  const complete = available.length >= 5;
  let cards;
  let ranking;
  let royal = false;
  if (complete) {
    const solved = Hand.solve(available.map(card => card.rank + card.suit[0]));
    cards = solved.cards.slice(0, 5).map(card => ({
      rank: card.value === '10' ? 'T' : card.value === '1' ? 'A' : card.value,
      suit: SUITS.find(suit => suit[0] === card.suit),
    }));
    ranking = solved.rank - 1;
    royal = solved.name === 'Straight Flush' && solved.descr === 'Royal Flush';
  } else {
    cards = available.map(card => ({ ...card })).sort((a, b) => rankValue(b.rank) - rankValue(a.rank));
    const counts = [...new Set(cards.map(card => card.rank))].map(rank => cards.filter(card => card.rank === rank).length);
    ranking = counts.includes(4) ? 7 : counts.includes(3) ? 3 : counts.filter(count => count === 2).length === 2 ? 2 : counts.includes(2) ? 1 : 0;
  }
  const groups = [...new Set(cards.map(card => card.rank))]
    .map(rank => ({ rank, count: cards.filter(card => card.rank === rank).length }))
    .sort((a, b) => b.count - a.count || rankValue(b.rank) - rankValue(a.rank));
  const label = index => rankLabel(groups[index].rank);
  const kickers = cards.filter(card => groups.find(group => group.rank === card.rank).count === 1);
  const kickerText = kickers.length ? ` · ${rankList(kickers)} 踢脚牌` : '';
  let detail;
  switch (ranking) {
    case 0: detail = `${rankLabel(cards[0].rank)} 高牌${cards.length > 1 ? ` · ${rankList(cards.slice(1))}` : ''}`; break;
    case 1: detail = `${label(0)} 一对${kickerText}`; break;
    case 2: detail = `${label(0)} 和 ${label(1)} 两对${kickerText}`; break;
    case 3: detail = `${label(0)} 三条${kickerText}`; break;
    case 4: detail = `${rankLabel(cards[0].rank)} 高顺子`; break;
    case 5: detail = `${SUIT_NAMES[cards[0].suit]}同花 · ${rankList(cards)}`; break;
    case 6: detail = `${label(0)} 三条带 ${label(1)} 一对`; break;
    case 7: detail = `${label(0)} 四条${kickerText}`; break;
    case 8: detail = royal ? `${SUIT_NAMES[cards[0].suit]} 10、J、Q、K、A` : `${SUIT_NAMES[cards[0].suit]} ${rankLabel(cards[0].rank)} 高同花顺`; break;
  }
  return { name: royal ? '皇家同花顺' : HAND_NAMES[ranking], detail, cards, complete };
}
