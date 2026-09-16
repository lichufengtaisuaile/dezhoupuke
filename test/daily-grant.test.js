import assert from 'node:assert/strict';
import test from 'node:test';
import { createPokerServer } from '../server.js';
import * as accounts from '../src/account.js';
import * as wallet from '../src/wallet.js';
import { DAILY_GRANT_AMOUNT, grantDailySubsidy, nextGrantTime } from '../src/daily-grant.js';

async function fixture(t) {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => server.close());
  return server;
}

test('nextGrantTime lands on 0:00 or 18:00', () => {
  // 2026-09-16 13:00 本地时间
  const noon = new Date(2026, 8, 16, 13, 0, 0).getTime();
  const next = new Date(nextGrantTime(noon));
  assert.equal(next.getHours(), 18);
  assert.equal(next.getDate(), 16);
  // 19:00 → 明天 0:00
  const evening = new Date(2026, 8, 16, 19, 0, 0).getTime();
  const tomorrow = new Date(nextGrantTime(evening));
  assert.equal(tomorrow.getHours(), 0);
  assert.equal(tomorrow.getDate(), 17);
  // 0:30 → 当天 18:00
  const early = new Date(2026, 8, 16, 0, 30, 0).getTime();
  assert.equal(new Date(nextGrantTime(early)).getHours(), 18);
});

test('daily grant credits every account including npc and is idempotent per batch', async t => {
  const server = await fixture(t);
  const player = accounts.register(server.db, 'grant-player', 'secret123');
  const npc = accounts.register(server.db, 'grant-npc', 'secret123');
  server.db.prepare('UPDATE accounts SET npc = 1 WHERE id = ?').run(npc.accountId);
  wallet.credit(server.db, player.accountId, 'ADMIN_ADJUST', 5000, 'test', 'p-seed');

  // 模拟 2026-09-16 18:00 的发放
  const atSix = new Date(2026, 8, 16, 18, 0, 0).getTime();
  const first = grantDailySubsidy(server.db, atSix);
  assert.equal(first.total, 2);
  assert.equal(first.granted, 2);
  assert.equal(wallet.balanceOf(server.db, player.accountId), 15000 + DAILY_GRANT_AMOUNT);
  assert.equal(wallet.balanceOf(server.db, npc.accountId), DAILY_GRANT_AMOUNT * 2);

  // 同一批次再发一次：全部被唯一约束挡下
  const again = grantDailySubsidy(server.db, atSix);
  assert.equal(again.granted, 0);
  assert.equal(wallet.balanceOf(server.db, player.accountId), 15000 + DAILY_GRANT_AMOUNT);

  // 当天 0 点批次是不同批次，可以再领
  const atZero = new Date(2026, 8, 16, 0, 0, 0).getTime();
  const morning = grantDailySubsidy(server.db, atZero);
  assert.equal(morning.granted, 2);
  assert.equal(wallet.balanceOf(server.db, player.accountId), 15000 + DAILY_GRANT_AMOUNT * 2);
});



