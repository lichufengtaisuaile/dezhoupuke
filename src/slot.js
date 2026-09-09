import { randomInt } from 'node:crypto';
import { GameError } from './errors.js';
import { credit, balanceOf } from './wallet.js';

// 老虎机：符号权重、赔付表与判定逻辑原样复刻自原型 D:/slot-machine/app.js，
// 服务端是唯一开奖权威，前端只负责展示返回的三个符号。
export const SLOT_SYMBOLS = [
  { id: 'seven', label: '幸运 7', weight: 6 },
  { id: 'diamond', label: '钻石', weight: 8 },
  { id: 'bell', label: '金铃', weight: 12 },
  { id: 'bar', label: 'BAR', weight: 14 },
  { id: 'cherry', label: '樱桃', weight: 20 },
  { id: 'lemon', label: '柠檬', weight: 20 },
  { id: 'clover', label: '四叶草', weight: 20 },
];
export const SLOT_TRIPLE_PAYOUTS = { seven: 50, diamond: 30, bell: 15, bar: 10, cherry: 8 };
export const SLOT_VALID_BETS = [50, 100, 200, 500];
export const SLOT_MIN_CUSTOM_BET = 10;
export const SLOT_MAX_BET = 100000;
const BET_HINT = `下注金额不正确，可选档位 50 / 100 / 200 / 500，或自定义 ${SLOT_MIN_CUSTOM_BET} - ${SLOT_MAX_BET} 的整数`;
const TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);

function requireThat(condition, message) { if (!condition) throw new GameError(message); }

// 与原型 evaluateResult 逐条一致：三个相同 → 赔付表倍数（表外的任意三同 6×），
// 任意一对 → 2×，其余 0。
export function evaluateSpin(reelIds) {
  const counts = reelIds.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());
  const tripleId = [...counts.entries()].find(([, count]) => count === 3)?.[0];
  if (tripleId) {
    const multiplier = SLOT_TRIPLE_PAYOUTS[tripleId] || 6;
    return {
      multiplier,
      title: tripleId === 'seven' ? '头奖！三枚幸运 7' : '三连同图',
    };
  }
  if ([...counts.values()].some((count) => count === 2)) {
    return { multiplier: 2, title: '幸运一对' };
  }
  return { multiplier: 0, title: '未中奖' };
}

function drawSymbol() {
  let cursor = randomInt(TOTAL_WEIGHT);
  for (const symbol of SLOT_SYMBOLS) {
    cursor -= symbol.weight;
    if (cursor < 0) return symbol;
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

function spinResult(row, balance, duplicate) {
  return {
    spinId: row.id,
    bet: row.bet,
    reels: JSON.parse(row.reels),
    payout: row.payout,
    net: row.net,
    outcome: evaluateSpin(JSON.parse(row.reels)),
    balance,
    ...(duplicate ? { duplicate: true } : {}),
  };
}

// 结算全部在事务里：幂等回放 → 抽符号 → 判定 → 扣 bet（SLOT_BET）→
// 派 payout（SLOT_WIN，payout 为 0 时不写派奖流水）→ 写 spins 记录。
// spins 表主键就是前端生成的 spinId：断网重试/重复点击提交同一 spinId
// 时直接返回首次结果，余额与流水都不会重复。
export function spin(db, accountId, bet, spinId) {
  requireThat(Number.isSafeInteger(bet), BET_HINT);
  requireThat(
    SLOT_VALID_BETS.includes(bet) || (bet >= SLOT_MIN_CUSTOM_BET && bet <= SLOT_MAX_BET),
    BET_HINT,
  );
  requireThat(typeof spinId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(spinId), '请求格式不正确');
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM spins WHERE id = ? AND account_id = ?').get(spinId, accountId);
    if (existing) return spinResult(existing, balanceOf(db, accountId), true);
    if (!db.prepare('SELECT 1 FROM wallets WHERE account_id = ?').get(accountId)) throw new GameError('账户不存在');
    if (balanceOf(db, accountId) < bet) throw new GameError('筹码余额不足');
    const reels = [drawSymbol(), drawSymbol(), drawSymbol()];
    const outcome = evaluateSpin(reels.map((symbol) => symbol.id));
    const payout = bet * outcome.multiplier;
    const net = payout - bet;
    credit(db, accountId, 'SLOT_BET', -bet, 'spin', spinId);
    if (payout > 0) credit(db, accountId, 'SLOT_WIN', payout, 'spin', spinId);
    db.prepare('INSERT INTO spins (id, account_id, bet, reels, payout, net, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(spinId, accountId, bet, JSON.stringify(reels.map((symbol) => symbol.id)), payout, net, Date.now());
    return spinResult({ id: spinId, bet, reels: JSON.stringify(reels.map((s) => s.id)), payout, net }, balanceOf(db, accountId), false);
  })();
}
