// NPC 头像生态：让 NPC 也参与开宝箱和头像交易，让市场有人气。
// 行为守则（防止 NPC 扰乱经济）：
// - 只花自己钱包里已有的筹码（牌桌赢来的），系统不凭空印钱
// - 每天开箱有上限；只买"明显划算"的商品（低于参考价 8 折），每天限量
// - 重复头像才上架，价格围绕参考价小幅浮动，同时上架数量有限
import { randomInt, randomUUID } from 'node:crypto';
import { balanceOf } from './wallet.js';
import * as treasure from './treasure.js';

export const NPC_OPEN_CHANCE_PER_TICK = 0.25;   // 每个 tick 每个 NPC 尝试开箱的概率
export const NPC_MAX_OPENS_PER_DAY = 5;
export const NPC_MAX_BUYS_PER_DAY = 3;
export const NPC_MAX_ACTIVE_LISTINGS = 5;
export const NPC_BALANCE_RESERVE = 50000;       // 钱包要留的底仓，避免把筹码抽干
export const NPC_BUY_DISCOUNT = 0.8;            // 低于参考价 8 折才出手
export const NPC_DEFAULT_LIST_PRICE = 12000;    // 无参考价时的挂牌基准

function dayStart(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function opensToday(db, accountId, start) {
  return db.prepare('SELECT COUNT(*) AS count FROM treasure_opens WHERE account_id = ? AND created_at >= ?')
    .get(accountId, start).count;
}

function buysToday(db, accountId, start) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ledger
    WHERE account_id = ? AND type = 'MARKET_BUY' AND created_at >= ?`).get(accountId, start).count;
}

function npcActiveListings(db, accountId) {
  return db.prepare(`SELECT COUNT(*) AS count FROM avatar_market_listings
    WHERE seller_account_id = ? AND status = 'ACTIVE'`).get(accountId).count;
}

// 上架一个 NPC 的重复头像：取一件未上架且同款有多份的物品，价格围绕参考价浮动 ±20%。
function maybeListDuplicate(db, npcId) {
  if (npcActiveListings(db, npcId) >= NPC_MAX_ACTIVE_LISTINGS) return;
  const duplicates = db.prepare(`SELECT i.id, i.avatar_id, COUNT(*) OVER (PARTITION BY i.avatar_id) AS copies
    FROM avatar_items i
    WHERE i.owner_account_id = ?
      AND NOT EXISTS (SELECT 1 FROM avatar_market_listings l WHERE l.item_id = i.id AND l.status = 'ACTIVE')
    ORDER BY i.acquired_at ASC`).all(npcId)
    .filter(row => row.copies >= 2);
  if (!duplicates.length) return;
  const pick = duplicates[randomInt(duplicates.length)];
  const reference = treasure.marketReferencePrice(db, pick.avatar_id) ?? NPC_DEFAULT_LIST_PRICE;
  const jitter = 0.8 + randomInt(41) / 100; // 0.80–1.20
  const price = Math.max(treasure.MIN_LISTING_PRICE, Math.round(reference * jitter / 100) * 100);
  try {
    treasure.createListingInternal(db, npcId, pick.id, price, { allowNpc: true });
  } catch {
    // 余额不足付上架费等场景直接放弃，下个 tick 再说
  }
}

// 捡漏：低于参考价 8 折的玩家商品，NPC 有余钱就买。
function maybeBuyDeals(db, npcId, start) {
  if (buysToday(db, npcId, start) >= NPC_MAX_BUYS_PER_DAY) return;
  const candidates = db.prepare(`SELECT l.id, l.price, i.avatar_id
    FROM avatar_market_listings l JOIN avatar_items i ON i.id = l.item_id
    JOIN accounts seller ON seller.id = l.seller_account_id
    WHERE l.status = 'ACTIVE' AND seller.npc = 0
    ORDER BY l.price ASC LIMIT 50`).all();
  for (const listing of candidates) {
    if (buysToday(db, npcId, start) >= NPC_MAX_BUYS_PER_DAY) return;
    const reference = treasure.marketReferencePrice(db, listing.avatar_id);
    if (!reference || listing.price > Math.floor(reference * NPC_BUY_DISCOUNT)) continue;
    if (balanceOf(db, npcId) < listing.price + NPC_BALANCE_RESERVE) return;
    try {
      treasure.buyListing(db, npcId, listing.id, { allowNpc: true });
    } catch {
      // 被人抢先或余额变动，继续看下一个
    }
  }
}

// 每个 tick 对每个 NPC：小概率开箱；开箱后处理重复上架；再尝试捡漏。
// 由 server.js 定时调用；与氛围桌开关相互独立。
export function npcMarketTick(db, { npcIds = null, now = Date.now() } = {}) {
  const ids = npcIds ?? db.prepare('SELECT id FROM accounts WHERE npc = 1').all().map(row => row.id);
  const start = dayStart(now);
  const summary = { opened: 0, listed: 0, bought: 0 };
  for (const npcId of ids) {
    if (randomInt(100) < NPC_OPEN_CHANCE_PER_TICK * 100
      && opensToday(db, npcId, start) < NPC_MAX_OPENS_PER_DAY
      && balanceOf(db, npcId) >= treasure.BOX_PRICE + NPC_BALANCE_RESERVE) {
      try {
        const result = treasure.openBox(db, npcId, randomUUID(), { allowNpc: true });
        summary.opened += 1;
        if (result.won) maybeListDuplicate(db, npcId);
      } catch {
        // 单个 NPC 失败不影响其他 NPC
      }
    }
    const before = npcActiveListings(db, npcId);
    maybeListDuplicate(db, npcId);
    summary.listed += Math.max(0, npcActiveListings(db, npcId) - before);
    const buysBefore = buysToday(db, npcId, start);
    maybeBuyDeals(db, npcId, start);
    summary.bought += buysToday(db, npcId, start) - buysBefore;
  }
  return summary;
}
