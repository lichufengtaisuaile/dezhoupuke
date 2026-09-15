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

test('fixed-price market locks inventory, transfers ownership atomically and removes ten percent', async t => {
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
  assert.equal(bought.body.fee, 600);
  assert.equal(bought.body.proceeds, 5400);
  assert.equal(bought.body.balance, 4000);
  assert.equal(wallet.balanceOf(server.db, seller.accountId), 15400);
  assert.equal(server.db.prepare('SELECT owner_account_id FROM avatar_items WHERE id = ?').get(itemId).owner_account_id, buyer.accountId);
  assert.equal(server.db.prepare('SELECT status FROM avatar_market_listings WHERE id = ?').get(listingId).status, 'SOLD');
  assert.equal(server.db.prepare("SELECT amount FROM ledger WHERE account_id = ? AND type = 'MARKET_BUY'").get(buyer.accountId).amount, -6000);
  assert.equal(server.db.prepare("SELECT amount FROM ledger WHERE account_id = ? AND type = 'MARKET_SALE'").get(seller.accountId).amount, 5400);

  const replay = await api(server, 'POST', `/api/avatar-market/listings/${listingId}/buy`, { token: buyer.token });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.itemId, itemId);
  assert.equal(replay.body.balance, 4000);
  assert.equal(wallet.balanceOf(server.db, buyer.accountId), 4000);
  assert.equal(wallet.balanceOf(server.db, seller.accountId), 15400);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE ref_type = 'avatar-market' AND ref_id = ?")
    .get(listingId).count, 2);
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
  assert.equal(wallet.balanceOf(server.db, seller.accountId), 10000);
});
