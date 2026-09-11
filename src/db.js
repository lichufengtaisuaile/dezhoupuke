import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { NPC_DEFAULT_CONFIGS } from './npc.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_banned INTEGER NOT NULL DEFAULT 0,
  npc INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS wallets (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
);

-- 筹码流水。UNIQUE(account_id, type, ref_type, ref_id) 是幂等键：
-- ref 为 NULL 的行（BRING_IN/CASH_OUT 等转移类）不参与去重，
-- 需要防重的类型（REGISTER_GRANT/SUBSIDY/HAND_WIN/SLOT_BET/SLOT_WIN/ADMIN_ADJUST）必须带 ref。
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  type TEXT NOT NULL CHECK (type IN ('REGISTER_GRANT', 'SUBSIDY', 'BRING_IN', 'CASH_OUT', 'HAND_WIN', 'PRACTICE', 'SLOT_BET', 'SLOT_WIN', 'ADMIN_ADJUST', 'MAHJONG_SETTLE')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, type, ref_type, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger(account_id, id);

-- 老虎机旋转记录。id 即前端生成的 spinId（crypto.randomUUID），
-- 同账号重复提交同一 spinId 时服务端直接回放首次结果，不重复扣钱。
CREATE TABLE IF NOT EXISTS spins (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  bet INTEGER NOT NULL,
  reels TEXT NOT NULL,
  payout INTEGER NOT NULL,
  net INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_spins_account ON spins(account_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS hands (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  hand_number INTEGER NOT NULL,
  small_blind INTEGER NOT NULL,
  big_blind INTEGER NOT NULL,
  board TEXT NOT NULL,
  pot INTEGER NOT NULL,
  practice INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (room_code, hand_number)
);
CREATE INDEX IF NOT EXISTS idx_hands_created ON hands(created_at);

CREATE TABLE IF NOT EXISTS hand_players (
  hand_id TEXT NOT NULL REFERENCES hands(id),
  account_id TEXT,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  seat INTEGER NOT NULL,
  hole_cards TEXT,
  net INTEGER NOT NULL,
  is_winner INTEGER NOT NULL DEFAULT 0,
  hand_name TEXT,
  hand_detail TEXT,
  revealed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hand_id, seat)
);
CREATE INDEX IF NOT EXISTS idx_hand_players_account ON hand_players(account_id);

CREATE TABLE IF NOT EXISTS subsidies (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS room_snapshots (
  room_code TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 管理员操作审计：资金调整与封禁/解封都会留痕，detail 为 JSON。
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit(id);

-- 氛围桌（NPC 常驻桌）配置：管理后台增删改，heal 巡检按行 reconcile。
-- max_seats 2-6；keep_vacant 永远留给真人的空位数；enabled 停用后 NPC 撤出、房间清除。
CREATE TABLE IF NOT EXISTS npc_table_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  small_blind INTEGER NOT NULL,
  big_blind INTEGER NOT NULL,
  buy_in INTEGER NOT NULL,
  max_seats INTEGER NOT NULL,
  keep_vacant INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`;

export function createDb(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrateAccounts(db);
  migrateLedger(db);
  seedNpcTableConfigs(db);
  return db;
}

// 老库升级/新库初始化：npc_table_configs 为空时种入默认的两张氛围桌
// （880101/880102，5/10 盲注，目标 500，6 座留 1 空位），行为与升级前完全一致。
function seedNpcTableConfigs(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM npc_table_configs').get().count;
  if (count > 0) return;
  const insert = db.prepare(`INSERT INTO npc_table_configs
    (code, small_blind, big_blind, buy_in, max_seats, keep_vacant, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`);
  const now = Date.now();
  for (const config of NPC_DEFAULT_CONFIGS) {
    insert.run(config.code, config.smallBlind, config.bigBlind, config.buyIn, config.maxSeats, config.keepVacant, now);
  }
}

// 老库 accounts 缺少的列：ADD COLUMN 补上（DEFAULT 0，无损、幂等）。
// is_banned 为管理后台封禁标记；npc 标记系统常驻 NPC 账号（有真实经济身份）。
function migrateAccounts(db) {
  const columns = db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name);
  if (!columns.includes('is_banned')) {
    db.exec('ALTER TABLE accounts ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.includes('npc')) {
    db.exec('ALTER TABLE accounts ADD COLUMN npc INTEGER NOT NULL DEFAULT 0');
  }
}

// SQLite 不能修改 CHECK 约束：凡是 ledger.type 的 CHECK 不含最新类型集合的库
// （最早六种、加老虎机后的八种）都按"建新表 → 按列名拷贝 → 删旧表 → 改名"重建，数据无损。
// 注意：ledger 各历史版本的列集相同，按列名拷贝即可；外键约束临时关闭。
const LEDGER_TYPES = ['REGISTER_GRANT', 'SUBSIDY', 'BRING_IN', 'CASH_OUT', 'HAND_WIN', 'PRACTICE', 'SLOT_BET', 'SLOT_WIN', 'ADMIN_ADJUST', 'MAHJONG_SETTLE'];

function migrateLedger(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get();
  if (!table || LEDGER_TYPES.every((type) => table.sql.includes(`'${type}'`))) return;
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE ledger_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          type TEXT NOT NULL CHECK (type IN (${LEDGER_TYPES.map((type) => `'${type}'`).join(', ')})),
          amount INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          ref_type TEXT,
          ref_id TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (account_id, type, ref_type, ref_id)
        );
        INSERT INTO ledger_next (id, account_id, type, amount, balance_after, ref_type, ref_id, created_at)
          SELECT id, account_id, type, amount, balance_after, ref_type, ref_id, created_at FROM ledger;
        DROP TABLE ledger;
        ALTER TABLE ledger_next RENAME TO ledger;
        CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger(account_id, id);
      `);
    })();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

// 每次牌桌状态广播后调用：把可恢复的最小房间状态序列化落库，
// 服务重启时据此恢复座位与桌上筹码（对局中的手牌按降级方案作废）。
export function saveSnapshot(db, room) {
  const payload = {
    code: room.code,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    buyIn: room.buyIn,
    practice: Boolean(room.practice),
    autoNext: room.autoNext,
    hostId: room.hostId,
    handNumber: room.handNumber,
    dealerSeat: room.dealerSeat,
    phase: room.phase,
    log: room.log,
    logSequence: room.logSequence,
    revealed: [...room.revealed],
    npcTable: Boolean(room.npcTable),
    players: room.players.map(p => ({
      id: p.id,
      accountId: p.accountId ?? null,
      name: p.name,
      seat: p.seat,
      stack: p.stack,
      bet: p.bet,
      isBot: Boolean(p.isBot),
      npc: Boolean(p.npc),
      difficulty: p.isBot ? (p.botDifficulty ?? 'normal') : null,
      folded: Boolean(p.folded),
      inHand: Boolean(p.inHand),
      departing: Boolean(p.departing),
    })),
  };
  db.prepare(`INSERT INTO room_snapshots (room_code, payload, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(room_code) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
    .run(room.code, JSON.stringify(payload), Date.now());
}

export function loadSnapshots(db) {
  return db.prepare('SELECT payload FROM room_snapshots').all()
    .map(row => { try { return JSON.parse(row.payload); } catch { return null; } })
    .filter(Boolean);
}

export function deleteSnapshot(db, roomCode) {
  db.prepare('DELETE FROM room_snapshots WHERE room_code = ?').run(roomCode);
}

export function clearSnapshots(db) {
  db.prepare('DELETE FROM room_snapshots').run();
}
