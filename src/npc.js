// 常驻 NPC：有真实账号的电脑玩家，坐满两张系统桌的大部分座位。
// 对外完全表现为真人（广播层剥离 isBot/difficulty），经济和战绩与真人同一套规则，
// 财富计入排行榜。账号在启动时 ensure 存在（密码随机、不可恢复），accounts.npc 打标记
// 仅供管理后台识别。
import { randomBytes, randomInt } from 'node:crypto';
import * as accounts from './account.js';
import { GameError, requireThat } from './errors.js';

// 拟真中文昵称（无 AI/机器人/陪练 字样），难度按约 2:5:3 混合分配。
export const NPC_ROSTER = [
  { name: '晚风收信', difficulty: 'easy' },
  { name: '枕星河入梦', difficulty: 'easy' },
  { name: '山海皆可平', difficulty: 'easy' },
  { name: '一颗柠檬精', difficulty: 'easy' },
  { name: '南巷旧人', difficulty: 'normal' },
  { name: '月亮不打烊', difficulty: 'normal' },
  { name: '偷喝汽水', difficulty: 'normal' },
  { name: '风止于秋水', difficulty: 'normal' },
  { name: '半糖去冰', difficulty: 'normal' },
  { name: '雾里看霓虹', difficulty: 'normal' },
  { name: '人间惊鸿客', difficulty: 'normal' },
  { name: '橘络', difficulty: 'normal' },
  { name: '.cloud.', difficulty: 'easy' },
  { name: '知更鸟', difficulty: 'normal' },
  { name: '白桃乌龙', difficulty: 'hard' },
  { name: '夜航西飞', difficulty: 'hard' },
  { name: '山川皆无恙', difficulty: 'hard' },
  { name: '念念又年年', difficulty: 'normal' },
  { name: '桃汁夭夭', difficulty: 'easy' },
  { name: '一纸素笺', difficulty: 'hard' },
];

// 常驻系统桌的固定房间号（与正常 6 位数字房间号一致）。
export const NPC_TABLE_CODES = ['880101', '880102'];

// 默认氛围桌配置：老库升级/新库初始化时种入（见 db.js seedNpcTableConfigs）。
export const NPC_DEFAULT_CONFIGS = [
  { code: '880101', smallBlind: 5, bigBlind: 10, buyIn: 500, maxSeats: 6, keepVacant: 1 },
  { code: '880102', smallBlind: 5, bigBlind: 10, buyIn: 500, maxSeats: 6, keepVacant: 1 },
];

// ---------- 氛围桌配置 CRUD（管理后台调用，写操作留审计） ----------

function validateConfig({ smallBlind, bigBlind, buyIn, maxSeats, keepVacant }) {
  const sb = Number(smallBlind);
  const bb = Number(bigBlind);
  const buy = Number(buyIn);
  const seats = Number(maxSeats);
  const vacant = Number(keepVacant);
  requireThat(Number.isSafeInteger(sb) && sb >= 1, '小盲注需要是正整数');
  requireThat(Number.isSafeInteger(bb) && bb > sb, '大盲注需要是大于小盲注的整数');
  requireThat(Number.isSafeInteger(buy) && buy >= bb * 20, `桌上目标不能低于最小带入（${bb * 20}）`);
  requireThat(Number.isSafeInteger(seats) && seats >= 2 && seats <= 6, '最大人数需要在 2–6 之间');
  requireThat(Number.isSafeInteger(vacant) && vacant >= 1 && vacant <= 2, '保留空位需要在 1–2 之间');
  requireThat(vacant < seats, '保留空位不能大于等于最大人数');
  return { smallBlind: sb, bigBlind: bb, buyIn: buy, maxSeats: seats, keepVacant: vacant };
}

function audit(db, action, detail) {
  db.prepare('INSERT INTO admin_audit (admin, action, target_account_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('token', action, '0', JSON.stringify(detail ?? {}), Date.now());
}

export function listNpcTableConfigs(db) {
  return db.prepare('SELECT id, code, small_blind AS smallBlind, big_blind AS bigBlind, buy_in AS buyIn, max_seats AS maxSeats, keep_vacant AS keepVacant, enabled FROM npc_table_configs ORDER BY id')
    .all()
    .map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

// 生成不撞现有房间/配置的唯一 6 位房间号（88xxxx 段，随机 + 查重）。
function generateCode(db) {
  const used = new Set([
    ...db.prepare('SELECT code FROM npc_table_configs').all().map((row) => row.code),
  ]);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `88${String(1000 + randomInt(9000))}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new GameError('生成房间号失败，请重试');
}

export function createNpcTableConfig(db, input) {
  const config = validateConfig(input ?? {});
  return db.transaction(() => {
    const code = generateCode(db);
    const inserted = db.prepare(`INSERT INTO npc_table_configs
      (code, small_blind, big_blind, buy_in, max_seats, keep_vacant, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(code, config.smallBlind, config.bigBlind, config.buyIn, config.maxSeats, config.keepVacant, Date.now());
    audit(db, 'NPC_TABLE_CREATE', { code, ...config });
    return { id: Number(inserted.lastInsertRowid), code, ...config, enabled: true };
  })();
}

export function setNpcTableEnabled(db, id, enabled) {
  requireThat(typeof enabled === 'boolean', 'enabled 需要是 true 或 false');
  return db.transaction(() => {
    const row = db.prepare('SELECT id, code FROM npc_table_configs WHERE id = ?').get(id);
    requireThat(row, '没有找到这张氛围桌');
    db.prepare('UPDATE npc_table_configs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    audit(db, enabled ? 'NPC_TABLE_ENABLE' : 'NPC_TABLE_DISABLE', { code: row.code });
    return { id: row.id, code: row.code, enabled };
  })();
}

export function deleteNpcTableConfig(db, id) {
  return db.transaction(() => {
    const row = db.prepare('SELECT id, code FROM npc_table_configs WHERE id = ?').get(id);
    requireThat(row, '没有找到这张氛围桌');
    db.prepare('DELETE FROM npc_table_configs WHERE id = ?').run(id);
    audit(db, 'NPC_TABLE_DELETE', { code: row.code });
    return { id: row.id, code: row.code };
  })();
}

// 确保 NPC 账号存在（幂等，可重复调用/重启安全）。
// 名字被真人抢先注册时换成"原名+数字"的不显眼后缀；实在找不到可用名则跳过（自愈下轮再试）。
export function ensureNpcAccounts(db) {
  const npcs = [];
  const findByName = db.prepare('SELECT id, name, npc FROM accounts WHERE name = ?');
  const markNpc = db.prepare('UPDATE accounts SET npc = 1 WHERE id = ?');
  for (const rosterEntry of NPC_ROSTER) {
    let name = rosterEntry.name;
    let account = findByName.get(name);
    if (account && !account.npc) {
      name = null;
      for (let digit = 2; digit <= 99; digit += 1) {
        const candidate = `${rosterEntry.name}${digit}`;
        if ([...candidate].length > 12) break;
        if (!findByName.get(candidate)) { name = candidate; break; }
      }
      if (!name) continue;
      account = null;
    }
    if (!account) {
      try {
        const created = accounts.register(db, name, randomBytes(24).toString('hex'));
        markNpc.run(created.accountId);
        account = { id: created.accountId, name };
      } catch (error) {
        // 极端并发重名：本轮跳过，下一轮自愈会再补。
        if (error instanceof GameError) continue;
        throw error;
      }
    }
    npcs.push({ accountId: account.id, name: account.name ?? name, difficulty: rosterEntry.difficulty });
  }
  return npcs;
}

export function isNpcAccount(db, accountId) {
  return Boolean(db.prepare('SELECT npc FROM accounts WHERE id = ?').get(accountId)?.npc);
}

export function isNpcBanned(db, accountId) {
  const row = db.prepare('SELECT npc, is_banned AS banned FROM accounts WHERE id = ?').get(accountId);
  return Boolean(row?.npc && row.banned);
}
