import { randomInt, randomUUID } from 'node:crypto';
import { GameError } from './errors.js';
import { balanceOf, credit } from './wallet.js';
import '../public/avatar-catalog.js';

export const BOX_PRICE = 5000;
export const TEN_OPEN_COUNT = 10;
export const TEN_OPEN_PRICE = BOX_PRICE * TEN_OPEN_COUNT;
export const WIN_BASIS_POINTS = 1000;
export const BASIS_POINTS = 10000;
// 成交手续费 9%（成交时从卖家收入扣除）；另有上架费 1%（上架时支付，过期不退）。
export const MARKET_FEE_BASIS_POINTS = 900;
export const LISTING_FEE_BASIS_POINTS = 100;
export const MIN_LISTING_PRICE = 1000;
export const MAX_ACTIVE_LISTINGS = 10;
export const LISTING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function requireThat(condition, message) {
  if (!condition) throw new GameError(message);
}

function prize(avatarId) {
  return globalThis.TONGZHUO_AVATARS.prizeItems.find(item => item.id === avatarId) ?? null;
}

function publicPrize(avatarId) {
  const item = prize(avatarId);
  return item ? { id: item.id, name: item.name, src: item.src, series: item.series } : null;
}

// 7 天未成交的 ACTIVE 订单统一置为 EXPIRED（头像退回卖家，上架费不退）。
// 惰性清理：每次读交易市场/库存/上架前调用，保证玩家看到的状态始终新鲜。
function sweepExpiredListings(db, now = Date.now()) {
  db.prepare(`UPDATE avatar_market_listings SET status = 'EXPIRED', settled_at = ?
    WHERE status = 'ACTIVE' AND created_at <= ?`).run(now, now - LISTING_TTL_MS);
}

// 近 7 天有效成交（排除管理员撤回的 REVERTED）价格，取中位作为市场参考价。
export function marketReferencePrice(db, avatarId, now = Date.now()) {
  const prices = db.prepare(`SELECT l.price FROM avatar_market_listings l
    JOIN avatar_items i ON i.id = l.item_id
    WHERE i.avatar_id = ? AND l.status = 'SOLD' AND l.settled_at >= ?
    ORDER BY l.price ASC`).all(avatarId, now - LISTING_TTL_MS).map(row => row.price);
  if (!prices.length) return null;
  const middle = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[middle] : Math.round((prices[middle - 1] + prices[middle]) / 2);
}

export const COLLECTION_TITLES = Object.freeze([
  Object.freeze({ min: 51, title: '全图鉴收藏家' }),
  Object.freeze({ min: 45, title: '传奇馆主' }),
  Object.freeze({ min: 30, title: '头像鉴赏家' }),
  Object.freeze({ min: 15, title: '资深收藏家' }),
  Object.freeze({ min: 5, title: '初入藏馆' }),
]);

// 收藏数按不同头像种类计算，重复持有同款不增加等级。
export function collectionCount(db, accountId) {
  return db.prepare(`SELECT COUNT(DISTINCT avatar_id) AS count FROM avatar_items
    WHERE owner_account_id = ?`).get(accountId).count;
}

export function collectionTitle(count) {
  return COLLECTION_TITLES.find(entry => count >= entry.min)?.title ?? null;
}

export const SHOWCASE_SLOTS = 3;

export function showcase(db, accountId) {
  const row = db.prepare('SELECT showcase FROM accounts WHERE id = ?').get(accountId);
  let ids = [];
  try { ids = JSON.parse(row?.showcase ?? '[]'); } catch { ids = []; }
  if (!Array.isArray(ids)) ids = [];
  return {
    slots: SHOWCASE_SLOTS,
    items: ids.slice(0, SHOWCASE_SLOTS).map(avatarId => publicPrize(avatarId)).filter(Boolean),
  };
}

// 展柜只放自己拥有过的头像种类（曾拥有即可展示，重复款不重复占位）。
export function setShowcase(db, accountId, avatarIds) {
  requireThat(Array.isArray(avatarIds), '展柜数据格式不正确');
  requireThat(avatarIds.length <= SHOWCASE_SLOTS, `展柜最多 ${SHOWCASE_SLOTS} 个头像`);
  const unique = [...new Set(avatarIds)].slice(0, SHOWCASE_SLOTS);
  return db.transaction(() => {
    for (const avatarId of unique) {
      requireThat(prize(avatarId), '展柜里只能放宝箱头像');
      const owned = db.prepare('SELECT 1 FROM avatar_items WHERE owner_account_id = ? AND avatar_id = ? LIMIT 1')
        .get(accountId, avatarId);
      requireThat(owned, `你还没有获得过「${prize(avatarId).name}」`);
    }
    db.prepare('UPDATE accounts SET showcase = ? WHERE id = ?').run(JSON.stringify(unique), accountId);
    return showcase(db, accountId);
  })();
}

function openResult(row, balance, duplicate = false) {
  return {
    openId: row.id,
    cost: row.cost,
    won: Boolean(row.won),
    avatar: row.avatar_id ? publicPrize(row.avatar_id) : null,
    itemId: row.item_id ?? null,
    time: row.created_at,
    balance,
    ...(duplicate ? { duplicate: true } : {}),
  };
}

export function config() {
  return {
    price: BOX_PRICE,
    tenOpenCount: TEN_OPEN_COUNT,
    tenOpenPrice: TEN_OPEN_PRICE,
    winBasisPoints: WIN_BASIS_POINTS,
    basisPoints: BASIS_POINTS,
    winRate: WIN_BASIS_POINTS / BASIS_POINTS,
    marketFeeRate: MARKET_FEE_BASIS_POINTS / BASIS_POINTS,
    listingFeeRate: LISTING_FEE_BASIS_POINTS / BASIS_POINTS,
    listingTtlMs: LISTING_TTL_MS,
    prizes: globalThis.TONGZHUO_AVATARS.prizeItems.map(item => ({
      id: item.id,
      name: item.name,
      src: item.src,
      series: item.series,
      probability: WIN_BASIS_POINTS / BASIS_POINTS / globalThis.TONGZHUO_AVATARS.prizeItems.length,
    })),
  };
}

export function openTen(db, accountId, batchId) {
  requireThat(typeof batchId === 'string' && ID_PATTERN.test(batchId) && batchId.length <= 56, '请求格式不正确');
  const openIds = Array.from({ length: TEN_OPEN_COUNT }, (_, index) =>
    `${batchId}-${String(index + 1).padStart(2, '0')}`);
  return db.transaction(() => {
    const placeholders = openIds.map(() => '?').join(', ');
    const existing = db.prepare(`SELECT * FROM treasure_opens WHERE id IN (${placeholders})`).all(...openIds);
    if (existing.length) {
      requireThat(existing.length === TEN_OPEN_COUNT
        && existing.every(row => row.account_id === accountId), '十连开启请求发生冲突');
      const byId = new Map(existing.map(row => [row.id, row]));
      return {
        batchId,
        count: TEN_OPEN_COUNT,
        cost: TEN_OPEN_PRICE,
        draws: openIds.map(id => openResult(byId.get(id), null, true)),
        balance: balanceOf(db, accountId),
        duplicate: true,
      };
    }
    requireThat(balanceOf(db, accountId) >= TEN_OPEN_PRICE, '筹码余额不足');
    const draws = openIds.map(openId => {
      const { balance: _balance, ...draw } = openBox(db, accountId, openId);
      return draw;
    });
    return {
      batchId,
      count: TEN_OPEN_COUNT,
      cost: TEN_OPEN_PRICE,
      draws,
      balance: balanceOf(db, accountId),
    };
  })();
}

export function resolveDraw(hitRoll, avatarRoll) {
  requireThat(Number.isSafeInteger(hitRoll) && hitRoll >= 0 && hitRoll < BASIS_POINTS, '开奖随机数不正确');
  if (hitRoll >= WIN_BASIS_POINTS) return null;
  const prizes = globalThis.TONGZHUO_AVATARS.prizeItems;
  requireThat(Number.isSafeInteger(avatarRoll) && avatarRoll >= 0 && avatarRoll < prizes.length, '头像随机数不正确');
  return prizes[avatarRoll];
}

export function openBox(db, accountId, openId) {
  requireThat(typeof openId === 'string' && ID_PATTERN.test(openId), '请求格式不正确');
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM treasure_opens WHERE id = ? AND account_id = ?').get(openId, accountId);
    if (existing) return openResult(existing, balanceOf(db, accountId), true);
    const account = db.prepare('SELECT id, npc FROM accounts WHERE id = ?').get(accountId);
    requireThat(account, '账户不存在');
    requireThat(!account.npc, '系统账号不能开启头像宝箱');
    requireThat(balanceOf(db, accountId) >= BOX_PRICE, '筹码余额不足');

    const prizes = globalThis.TONGZHUO_AVATARS.prizeItems;
    const selected = resolveDraw(randomInt(BASIS_POINTS), randomInt(prizes.length));
    const itemId = selected ? randomUUID() : null;
    const createdAt = Date.now();
    credit(db, accountId, 'TREASURE_OPEN', -BOX_PRICE, 'treasure-open', openId);
    db.prepare(`INSERT INTO treasure_opens
      (id, account_id, cost, won, avatar_id, item_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(openId, accountId, BOX_PRICE, selected ? 1 : 0, selected?.id ?? null, itemId, createdAt);
    if (selected) {
      db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, source_open_id, acquired_at)
        VALUES (?, ?, ?, ?, ?)`).run(itemId, selected.id, accountId, openId, createdAt);
    }
    return openResult({
      id: openId,
      cost: BOX_PRICE,
      won: selected ? 1 : 0,
      avatar_id: selected?.id ?? null,
      item_id: itemId,
      created_at: createdAt,
    }, balanceOf(db, accountId));
  })();
}

function listingRow(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    avatar: publicPrize(row.avatar_id),
    seller: { id: row.seller_account_id, name: row.seller_name },
    buyer: row.buyer_account_id ? { id: row.buyer_account_id, name: row.buyer_name } : null,
    price: row.price,
    fee: row.fee,
    status: row.status,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

const LISTING_SELECT = `SELECT l.*, i.avatar_id, seller.name AS seller_name, buyer.name AS buyer_name
  FROM avatar_market_listings l
  JOIN avatar_items i ON i.id = l.item_id
  JOIN accounts seller ON seller.id = l.seller_account_id
  LEFT JOIN accounts buyer ON buyer.id = l.buyer_account_id`;

export function inventory(db, accountId) {
  sweepExpiredListings(db);
  const rows = db.prepare(`SELECT i.id, i.avatar_id, i.acquired_at,
      l.id AS listing_id, l.price AS listing_price
    FROM avatar_items i
    LEFT JOIN avatar_market_listings l ON l.item_id = i.id AND l.status = 'ACTIVE'
    WHERE i.owner_account_id = ?
    ORDER BY i.acquired_at DESC, i.id DESC`).all(accountId);
  return {
    items: rows.map(row => ({
      id: row.id,
      avatar: publicPrize(row.avatar_id),
      acquiredAt: row.acquired_at,
      listing: row.listing_id ? { id: row.listing_id, price: row.listing_price } : null,
    })),
  };
}

export function openHistory(db, accountId, limit = 30) {
  const size = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 30;
  return {
    opens: db.prepare(`SELECT * FROM treasure_opens WHERE account_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(accountId, size)
      .map(row => openResult(row, null)),
  };
}

export function activeListings(db, { avatarId = '', limit = 100 } = {}) {
  sweepExpiredListings(db);
  const size = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 100;
  const rows = avatarId
    ? db.prepare(`${LISTING_SELECT} WHERE l.status = 'ACTIVE' AND i.avatar_id = ?
        ORDER BY l.price ASC, l.created_at ASC LIMIT ?`).all(avatarId, size)
    : db.prepare(`${LISTING_SELECT} WHERE l.status = 'ACTIVE'
        ORDER BY l.price ASC, l.created_at ASC LIMIT ?`).all(size);
  return {
    listings: rows.map(row => ({ ...listingRow(row), referencePrice: marketReferencePrice(db, row.avatar_id) })),
  };
}

export function createListing(db, accountId, itemId, price) {
  sweepExpiredListings(db);
  requireThat(typeof itemId === 'string' && ID_PATTERN.test(itemId), '请选择要出售的头像');
  requireThat(Number.isSafeInteger(price) && price >= MIN_LISTING_PRICE,
    `售价不能低于 ${MIN_LISTING_PRICE.toLocaleString('zh-CN')}`);
  return db.transaction(() => {
    const account = db.prepare('SELECT avatar, npc FROM accounts WHERE id = ?').get(accountId);
    requireThat(account && !account.npc, '当前账号不能使用交易行');
    const listingFee = Math.max(1, Math.floor(price * LISTING_FEE_BASIS_POINTS / BASIS_POINTS));
    requireThat(balanceOf(db, accountId) >= listingFee, `筹码余额不足以支付上架费 ${listingFee.toLocaleString('zh-CN')}`);
    const activeCount = db.prepare(`SELECT COUNT(*) AS count FROM avatar_market_listings
      WHERE seller_account_id = ? AND status = 'ACTIVE'`).get(accountId).count;
    requireThat(activeCount < MAX_ACTIVE_LISTINGS, `最多同时上架 ${MAX_ACTIVE_LISTINGS} 件头像`);
    const item = db.prepare('SELECT * FROM avatar_items WHERE id = ? AND owner_account_id = ?').get(itemId, accountId);
    requireThat(item, '没有找到这份头像');
    const existing = db.prepare("SELECT 1 FROM avatar_market_listings WHERE item_id = ? AND status = 'ACTIVE'").get(itemId);
    requireThat(!existing, '这份头像已经上架');
    if (account.avatar === item.avatar_id) {
      const availableCopies = db.prepare(`SELECT COUNT(*) AS count FROM avatar_items i
        WHERE i.owner_account_id = ? AND i.avatar_id = ?
        AND NOT EXISTS (SELECT 1 FROM avatar_market_listings l WHERE l.item_id = i.id AND l.status = 'ACTIVE')`)
        .get(accountId, item.avatar_id).count;
      requireThat(availableCopies >= 2, '这是正在使用的最后一份头像，请先更换头像再出售');
    }
    const id = randomUUID();
    credit(db, accountId, 'MARKET_LISTING_FEE', -listingFee, 'avatar-market', id);
    db.prepare(`INSERT INTO avatar_market_listings
      (id, item_id, seller_account_id, price, fee, status, created_at, settled_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, NULL)`).run(id, itemId, accountId, price, listingFee, Date.now());
    return listingRow(db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(id));
  })();
}

export function cancelListing(db, accountId, listingId) {
  requireThat(typeof listingId === 'string' && ID_PATTERN.test(listingId), '订单格式不正确');
  return db.transaction(() => {
    const listing = db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(listingId);
    requireThat(listing && listing.status === 'ACTIVE', '这条商品已经下架或成交');
    requireThat(listing.seller_account_id === accountId, '只能下架自己的商品');
    db.prepare(`UPDATE avatar_market_listings SET status = 'CANCELLED', settled_at = ?
      WHERE id = ? AND status = 'ACTIVE'`).run(Date.now(), listingId);
    return { listingId, cancelled: true };
  })();
}

export function buyListing(db, accountId, listingId) {
  requireThat(typeof listingId === 'string' && ID_PATTERN.test(listingId), '订单格式不正确');
  return db.transaction(() => {
    const listing = db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(listingId);
    requireThat(listing, '这件头像已经售出或下架');
    if (listing.status === 'SOLD' && listing.buyer_account_id === accountId) {
      return {
        listingId,
        itemId: listing.item_id,
        avatar: publicPrize(listing.avatar_id),
        price: listing.price,
        fee: listing.fee,
        proceeds: listing.price - listing.fee,
        balance: balanceOf(db, accountId),
        sellerAccountId: listing.seller_account_id,
        sellerAvatarReset: false,
        duplicate: true,
      };
    }
    requireThat(listing.status === 'ACTIVE', '这件头像已经售出或下架');
    requireThat(listing.seller_account_id !== accountId, '不能购买自己上架的头像');
    const buyer = db.prepare('SELECT id, npc FROM accounts WHERE id = ?').get(accountId);
    requireThat(buyer && !buyer.npc, '当前账号不能使用交易行');
    requireThat(balanceOf(db, accountId) >= listing.price, '筹码余额不足');
    const fee = Math.floor(listing.price * MARKET_FEE_BASIS_POINTS / BASIS_POINTS);
    const proceeds = listing.price - fee;
    const changed = db.prepare(`UPDATE avatar_market_listings
      SET status = 'SOLD', buyer_account_id = ?, fee = ?, settled_at = ?
      WHERE id = ? AND status = 'ACTIVE'`).run(accountId, fee, Date.now(), listingId);
    requireThat(changed.changes === 1, '这件头像刚刚被其他玩家买走了');
    credit(db, accountId, 'MARKET_BUY', -listing.price, 'avatar-market', listingId);
    credit(db, listing.seller_account_id, 'MARKET_SALE', proceeds, 'avatar-market', listingId);
    db.prepare('UPDATE avatar_items SET owner_account_id = ?, acquired_at = ? WHERE id = ?')
      .run(accountId, Date.now(), listing.item_id);
    const sellerAvatarReset = Boolean(
      db.prepare('SELECT avatar FROM accounts WHERE id = ?').get(listing.seller_account_id)?.avatar === listing.avatar_id
      && db.prepare('SELECT COUNT(*) AS count FROM avatar_items WHERE owner_account_id = ? AND avatar_id = ?')
        .get(listing.seller_account_id, listing.avatar_id).count === 0
    );
    if (sellerAvatarReset) {
      db.prepare('UPDATE accounts SET avatar = NULL WHERE id = ?').run(listing.seller_account_id);
    }
    return {
      listingId,
      itemId: listing.item_id,
      avatar: publicPrize(listing.avatar_id),
      price: listing.price,
      fee,
      proceeds,
      balance: balanceOf(db, accountId),
      sellerAccountId: listing.seller_account_id,
      sellerAvatarReset,
    };
  })();
}

export function marketHistory(db, accountId, limit = 50) {
  const size = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
  const rows = db.prepare(`${LISTING_SELECT}
    WHERE l.status = 'SOLD' AND (l.seller_account_id = ? OR l.buyer_account_id = ?)
    ORDER BY l.settled_at DESC, l.id DESC LIMIT ?`).all(accountId, accountId, size);
  return { trades: rows.map(listingRow) };
}

// ---------- 头像图鉴 ----------

// 全部奖品头像 + 当前玩家拥有情况 + 市场参考价/在售数量，供图鉴页展示。
export function gallery(db, accountId) {
  sweepExpiredListings(db);
  const owned = db.prepare(`SELECT avatar_id, COUNT(*) AS count FROM avatar_items
    WHERE owner_account_id = ? GROUP BY avatar_id`).all(accountId);
  const ownedMap = new Map(owned.map(row => [row.avatar_id, row.count]));
  const market = db.prepare(`SELECT i.avatar_id, COUNT(*) AS listings, MIN(l.price) AS lowest
    FROM avatar_market_listings l JOIN avatar_items i ON i.id = l.item_id
    WHERE l.status = 'ACTIVE' GROUP BY i.avatar_id`).all();
  const marketMap = new Map(market.map(row => [row.avatar_id, row]));
  return {
    total: globalThis.TONGZHUO_AVATARS.prizeItems.length,
    entries: globalThis.TONGZHUO_AVATARS.prizeItems.map(item => {
      const count = ownedMap.get(item.id) ?? 0;
      const marketRow = marketMap.get(item.id);
      return {
        avatar: { id: item.id, name: item.name, src: item.src, series: item.series },
        owned: count > 0,
        count,
        referencePrice: marketReferencePrice(db, item.id),
        activeListings: marketRow?.listings ?? 0,
        lowestPrice: marketRow?.lowest ?? null,
      };
    }),
  };
}

// ---------- 管理员交易监管 ----------

// 强制下架：头像退回卖家，上架费不退；必须填写原因并留审计。
export function adminForceDelist(db, listingId, reason) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  requireThat(trimmed.length > 0, '请填写下架原因');
  requireThat([...trimmed].length <= 100, '下架原因最多 100 个字');
  sweepExpiredListings(db);
  return db.transaction(() => {
    const listing = db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(listingId);
    requireThat(listing, '没有找到这条订单');
    requireThat(listing.status === 'ACTIVE', '只有进行中的商品可以强制下架');
    db.prepare(`UPDATE avatar_market_listings SET status = 'CANCELLED', settled_at = ?
      WHERE id = ? AND status = 'ACTIVE'`).run(Date.now(), listingId);
    return { listingId, avatar: publicPrize(listing.avatar_id), sellerId: listing.seller_account_id, reason: trimmed };
  })();
}

// 撤回成交：买家原路退款，头像从买家回收进系统账号（不再流通），
// 卖家已到账收入原路扣回（余额不足时扣到 0 为止）；必须填写原因并留审计。
export function adminRevertTrade(db, listingId, reason) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  requireThat(trimmed.length > 0, '请填写撤回原因');
  requireThat([...trimmed].length <= 100, '撤回原因最多 100 个字');
  return db.transaction(() => {
    const listing = db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(listingId);
    requireThat(listing, '没有找到这条订单');
    requireThat(listing.status === 'SOLD', '只有已成交的订单可以撤回');
    const changed = db.prepare(`UPDATE avatar_market_listings SET status = 'REVERTED', settled_at = ?
      WHERE id = ? AND status = 'SOLD'`).run(Date.now(), listingId);
    requireThat(changed.changes === 1, '这条订单刚刚被处理过');
    credit(db, listing.buyer_account_id, 'MARKET_REVERT', listing.price, 'avatar-market', listingId);
    const sellerBalance = balanceOf(db, listing.seller_account_id);
    const clawback = Math.min(sellerBalance, listing.price - listing.fee);
    if (clawback > 0) {
      credit(db, listing.seller_account_id, 'MARKET_REVERT', -clawback, 'avatar-market', listingId);
    }
    const reclaim = reclaimAccount(db);
    db.prepare('UPDATE avatar_items SET owner_account_id = ?, acquired_at = ? WHERE id = ?')
      .run(reclaim, Date.now(), listing.item_id);
    const buyerAvatarReset = Boolean(
      db.prepare('SELECT avatar FROM accounts WHERE id = ?').get(listing.buyer_account_id)?.avatar === listing.avatar_id
      && db.prepare('SELECT COUNT(*) AS count FROM avatar_items WHERE owner_account_id = ? AND avatar_id = ?')
        .get(listing.buyer_account_id, listing.avatar_id).count === 0
    );
    if (buyerAvatarReset) {
      db.prepare('UPDATE accounts SET avatar = NULL WHERE id = ?').run(listing.buyer_account_id);
    }
    return {
      listingId,
      avatar: publicPrize(listing.avatar_id),
      buyerId: listing.buyer_account_id,
      refunded: listing.price,
      sellerClawback: clawback,
      reclaimedBy: reclaim,
      reason: trimmed,
    };
  })();
}

// 回收头像统一转入隐藏的 NPC 系统账号：物品不再流通，但保留来源可追溯。
function reclaimAccount(db) {
  const existing = db.prepare('SELECT id FROM accounts WHERE name = ?').get('system-reclaim');
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(`INSERT INTO accounts (id, name, password_hash, created_at, is_banned, npc)
    VALUES (?, ?, ?, ?, 0, 1)`).run(id, 'system-reclaim', 'reclaim', Date.now());
  db.prepare('INSERT INTO wallets (account_id, balance) VALUES (?, 0)').run(id);
  return id;
}
