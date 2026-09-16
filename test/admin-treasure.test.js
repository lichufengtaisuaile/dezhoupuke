import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPokerServer } from '../server.js';
import * as accounts from '../src/account.js';
import * as wallet from '../src/wallet.js';
import * as adminOps from '../src/admin.js';
import * as treasure from '../src/treasure.js';

async function fixture(t) {
  const server = await createPokerServer({
    port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0, adminToken: 'admin-secret',
  });
  t.after(async () => server.close());
  return server;
}

test('admin treasure config defaults then updates win rate and prize pool', async t => {
  const server = await fixture(t);
  const page = adminOps.treasureConfigPage(server.db);
  assert.equal(page.winBasisPoints, 1000);
  assert.equal(page.prizes.length, 51);
  assert.ok(page.prizes.every((p) => p.enabled));

  // 爆率改为 25%
  const updated = adminOps.updateTreasureConfig(server.db, { winBasisPoints: 2500 });
  assert.equal(updated.winBasisPoints, 2500);
  assert.equal(treasure.effectiveWinBasisPoints(server.db), 2500);
  assert.equal(treasure.config(server.db).winRate, 0.25);

  // 停用 2 个头像：生效奖池 49 个，单个概率 0.25/49
  const two = page.prizes.slice(0, 2).map((p) => p.id);
  const toggled = adminOps.updateTreasureConfig(server.db, { disabledPrizes: two });
  assert.equal(toggled.activeCount, 49);
  assert.equal(treasure.effectivePrizes(server.db).length, 49);
  const single = toggled.prizes.find((p) => p.enabled);
  assert.ok(Math.abs(single.probability - 0.25 / 49) < 1e-12);

  // 全部停用被拒绝（至少保留 1 个）
  assert.throws(() => adminOps.updateTreasureConfig(server.db, {
    disabledPrizes: page.prizes.map((p) => p.id),
  }), /至少保留 1 个/);

  // 爆率越界被拒绝
  assert.throws(() => adminOps.updateTreasureConfig(server.db, { winBasisPoints: 20000 }), /0–100%/);
});

test('openBox honours admin-configured win rate and prize pool', async t => {
  const server = await fixture(t);
  const account = accounts.register(server.db, 'box-player', 'secret123');
  wallet.credit(server.db, account.accountId, 'ADMIN_ADJUST', 500000, 'test', 'box-funds');

  const all = treasure.config().prizes;
  adminOps.updateTreasureConfig(server.db, {
    winBasisPoints: 10000, // 必中
    disabledPrizes: [all[1].id],
  });
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    const result = treasure.openBox(server.db, account.accountId, randomUUID());
    assert.equal(result.won, true, '爆率 100% 时必定中奖');
    assert.notEqual(result.avatar.id, all[1].id, '停用头像不能抽出');
    seen.add(result.avatar.id);
  }
  assert.ok(seen.size > 1, '奖池内应能抽出多种头像');
});

test('registration and online series feed the dashboard charts', async t => {
  const server = await fixture(t);
  const now = new Date(2026, 8, 16, 12, 0, 0).getTime();
  adminOps.recordOnlineSample(server.db, 5, now - 60 * 60000);
  adminOps.recordOnlineSample(server.db, 9, now - 30 * 60000);
  adminOps.recordOnlineSample(server.db, 42, now - 5 * 60000);
  const online = adminOps.onlineSeries(server.db, 24);
  assert.equal(online.length, 3);
  assert.equal(online[2].online, 42);

  const regs = adminOps.registrationSeries(server.db, 30, now);
  assert.equal(regs.length, 30);
  const today = regs[29];
  assert.equal(today.players, 0); // fixture 里没有真人注册
  assert.equal(today.day, '2026-09-16');
});
