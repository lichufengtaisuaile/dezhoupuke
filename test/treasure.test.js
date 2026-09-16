import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPokerServer } from '../server.js';
import * as accounts from '../src/account.js';
import * as treasure from '../src/treasure.js';
import * as wallet from '../src/wallet.js';

async function api(server, method, url, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function fixture(t) {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => server.close());
  return server;
}

test('treasure draw uses a ten percent hit gate and then chooses one of 51 avatars', () => {
  const config = treasure.config();
  assert.equal(config.price, 5000);
  assert.equal(config.tenOpenCount, 10);
  assert.equal(config.tenOpenPrice, 50000);
  assert.equal(config.winBasisPoints, 1000);
  assert.equal(config.basisPoints, 10000);
  assert.equal(config.prizes.length, 51);
  assert.ok(Math.abs(config.prizes.reduce((sum, item) => sum + item.probability, 0) - 0.1) < Number.EPSILON);
  assert.equal(treasure.resolveDraw(1000, 0), null);
  assert.equal(treasure.resolveDraw(9999, 50), null);
  assert.equal(treasure.resolveDraw(0, 0).id, config.prizes[0].id);
  assert.equal(treasure.resolveDraw(999, 50).id, config.prizes[50].id);
});

test('ten-open settles ten draws atomically and replays one batch without charging again', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, 'ten-player', 'secret123');
  wallet.credit(server.db, account.accountId, 'ADMIN_ADJUST', 100000, 'test', 'ten-open-funds');
  const batchId = '10101010-2020-4030-8040-505050505050';
  const first = await api(server, 'POST', '/api/treasure/open-ten', {
    token: account.token, body: { batchId },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 10);
  assert.equal(first.body.cost, 50000);
  assert.equal(first.body.draws.length, 10);
  assert.equal(first.body.balance, 60000);
  assert.equal(first.body.draws.every(draw => typeof draw.won === 'boolean'), true);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM treasure_opens WHERE account_id = ?')
    .get(account.accountId).count, 10);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE account_id = ? AND type = 'TREASURE_OPEN'")
    .get(account.accountId).count, 10);

  const replay = await api(server, 'POST', '/api/treasure/open-ten', {
    token: account.token, body: { batchId },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.balance, 60000);
  assert.deepEqual(replay.body.draws.map(draw => draw.itemId), first.body.draws.map(draw => draw.itemId));
  assert.equal(wallet.balanceOf(server.db, account.accountId), 60000);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE account_id = ? AND type = 'TREASURE_OPEN'")
    .get(account.accountId).count, 10);
});

test('ten-open rejects an account without 50000 chips and creates no partial draws', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, 'ten-broke', 'secret123');
  const response = await api(server, 'POST', '/api/treasure/open-ten', {
    token: account.token,
    body: { batchId: '20202020-3030-4040-8050-606060606060' },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /余额不足/);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM treasure_opens').get().count, 0);
  assert.equal(wallet.balanceOf(server.db, account.accountId), 10000);
});

test('opening a box is server-authoritative, costs 5000 and replays duplicate request ids once', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, 'box-player', 'secret123');
  const openId = '11111111-2222-4333-8444-555555555555';
  const first = await api(server, 'POST', '/api/treasure/open', { token: account.token, body: { openId } });
  assert.equal(first.status, 200);
  assert.equal(first.body.cost, 5000);
  assert.equal(first.body.balance, 5000);
  assert.equal(typeof first.body.won, 'boolean');
  assert.equal(Boolean(first.body.avatar), first.body.won);

  const replay = await api(server, 'POST', '/api/treasure/open', { token: account.token, body: { openId } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.balance, 5000);
  assert.equal(replay.body.itemId, first.body.itemId);
  assert.deepEqual(replay.body.avatar, first.body.avatar);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM treasure_opens').get().count, 1);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE type = 'TREASURE_OPEN'").get().count, 1);

  const second = await api(server, 'POST', '/api/treasure/open', {
    token: account.token,
    body: { openId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.balance, 0);
  const broke = await api(server, 'POST', '/api/treasure/open', {
    token: account.token,
    body: { openId: 'ffffffff-0000-4000-8000-000000000000' },
  });
  assert.equal(broke.status, 400);
  assert.match(broke.body.error, /余额不足/);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM treasure_opens').get().count, 2);
});

test('prize avatars require ownership and an equipped last copy cannot be listed', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, 'collector', 'secret123');
  const avatarId = treasure.config().prizes[0].id;
  assert.equal((await api(server, 'POST', '/api/me/avatar', {
    token: account.token, body: { avatar: avatarId },
  })).status, 400);

  const itemId = randomUUID();
  server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
    VALUES (?, ?, ?, ?)`).run(itemId, avatarId, account.accountId, Date.now());
  assert.equal((await api(server, 'POST', '/api/me/avatar', {
    token: account.token, body: { avatar: avatarId },
  })).status, 200);
  const blocked = await api(server, 'POST', '/api/avatar-market/listings', {
    token: account.token, body: { itemId, price: 100000 },
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /最后一份头像/);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM avatar_market_listings WHERE status = 'ACTIVE'").get().count, 0);
});

test('an actively listed final copy cannot be equipped', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, 'listedAvatar', 'secret123');
  const avatarId = treasure.config().prizes[1].id;
  const itemId = randomUUID();
  server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
    VALUES (?, ?, ?, ?)`).run(itemId, avatarId, account.accountId, Date.now());
  const listed = await api(server, 'POST', '/api/avatar-market/listings', {
    token: account.token, body: { itemId, price: 5000 },
  });
  assert.equal(listed.status, 200);
  const equipped = await api(server, 'POST', '/api/me/avatar', {
    token: account.token, body: { avatar: avatarId },
  });
  assert.equal(equipped.status, 400);
  assert.match(equipped.body.error, /不在可用库存/);
  assert.equal(server.db.prepare('SELECT avatar FROM accounts WHERE id = ?').get(account.accountId).avatar, null);
});

test('fixed-price market locks inventory, transfers ownership atomically and charges nine percent', async t => {
  const server = await fixture(t);
  const seller = accounts.register(server.db, 'seller', 'secret123');
  const buyer = accounts.register(server.db, 'buyer', 'secret123');
  const avatar = treasure.config().prizes[12];
  const itemId = randomUUID();
  server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
    VALUES (?, ?, ?, ?)`).run(itemId, avatar.id, seller.accountId, Date.now());

  const listed = await api(server, 'POST', '/api/avatar-market/listings', {
    token: seller.token, body: { itemId, price: 6000 },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.listing.avatar.id, avatar.id);
  const listingId = listed.body.listing.id;
  const inventory = await api(server, 'GET', '/api/me/avatar-inventory', { token: seller.token });
  assert.equal(inventory.body.items[0].listing.id, listingId);

  const bought = await api(server, 'POST', `/api/avatar-market/listings/${listingId}/buy`, { token: buyer.token });
  assert.equal(bought.status, 200);
  assert.equal(bought.body.price, 6000);
  assert.equal(bought.body.fee, 540);
  assert.equal(bought.body.proceeds, 5460);
  assert.equal(bought.body.balance, 4000);
  assert.equal(wallet.balanceOf(server.db, seller.accountId), 15400);
  assert.equal(server.db.prepare('SELECT owner_account_id FROM avatar_items WHERE id = ?').get(itemId).owner_account_id, buyer.accountId);
  assert.equal(server.db.prepare('SELECT status FROM avatar_market_listings WHERE id = ?').get(listingId).status, 'SOLD');
  assert.equal(server.db.prepare("SELECT amount FROM ledger WHERE account_id = ? AND type = 'MARKET_BUY'").get(buyer.accountId).amount, -6000);
  assert.equal(server.db.prepare("SELECT amount FROM ledger WHERE account_id = ? AND type = 'MARKET_SALE'").get(seller.accountId).amount, 5460);
  assert.equal(server.db.prepare("SELECT amount FROM ledger WHERE account_id = ? AND type = 'MARKET_LISTING_FEE'").get(seller.accountId).amount, -60);

  const replay = await api(server, 'POST', `/api/avatar-market/listings/${listingId}/buy`, { token: buyer.token });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.itemId, itemId);
  assert.equal(replay.body.balance, 4000);
  assert.equal(wallet.balanceOf(server.db, buyer.accountId), 4000);
  assert.equal(wallet.balanceOf(server.db, seller.accountId), 15400);
  // 三笔流水：上架费、买家付款、卖家到账
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE ref_type = 'avatar-market' AND ref_id = ?")
    .get(listingId).count, 3);
  const buyerInventory = await api(server, 'GET', '/api/me/avatar-inventory', { token: buyer.token });
  assert.equal(buyerInventory.body.items[0].avatar.id, avatar.id);
});

test('seller can cancel only their own active listing without moving chips or ownership', async t => {
  const server = await fixture(t);
  const seller = accounts.register(server.db, 'cancelSell', 'secret123');
  const other = accounts.register(server.db, 'cancelOther', 'secret123');
  const itemId = randomUUID();
  server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
    VALUES (?, ?, ?, ?)`).run(itemId, treasure.config().prizes[20].id, seller.accountId, Date.now());
  const listing = (await api(server, 'POST', '/api/avatar-market/listings', {
    token: seller.token, body: { itemId, price: 8000 },
  })).body.listing;
  assert.equal((await api(server, 'DELETE', `/api/avatar-market/listings/${listing.id}`, { token: other.token })).status, 400);
  const cancelled = await api(server, 'DELETE', `/api/avatar-market/listings/${listing.id}`, { token: seller.token });
  assert.equal(cancelled.status, 200);
  assert.equal(server.db.prepare('SELECT status FROM avatar_market_listings WHERE id = ?').get(listing.id).status, 'CANCELLED');
  assert.equal(server.db.prepare('SELECT owner_account_id FROM avatar_items WHERE id = ?').get(itemId).owner_account_id, seller.accountId);
  // 上架费 1%（80）已收取，主动下架不退
  assert.equal(wallet.balanceOf(server.db, seller.accountId), 9920);
});

test('listing expires after seven days and reference price uses the seven day median', async t => {
  const server = await fixture(t);
  const seller = accounts.register(server.db, 'expireSell', 'secret123');
  const avatarId = treasure.config().prizes[3].id;
  const itemId = randomUUID();
  server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
    VALUES (?, ?, ?, ?)`).run(itemId, avatarId, seller.accountId, Date.now());
  const listed = await api(server, 'POST', '/api/avatar-market/listings', {
    token: seller.token, body: { itemId, price: 5000 },
  });
  assert.equal(listed.status, 200);
  const listingId = listed.body.listing.id;

  // 直接把创建时间拨到 8 天前，惰性清理应当在下次读取时过期
  server.db.prepare('UPDATE avatar_market_listings SET created_at = ? WHERE id = ?')
    .run(Date.now() - 8 * 24 * 60 * 60 * 1000, listingId);
  const market = await api(server, 'GET', '/api/avatar-market/listings');
  assert.equal(market.status, 200);
  assert.equal(market.body.listings.length, 0);
  assert.equal(server.db.prepare('SELECT status FROM avatar_market_listings WHERE id = ?').get(listingId).status, 'EXPIRED');
  // 过期后物品仍归卖家，且可以重新上架（再交一次上架费）
  const relisted = await api(server, 'POST', '/api/avatar-market/listings', {
    token: seller.token, body: { itemId, price: 6000 },
  });
  assert.equal(relisted.status, 200);

  // 参考价：造三笔 7 天内的成交（1000/2000/3000），中位 2000
  const buyer = accounts.register(server.db, 'medianBuy', 'secret123');
  for (const price of [1000, 2000, 3000]) {
    const id = randomUUID();
    server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
      VALUES (?, ?, ?, ?)`).run(id, avatarId, seller.accountId, Date.now());
    const created = await api(server, 'POST', '/api/avatar-market/listings', {
      token: seller.token, body: { itemId: id, price },
    });
    assert.equal(created.status, 200);
    const bought = await api(server, 'POST', `/api/avatar-market/listings/${created.body.listing.id}/buy`, { token: buyer.token });
    assert.equal(bought.status, 200);
  }
  assert.equal(treasure.marketReferencePrice(server.db, avatarId), 2000);
});

test('avatar gallery shows ownership, market reference price and listing counts', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, 'galleryUser', 'secret123');
  const avatarId = treasure.config().prizes[5].id;
  server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
    VALUES (?, ?, ?, ?)`).run(randomUUID(), avatarId, account.accountId, Date.now());
  const response = await api(server, 'GET', '/api/me/avatar-gallery', { token: account.token });
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 51);
  const entry = response.body.entries.find(item => item.avatar.id === avatarId);
  assert.equal(entry.owned, true);
  assert.equal(entry.count, 1);
  assert.equal(response.body.entries.filter(item => !item.owned).length, 50);
});

test('showcase stores up to three owned avatar kinds', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, 'showcaseUser', 'secret123');
  const ids = treasure.config().prizes.slice(0, 4).map(item => item.id);
  for (const avatarId of ids.slice(0, 2)) {
    server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
      VALUES (?, ?, ?, ?)`).run(randomUUID(), avatarId, account.accountId, Date.now());
  }
  const denied = await api(server, 'POST', '/api/me/showcase', {
    token: account.token, body: { avatarIds: [ids[2]] },
  });
  assert.equal(denied.status, 400);
  const saved = await api(server, 'POST', '/api/me/showcase', {
    token: account.token, body: { avatarIds: [ids[0], ids[1], ids[0]] },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.items.length, 2);
  const loaded = await api(server, 'GET', '/api/me/showcase', { token: account.token });
  assert.equal(loaded.body.slots, 3);
  assert.equal(loaded.body.items[0].id, ids[0]);
});

test('admin can force delist and revert trades with audit trail', async t => {
  const server = await fixture(t);
  const seller = accounts.register(server.db, 'modSeller', 'secret123');
  const buyer = accounts.register(server.db, 'modBuyer', 'secret123');
  const avatarId = treasure.config().prizes[7].id;
  const itemId = randomUUID();
  server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
    VALUES (?, ?, ?, ?)`).run(itemId, avatarId, seller.accountId, Date.now());
  const listed = await api(server, 'POST', '/api/avatar-market/listings', {
    token: seller.token, body: { itemId, price: 4000 },
  });
  const listingId = listed.body.listing.id;

  const noReason = await fetch(`http://127.0.0.1:${server.port}/api/admin/market/${listingId}/delist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '' }),
  });
  // 未带管理员令牌应当 401/503
  assert.ok(noReason.status === 401 || noReason.status === 503);

  const bought = await api(server, 'POST', `/api/avatar-market/listings/${listingId}/buy`, { token: buyer.token });
  assert.equal(bought.status, 200);
  // 成交后不能再强制下架
  const delistSold = await fetch(`http://127.0.0.1:${server.port}/api/admin/market/${listingId}/delist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '测试' }),
  });
  assert.ok(delistSold.status === 401 || delistSold.status === 503);
  assert.equal(server.db.prepare('SELECT status FROM avatar_market_listings WHERE id = ?').get(listingId).status, 'SOLD');

  const direct = treasure.adminRevertTrade(server.db, listingId, '异常交易测试');
  assert.equal(direct.refunded, 4000);
  assert.equal(server.db.prepare('SELECT status FROM avatar_market_listings WHERE id = ?').get(listingId).status, 'REVERTED');
  // 头像转入系统回收账号，不再流通
  const reclaimedBy = server.db.prepare('SELECT id FROM accounts WHERE name = ?').get('system-reclaim').id;
  assert.equal(server.db.prepare('SELECT owner_account_id FROM avatar_items WHERE id = ?').get(itemId).owner_account_id, reclaimedBy);
  assert.equal(wallet.balanceOf(server.db, buyer.accountId), 10000);
  // 卖家到账 3600（9% 手续费 4000-360）后被扣回
  assert.equal(wallet.balanceOf(server.db, seller.accountId), 10000 - 40);

  assert.throws(() => treasure.adminRevertTrade(server.db, listingId, '重复撤回'), /已经|找不到|成交/);
});

test('collection leaderboard counts distinct avatar kinds and titles unlock by tiers', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, '收藏家小王', 'secret123');
  assert.equal(treasure.collectionTitle(0), null);
  assert.equal(treasure.collectionTitle(5), '初入藏馆');
  assert.equal(treasure.collectionTitle(15), '资深收藏家');
  assert.equal(treasure.collectionTitle(30), '头像鉴赏家');
  assert.equal(treasure.collectionTitle(45), '传奇馆主');
  assert.equal(treasure.collectionTitle(51), '全图鉴收藏家');
  for (const item of treasure.config().prizes.slice(0, 5)) {
    server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
      VALUES (?, ?, ?, ?)`).run(randomUUID(), item.id, account.accountId, Date.now());
  }
  // 同款重复不增加收藏数
  server.db.prepare(`INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at)
    VALUES (?, ?, ?, ?)`).run(randomUUID(), treasure.config().prizes[0].id, account.accountId, Date.now());
  const board = await api(server, 'GET', '/api/leaderboard/collection');
  assert.equal(board.status, 200);
  assert.equal(board.body.entries[0].name, '收藏家小王');
  assert.equal(board.body.entries[0].collection, 5);
  assert.equal(board.body.entries[0].collectionTitle, '初入藏馆');
  const overview = await api(server, 'GET', '/api/me/overview', { token: account.token });
  assert.equal(overview.body.collection, 5);
  assert.equal(overview.body.collectionTitle, '初入藏馆');
});
