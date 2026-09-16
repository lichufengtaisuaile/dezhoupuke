// 全服定时发钱：每天 0:00 和 18:00 给所有账号（含 NPC）发放 10k 筹码。
// 幂等：ledger 的 UNIQUE(account_id, type, ref_type, ref_id) 保证同一批次重复执行不会多发。
import { credit } from './wallet.js';

export const DAILY_GRANT_AMOUNT = 10000;
export const DAILY_GRANT_SLOTS = [0, 18]; // 每天发放时点（小时）

function dateKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

// 计算下一次发放时间：当天 0 点 / 18 点中最近的未来时点，否则明天 0 点。
export function nextGrantTime(now = Date.now()) {
  const date = new Date(now);
  for (const slot of DAILY_GRANT_SLOTS) {
    const candidate = new Date(date);
    candidate.setHours(slot, 0, 0, 0);
    if (candidate.getTime() > now) return candidate.getTime();
  }
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(DAILY_GRANT_SLOTS[0], 0, 0, 0);
  return tomorrow.getTime();
}

// 给全服所有账号发放一批资金；返回实际发放人数（重复批次自动跳过）。
export function grantDailySubsidy(db, now = Date.now()) {
  const hour = new Date(now).getHours();
  const slot = hour >= DAILY_GRANT_SLOTS[1] ? DAILY_GRANT_SLOTS[1] : DAILY_GRANT_SLOTS[0];
  const refId = `daily-grant-${dateKey(now)}-${slot}h`;
  const ids = db.prepare('SELECT id FROM accounts').all().map((row) => row.id);
  let granted = 0;
  for (const id of ids) {
    try {
      credit(db, id, 'SUBSIDY', DAILY_GRANT_AMOUNT, 'daily-grant', refId);
      granted += 1;
    } catch {
      // 同批次已领过（唯一约束），跳过
    }
  }
  return { refId, granted, total: ids.length };
}
