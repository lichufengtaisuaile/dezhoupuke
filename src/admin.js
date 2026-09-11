import { GameError, requireThat } from './errors.js';
import { credit, balanceOf } from './wallet.js';
import { hasMahjongTable, tableAssets } from './stats.js';

export const ADMIN_PAGE_SIZE = 20;
const AUDIT_ADMIN = 'token';

// ---------- 用户列表（含战绩统计） ----------

// tableStack 从内存房间实时合计；总资产 = 钱包余额 + 桌上筹码（与 overview 同口径）。
export function usersPage(db, rooms, { q = '', page = 1 } = {}) {
  const current = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const keyword = typeof q === 'string' ? q.trim() : '';
  const clause = keyword ? "WHERE a.name LIKE ? ESCAPE '\\'" : '';
  const args = keyword ? [`%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM accounts a ${clause}`).get(...args).count;
  const hasMahjong = hasMahjongTable(db, 'mahjong_round_players');
  const mahjongRoundsSql = hasMahjong ? '(SELECT COUNT(*) FROM mahjong_round_players mp WHERE mp.account_id = a.id)' : '0';
  const mahjongNetSql = hasMahjong ? '(SELECT COALESCE(SUM(mp.net), 0) FROM mahjong_round_players mp WHERE mp.account_id = a.id)' : '0';
  const mahjongWinsSql = hasMahjong ? '(SELECT COALESCE(SUM(mp.wins), 0) FROM mahjong_round_players mp WHERE mp.account_id = a.id)' : '0';
  const rows = db.prepare(`
      SELECT a.id, a.name, a.is_banned AS isBanned, a.npc, a.created_at AS createdAt, w.balance,
        (SELECT COUNT(*) FROM hand_players hp WHERE hp.account_id = a.id) AS handsPlayed,
        (SELECT COUNT(*) FROM spins s WHERE s.account_id = a.id) AS slotSpins,
        ${mahjongRoundsSql} AS mahjongRounds,
        ${mahjongNetSql} AS mahjongNet,
        ${mahjongWinsSql} AS mahjongHuCount,
        (SELECT COALESCE(SUM(hp.net), 0) FROM hand_players hp WHERE hp.account_id = a.id)
          + (SELECT COALESCE(SUM(s.net), 0) FROM spins s WHERE s.account_id = a.id)
          + ${mahjongNetSql} AS netProfit
      FROM accounts a JOIN wallets w ON w.account_id = a.id
      ${clause}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
    .all(...args, ADMIN_PAGE_SIZE, (current - 1) * ADMIN_PAGE_SIZE);
  const stacks = tableAssets(db, rooms);
  const users = rows.map((row) => {
    const tableStack = stacks.get(row.id) ?? 0;
    return {
      id: row.id,
      name: row.name,
      isBanned: Boolean(row.isBanned),
      isNpc: Boolean(row.npc),
      balance: row.balance,
      tableStack,
      totalAssets: row.balance + tableStack,
      handsPlayed: row.handsPlayed,
      slotSpins: row.slotSpins,
      mahjongRounds: row.mahjongRounds,
      mahjongNet: row.mahjongNet,
      mahjongHuCount: row.mahjongHuCount,
      netProfit: row.netProfit,
      createdAt: row.createdAt,
    };
  });
  return { page: current, pageSize: ADMIN_PAGE_SIZE, total, users };
}

// ---------- 资金调整 ----------

function writeAudit(db, action, targetAccountId, detail) {
  const inserted = db.prepare('INSERT INTO admin_audit (admin, action, target_account_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(AUDIT_ADMIN, action, targetAccountId, JSON.stringify(detail ?? {}), Date.now());
  return Number(inserted.lastInsertRowid);
}

// amount 可正可负、不可为 0；负调整不能让余额变负（提前校验 + credit 的 CHECK 兜底）。
// 事务内先写 admin_audit，再用 auditId 作 ledger 幂等键（ref 'admin' / 'audit-<id>'）：
// 同一笔审计最多一条 ADMIN_ADJUST 流水。
export function adjustBalance(db, accountId, amount, reason) {
  requireThat(Number.isSafeInteger(amount), '调整金额需要是整数');
  requireThat(amount !== 0, '调整金额不能为 0');
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  requireThat(trimmed.length > 0, '请填写调整原因');
  requireThat([...trimmed].length <= 100, '调整原因最多 100 个字');
  return db.transaction(() => {
    const account = db.prepare('SELECT id, name FROM accounts WHERE id = ?').get(accountId);
    requireThat(account, '没有找到这个用户');
    if (amount < 0 && balanceOf(db, accountId) < -amount) {
      throw new GameError(`调整金额超出用户余额（当前 ${balanceOf(db, accountId)}）`);
    }
    const auditId = writeAudit(db, 'ADJUST_BALANCE', accountId, { amount, reason: trimmed });
    credit(db, accountId, 'ADMIN_ADJUST', amount, 'admin', `audit-${auditId}`);
    return { accountId, name: account.name, balance: balanceOf(db, accountId), auditId };
  })();
}

// ---------- 封禁 / 解封 ----------

// 只落库与审计；踢房间/断 socket 由 server.js 在事务外执行。
export function setBanned(db, accountId, banned) {
  requireThat(typeof banned === 'boolean', 'banned 需要是 true 或 false');
  return db.transaction(() => {
    const account = db.prepare('SELECT id, name, is_banned FROM accounts WHERE id = ?').get(accountId);
    requireThat(account, '没有找到这个用户');
    db.prepare('UPDATE accounts SET is_banned = ? WHERE id = ?').run(banned ? 1 : 0, accountId);
    const auditId = writeAudit(db, banned ? 'BAN' : 'UNBAN', accountId, { banned });
    return { accountId, name: account.name, banned, auditId };
  })();
}

export function isBanned(db, accountId) {
  return Boolean(db.prepare('SELECT is_banned FROM accounts WHERE id = ?').get(accountId)?.is_banned);
}

// ---------- 审计日志 ----------

export function auditPage(db, page = 1) {
  const current = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const total = db.prepare('SELECT COUNT(*) AS count FROM admin_audit').get().count;
  const rows = db.prepare(`
      SELECT aa.id, aa.action, aa.target_account_id AS targetAccountId, a.name AS targetName,
        aa.detail, aa.created_at AS time
      FROM admin_audit aa LEFT JOIN accounts a ON a.id = aa.target_account_id
      ORDER BY aa.id DESC LIMIT ? OFFSET ?`)
    .all(ADMIN_PAGE_SIZE, (current - 1) * ADMIN_PAGE_SIZE);
  return {
    page: current,
    pageSize: ADMIN_PAGE_SIZE,
    total,
    entries: rows.map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : {} })),
  };
}
