import { GameError } from './errors.js';

export const REGISTER_GRANT_AMOUNT = 10000;
export const SUBSIDY_AMOUNT = 2000;
export const SUBSIDY_THRESHOLD = 2000;

export function balanceOf(db, accountId) {
  return db.prepare('SELECT balance FROM wallets WHERE account_id = ?').get(accountId)?.balance ?? 0;
}

// 所有余额变动的唯一入口：钱包余额更新 + 流水写入包在同一个事务里。
// 流水唯一键 (account_id, type, ref_type, ref_id) 保证带 ref 的变动不会重复入账。
// 导出给 src/slot.js 复用：老虎机结算（SLOT_BET/SLOT_WIN）同样走这个入口。
export function credit(db, accountId, type, amount, refType, refId) {
  return db.transaction(() => {
    const row = db.prepare('SELECT balance FROM wallets WHERE account_id = ?').get(accountId);
    if (!row) throw new GameError('账户不存在');
    const next = row.balance + amount;
    if (next < 0) throw new GameError('筹码余额不足');
    db.prepare(`INSERT INTO ledger (account_id, type, amount, balance_after, ref_type, ref_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(accountId, type, amount, next, refType, refId, Date.now());
    db.prepare('UPDATE wallets SET balance = ? WHERE account_id = ?').run(next, accountId);
    return true;
  })();
}

export function grantRegister(db, accountId) {
  db.prepare('INSERT INTO wallets (account_id, balance) VALUES (?, 0)').run(accountId);
  return credit(db, accountId, 'REGISTER_GRANT', REGISTER_GRANT_AMOUNT, 'register', accountId);
}

// 入桌：从可用余额扣带入金额，筹码转移到桌上（总资产不变）。
export function bringIn(db, accountId, amount, roomCode) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new GameError('带入金额不正确');
  return credit(db, accountId, 'BRING_IN', -amount, null, null);
}

// 离桌：桌上剩余筹码退回可用余额。
export function cashOut(db, accountId, amount, roomCode) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return false;
  return credit(db, accountId, 'CASH_OUT', amount, null, null);
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 每日补助：subsidies 表 (account_id, day) 主键防并发/重复领取，由调用方先做资产门槛校验。
export function grantSubsidy(db, accountId) {
  const day = today();
  return db.transaction(() => {
    const inserted = db.prepare('INSERT OR IGNORE INTO subsidies (account_id, day, created_at) VALUES (?, ?, ?)')
      .run(accountId, day, Date.now());
    if (!inserted.changes) throw new GameError('今天已经领取过补助，明天再来吧');
    return credit(db, accountId, 'SUBSIDY', SUBSIDY_AMOUNT, 'subsidy', day);
  })();
}

// 手牌结算落库（幂等）：hands 表 (room_code, hand_number) 唯一键，
// 同一手重复调用时 INSERT OR IGNORE 返回 0 变更，直接跳过，不会重复写流水。
// players 元素: { accountId, playerId, name, seat, holeCards, net, isWinner, handName, handDetail, revealed }
export function settleHand(db, { handId, roomCode, handNumber, smallBlind, bigBlind, board, pot, players }) {
  const tx = db.transaction(() => {
    const inserted = db.prepare(`INSERT OR IGNORE INTO hands
        (id, room_code, hand_number, small_blind, big_blind, board, pot, practice, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(handId, roomCode, handNumber, smallBlind, bigBlind, JSON.stringify(board), pot, Date.now());
    if (!inserted.changes) return false;
    const insertPlayer = db.prepare(`INSERT INTO hand_players
        (hand_id, account_id, player_id, player_name, seat, hole_cards, net, is_winner, hand_name, hand_detail, revealed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertWinLedger = db.prepare(`INSERT OR IGNORE INTO ledger
        (account_id, type, amount, balance_after, ref_type, ref_id, created_at)
        VALUES (?, 'HAND_WIN', ?, ?, 'hand', ?, ?)`);
    for (const p of players) {
      insertPlayer.run(handId, p.accountId, p.playerId, p.name, p.seat,
        p.holeCards ? JSON.stringify(p.holeCards) : null,
        p.net, p.isWinner ? 1 : 0, p.handName, p.handDetail, p.revealed ? 1 : 0);
      if (p.accountId) {
        // HAND_WIN 是记账备忘：盈亏发生在桌上筹码，可用余额不变，
        // balance_after 记录写入时的可用余额；总资产 = 余额 + 桌上筹码。
        insertWinLedger.run(p.accountId, p.net, balanceOf(db, p.accountId), handId, Date.now());
      }
    }
    return true;
  });
  return tx();
}

// 弃牌赢家主动亮牌后，把当时未公开的底牌补录进 hand_players。
export function markRevealed(db, roomCode, handNumber, seat, holeCards, handDetail) {
  const hand = db.prepare('SELECT id FROM hands WHERE room_code = ? AND hand_number = ?').get(roomCode, handNumber);
  if (!hand) return;
  db.prepare('UPDATE hand_players SET revealed = 1, hole_cards = ? WHERE hand_id = ? AND seat = ?')
    .run(JSON.stringify(holeCards), hand.id, seat);
  if (handDetail) {
    db.prepare('UPDATE hand_players SET hand_detail = ? WHERE hand_id = ? AND seat = ?')
      .run(handDetail, hand.id, seat);
  }
}
