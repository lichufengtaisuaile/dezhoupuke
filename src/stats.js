import { balanceOf } from './wallet.js';

const PAGE_SIZE = 20;

// 总资产 = 钱包余额 + 所有桌上 stack（带入/离桌只是内部转移，不改变总资产）。
function assetsList(db, rooms) {
  const stacks = new Map();
  for (const room of rooms.values()) {
    if (room.practice) continue; // 练习筹码不计入总资产与排行榜
    for (const p of room.players) {
      if (!p.accountId || p.departing) continue;
      stacks.set(p.accountId, (stacks.get(p.accountId) ?? 0) + p.stack);
    }
  }
  const rows = db.prepare(`SELECT w.account_id AS id, a.name, w.balance
                           FROM wallets w JOIN accounts a ON a.id = w.account_id`).all();
  return rows
    .map(row => ({ id: row.id, name: row.name, total: row.balance + (stacks.get(row.id) ?? 0) }))
    .sort((a, b) => b.total - a.total);
}

export function leaderboard(db, rooms, limit = 50) {
  return assetsList(db, rooms).slice(0, limit).map(({ name, total }) => ({ name, total }));
}

export function overview(db, rooms, accountId) {
  const assets = assetsList(db, rooms);
  const mine = assets.find(entry => entry.id === accountId);
  const totalAssets = mine ? mine.total : balanceOf(db, accountId);
  const tableStack = Math.max(0, totalAssets - balanceOf(db, accountId));
  const aggregate = db.prepare(`SELECT COUNT(*) AS hands,
      COALESCE(SUM(net), 0) AS net,
      COALESCE(SUM(CASE WHEN net > 0 THEN 1 ELSE 0 END), 0) AS winning
      FROM hand_players WHERE account_id = ?`).get(accountId);
  const slot = db.prepare(`SELECT COUNT(*) AS spins, COALESCE(SUM(net), 0) AS net
      FROM spins WHERE account_id = ?`).get(accountId);
  return {
    balance: balanceOf(db, accountId),
    tableStack,
    totalAssets,
    rank: mine ? 1 + assets.filter(entry => entry.total > mine.total).length : null,
    totalPlayers: assets.length,
    handsPlayed: aggregate.hands,
    // 总盈亏 = 德州净盈亏 + 老虎机净盈亏（总资产口径不变：balance + 桌上筹码）。
    netProfit: aggregate.net + slot.net,
    // 胜率口径：盈利手数 / 总局数（无论摊牌获胜还是对手弃牌获胜都计入）
    winRate: aggregate.hands ? aggregate.winning / aggregate.hands : 0,
    // 老虎机战绩单列：次数与累计净盈亏。
    slotSpins: slot.spins,
    slotNet: slot.net,
  };
}

export function handsPage(db, accountId, page = 1) {
  const current = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const total = db.prepare('SELECT COUNT(*) AS count FROM hand_players WHERE account_id = ?').get(accountId).count;
  const rows = db.prepare(`SELECT h.id AS handId, h.created_at AS time, h.room_code AS roomCode, h.hand_number AS handNumber,
      h.small_blind AS smallBlind, h.big_blind AS bigBlind, h.board, h.pot,
      hp.net, hp.hole_cards, hp.is_winner AS isWinner, hp.hand_name AS handName, hp.revealed
      FROM hand_players hp JOIN hands h ON h.id = hp.hand_id
      WHERE hp.account_id = ?
      ORDER BY h.created_at DESC, h.id DESC LIMIT ? OFFSET ?`)
    .all(accountId, PAGE_SIZE, (current - 1) * PAGE_SIZE);
  const winnersFor = db.prepare(`SELECT player_name AS name, hand_name AS handName
      FROM hand_players WHERE hand_id = ? AND is_winner = 1`);
  const hands = rows.map((row) => {
    const { handId, hole_cards, isWinner, revealed, ...rest } = row;
    return {
      ...rest,
      board: JSON.parse(row.board),
      holeCards: hole_cards ? JSON.parse(hole_cards) : null,
      isWinner: Boolean(isWinner),
      revealed: Boolean(revealed),
      winners: winnersFor.all(handId),
    };
  });
  return { page: current, pageSize: PAGE_SIZE, total, hands };
}

export function ledgerPage(db, accountId, page = 1) {
  const current = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const total = db.prepare('SELECT COUNT(*) AS count FROM ledger WHERE account_id = ?').get(accountId).count;
  const entries = db.prepare(`SELECT id, type, amount, balance_after AS balanceAfter,
      ref_type AS refType, ref_id AS refId, created_at AS time
      FROM ledger WHERE account_id = ?
      ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(accountId, PAGE_SIZE, (current - 1) * PAGE_SIZE);
  return { page: current, pageSize: PAGE_SIZE, total, entries };
}

function spinRow(row) {
  return {
    spinId: row.id,
    bet: row.bet,
    reels: JSON.parse(row.reels),
    payout: row.payout,
    net: row.net,
    time: row.created_at,
  };
}

// 老虎机战绩分页（个人中心"老虎机"页签）。
export function spinsPage(db, accountId, page = 1) {
  const current = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const total = db.prepare('SELECT COUNT(*) AS count FROM spins WHERE account_id = ?').get(accountId).count;
  const rows = db.prepare(`SELECT id, bet, reels, payout, net, created_at
      FROM spins WHERE account_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(accountId, PAGE_SIZE, (current - 1) * PAGE_SIZE);
  return { page: current, pageSize: PAGE_SIZE, total, spins: rows.map(spinRow) };
}

// 老虎机页面"最近开奖"：最新 limit 条（上限 50）。
export function recentSpins(db, accountId, limit = 20) {
  const current = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 20;
  const rows = db.prepare(`SELECT id, bet, reels, payout, net, created_at
      FROM spins WHERE account_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(accountId, current);
  return { spins: rows.map(spinRow) };
}
