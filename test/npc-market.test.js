import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPokerServer } from '../server.js';
import * as accounts from '../src/account.js';
import * as wallet from '../src/wallet.js';
import * as treasure from '../src/treasure.js';
import { npcMarketTick } from '../src/npc-market.js';

async function fixture(t) {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => server.close());
  return server;
}

function registerNpc(db, name) {
  const account = accounts.register(db, name, 'npc-secret');
  db.prepare('UPDATE accounts SET npc = 1 WHERE id = ?').run(account.accountId);
  return account;
}

function grantAvatar(db, accountId, avatarId) {
  db.prepare('INSERT INTO avatar_items (id, avatar_id, owner_account_id, acquired_at) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), avatarId, accountId, Date.now());
}

test('npc market tick opens boxes within daily and balance limits', async t => {
  const server = await fixture(t);
  const npc = registerNpc(server.db, 'npc开户员');
  wallet.credit(server.db, npc.accountId, 'ADMIN_ADJUST', 2000000, 'test', 'npc-funds');
  // 每次 tick 25% 概率，跑 40 次足以触发多次，但不会超过每日 5 次上限。
  for (let i = 0; i < 40; i += 1) npcMarketTick(server.db, { npcIds: [npc.accountId] });
  const opens = server.db.prepare('SELECT COUNT(*) AS count FROM treasure_opens WHERE account_id = ?')
    .get(npc.accountId).count;
  assert.ok(opens > 0, 'NPC 应该开过宝箱');
  assert.ok(opens <= 5, '每日开箱不能超过上限');
  const items = server.db.prepare('SELECT COUNT(*) AS count FROM avatar_items WHERE owner_account_id = ?')
    .get(npc.accountId).count;
  assert.ok(items <= opens, '头像库存不超过开箱次数');
});

test('npc lists duplicate avatars but keeps its only copy', async t => {
  const server = await fixture(t);
  const npc = registerNpc(server.db, 'npc收藏家');
  wallet.credit(server.db, npc.accountId, 'ADMIN_ADJUST', 2000000, 'test', 'npc-funds');
  const prize = treasure.config().prizes[0];
  grantAvatar(server.db, npc.accountId, prize.id);
  grantAvatar(server.db, npc.accountId, prize.id);
  npcMarketTick(server.db, { npcIds: [npc.accountId] });
  const listings = server.db.prepare(`SELECT COUNT(*) AS count FROM avatar_market_listings
    WHERE seller_account_id = ? AND status = 'ACTIVE'`).get(npc.accountId).count;
  assert.equal(listings, 1, '两件同款应该上架一件，留一件收藏');
  npcMarketTick(server.db, { npcIds: [npc.accountId] });
  const after = server.db.prepare(`SELECT COUNT(*) AS count FROM avatar_market_listings
    WHERE seller_account_id = ? AND status = 'ACTIVE'`).get(npc.accountId).count;
  assert.equal(after, 1, '剩下的唯一库存不能再上架');
});

test('npc skips listings without reference price and buys clearly discounted ones', async t => {
  const server = await fixture(t);
  const npc = registerNpc(server.db, 'npc捡漏王');
  const player = accounts.register(server.db, 'mkseller', 'secret123');
  wallet.credit(server.db, npc.accountId, 'ADMIN_ADJUST', 2000000, 'test', 'npc-funds');
  wallet.credit(server.db, player.accountId, 'ADMIN_ADJUST', 200000, 'test', 'player-funds');
  const prize = treasure.config().prizes[0];
  // 玩家挂一个 5000 的低价商品，但还没有任何成交记录 → 无参考价，NPC 不买。
  grantAvatar(server.db, player.accountId, prize.id);
  grantAvatar(server.db, player.accountId, prize.id);
  const playerItems = server.db.prepare('SELECT id FROM avatar_items WHERE owner_account_id = ? ORDER BY acquired_at')
    .all(player.accountId);
  treasure.createListing(server.db, player.accountId, playerItems[1].id, 5000);
  const summary = npcMarketTick(server.db, { npcIds: [npc.accountId] });
  assert.equal(summary.bought, 0, '无参考价时 NPC 不盲买');
  // 伪造一条同头像的历史成交（12000），让参考价生效；5000 < 12000*0.8=9600，构成捡漏。
  const holder = accounts.register(server.db, 'histholder', 'secret123');
  grantAvatar(server.db, holder.accountId, prize.id);
  const holderItem = server.db.prepare('SELECT id FROM avatar_items WHERE owner_account_id = ?')
    .get(holder.accountId);
  server.db.prepare(`INSERT INTO avatar_market_listings
    (id, item_id, seller_account_id, price, fee, status, created_at, settled_at)
    VALUES (?, ?, ?, 12000, 0, 'SOLD', ?, ?)`)
    .run(randomUUID(), holderItem.id, holder.accountId, Date.now() - 60000, Date.now() - 30000);
  let bought = 0;
  for (let i = 0; i < 5 && bought === 0; i += 1) {
    bought += npcMarketTick(server.db, { npcIds: [npc.accountId] }).bought;
  }
  assert.ok(bought >= 1, '有参考价后 NPC 应该捡漏低价商品');
  const owner = server.db.prepare('SELECT owner_account_id FROM avatar_items WHERE id = ?')
    .get(playerItems[1].id).owner_account_id;
  assert.equal(owner, npc.accountId, '商品所有权应转给 NPC');
});
