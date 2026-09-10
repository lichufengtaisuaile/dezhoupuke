// 常驻 NPC：有真实账号的电脑玩家，坐满两张系统桌的大部分座位。
// 对外完全表现为真人（广播层剥离 isBot/difficulty），经济和战绩与真人同一套规则，
// 财富计入排行榜。账号在启动时 ensure 存在（密码随机、不可恢复），accounts.npc 打标记
// 仅供管理后台识别。
import { randomBytes } from 'node:crypto';
import * as accounts from './account.js';
import { GameError } from './errors.js';

// 拟真中文昵称（无 AI/机器人/陪练 字样），难度按约 2:5:3 混合分配。
export const NPC_ROSTER = [
  { name: '晚风收信', difficulty: 'easy' },
  { name: '枕星河入梦', difficulty: 'easy' },
  { name: '山海皆可平', difficulty: 'normal' },
  { name: '一颗柠檬精', difficulty: 'normal' },
  { name: '南巷旧人', difficulty: 'normal' },
  { name: '月亮不打烊', difficulty: 'normal' },
  { name: '偷喝汽水', difficulty: 'normal' },
  { name: '风止于秋水', difficulty: 'hard' },
  { name: '雾里看霓虹', difficulty: 'hard' },
  { name: '半糖去冰', difficulty: 'hard' },
];

// 常驻系统桌的固定房间号（与正常 6 位数字房间号一致）。
export const NPC_TABLE_CODES = ['880101', '880102'];

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
