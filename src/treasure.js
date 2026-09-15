import { randomInt, randomUUID } from 'node:crypto';
import { GameError } from './errors.js';
import { balanceOf, credit } from './wallet.js';
import '../public/avatar-catalog.js';

export const BOX_PRICE = 5000;
export const TEN_OPEN_COUNT = 10;
export const TEN_OPEN_PRICE = BOX_PRICE * TEN_OPEN_COUNT;
export const WIN_BASIS_POINTS = 1000;
export const BASIS_POINTS = 10000;
export const MARKET_FEE_BASIS_POINTS = 1000;
export const MIN_LISTING_PRICE = 1000;
export const MAX_LISTING_PRICE = 10000000;
export const MAX_ACTIVE_LISTINGS = 10;

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
  const size = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 100;
  const rows = avatarId
    ? db.prepare(`${LISTING_SELECT} WHERE l.status = 'ACTIVE' AND i.avatar_id = ?
        ORDER BY l.price ASC, l.created_at ASC LIMIT ?`).all(avatarId, size)
    : db.prepare(`${LISTING_SELECT} WHERE l.status = 'ACTIVE'
        ORDER BY l.price ASC, l.created_at ASC LIMIT ?`).all(size);
  return { listings: rows.map(listingRow) };
}

export function createListing(db, accountId, itemId, price) {
  requireThat(typeof itemId === 'string' && ID_PATTERN.test(itemId), '请选择要出售的头像');
  requireThat(Number.isSafeInteger(price) && price >= MIN_LISTING_PRICE && price <= MAX_LISTING_PRICE,
    `售价需要是 ${MIN_LISTING_PRICE.toLocaleString('zh-CN')}–${MAX_LISTING_PRICE.toLocaleString('zh-CN')} 之间的整数`);
  return db.transaction(() => {
    const account = db.prepare('SELECT avatar, npc FROM accounts WHERE id = ?').get(accountId);
    requireThat(account && !account.npc, '当前账号不能使用交易行');
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
    db.prepare(`INSERT INTO avatar_market_listings
      (id, item_id, seller_account_id, price, fee, status, created_at)
      VALUES (?, ?, ?, ?, 0, 'ACTIVE', ?)`).run(id, itemId, accountId, price, Date.now());
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
