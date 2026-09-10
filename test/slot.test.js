import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPokerServer } from '../server.js';
import { createDb } from '../src/db.js';
import * as accounts from '../src/account.js';
import * as wallet from '../src/wallet.js';
import * as stats from '../src/stats.js';
import { evaluateSpin, SLOT_TRIPLE_PAYOUTS } from '../src/slot.js';

async function api(port, method, url, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test('evaluateSpin matches the prototype paytable line by line', () => {
  // 与原型 D:/slot-machine/app.js evaluateResult 逐条对照：
  // 777=50×、三钻=30×、三铃=15×、三BAR=10×、三樱桃=8×、任意三同=6×、任意一对=2×、其余 0。
  for (const [id, multiplier] of Object.entries(SLOT_TRIPLE_PAYOUTS)) {
    assert.equal(evaluateSpin([id, id, id]).multiplier, multiplier, `三${id}应为 ${multiplier}×`);
  }
  for (const id of ['lemon', 'clover']) {
    assert.equal(evaluateSpin([id, id, id]).multiplier, 6, `三${id}（表外三同）应为 6×`);
  }
  assert.equal(evaluateSpin(['seven', 'seven', 'seven']).title, '头奖！三枚幸运 7');
  assert.equal(evaluateSpin(['bell', 'bell', 'bell']).title, '三连同图');
  assert.equal(evaluateSpin(['bar', 'bar', 'cherry']).multiplier, 2, '任意一对 2×');
  assert.equal(evaluateSpin(['cherry', 'bell', 'cherry']).multiplier, 2, '一对在中间也算');
  assert.equal(evaluateSpin(['seven', 'diamond', 'bell']).multiplier, 0, '全不同为 0');
});

test('legacy ledger (six-type CHECK) migrates losslessly to the eight-type schema', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dezhou-ledger-migrate-'));
  const dbPath = path.join(dir, 'dezhou.db');
  try {
    // 造一个老库：六种枚举的旧 ledger 表 + 一行流水。
    const legacy = createDb(dbPath);
    legacy.exec(`DROP TABLE ledger;
      CREATE TABLE ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        type TEXT NOT NULL CHECK (type IN ('REGISTER_GRANT', 'SUBSIDY', 'BRING_IN', 'CASH_OUT', 'HAND_WIN', 'PRACTICE')),
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        ref_type TEXT,
        ref_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (account_id, type, ref_type, ref_id)
      );`);
    const { accountId } = accounts.register(legacy, 'legacy', 'secret123');
    legacy.prepare(`INSERT INTO ledger (account_id, type, amount, balance_after, ref_type, ref_id, created_at)
                    VALUES (?, 'SUBSIDY', 2000, 12000, 'subsidy', '2099-01-01', 42)`).run(accountId);
    legacy.close();

    // 重新打开触发迁移：旧数据保留，新类型可写。
    const db = createDb(dbPath);
    const row = db.prepare('SELECT * FROM ledger WHERE type = ?').get('SUBSIDY');
    assert.equal(row.amount, 2000);
    assert.equal(row.balance_after, 12000);
    assert.equal(row.ref_id, '2099-01-01');
    const grant = db.prepare('SELECT * FROM ledger WHERE type = ?').get('REGISTER_GRANT');
    assert.equal(grant.amount, 10000);
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get().sql;
    assert.ok(sql.includes('SLOT_BET') && sql.includes('SLOT_WIN'), 'new CHECK must include slot types');
    db.prepare(`INSERT INTO ledger (account_id, type, amount, balance_after, ref_type, ref_id, created_at)
                VALUES (?, 'SLOT_BET', -5, 9995, 'spin', 'spin-x', 43)`).run(accountId);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('slot spin: server draws, settles, records, and reports balance', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => { await server.close(); });

  const reg = (await api(server.port, 'POST', '/api/register', { body: { name: 'spinner', password: 'secret123' } })).json;
  assert.equal(reg.balance, 10000);
  const token = reg.token;

  const spinId = '11111111-2222-4333-8444-555555555555';
  const first = (await api(server.port, 'POST', '/api/slot/spin', { token, body: { bet: 10, spinId } })).json;
  assert.equal(first.ok, true);
  assert.equal(first.bet, 10);
  assert.equal(first.reels.length, 3);
  assert.ok(first.reels.every((id) => typeof id === 'string'));
  const outcome = evaluateSpin(first.reels);
  assert.equal(first.outcome.multiplier, outcome.multiplier, 'payout must follow the server reels');
  assert.equal(first.payout, 10 * outcome.multiplier);
  assert.equal(first.net, first.payout - 10);
  assert.equal(first.balance, 10000 + first.net);

  // 流水：SLOT_BET 恒有；SLOT_WIN 仅派奖时写。
  const ledger = server.db.prepare("SELECT type, amount, ref_type, ref_id FROM ledger WHERE type LIKE 'SLOT_%' ORDER BY type").all();
  assert.deepEqual(ledger.map((row) => [row.type, row.ref_type, row.ref_id]),
    ledger.map((row) => [row.type, 'spin', spinId]));
  assert.equal(ledger.find((row) => row.type === 'SLOT_BET').amount, -10);
  if (first.payout > 0) assert.equal(ledger.find((row) => row.type === 'SLOT_WIN').amount, first.payout);
  else assert.equal(ledger.some((row) => row.type === 'SLOT_WIN'), false, 'payout=0 不写 SLOT_WIN 流水');

  // spins 记录。
  const row = server.db.prepare('SELECT * FROM spins WHERE id = ?').get(spinId);
  assert.equal(row.account_id, reg.accountId);
  assert.deepEqual(JSON.parse(row.reels), first.reels);
  assert.equal(row.payout, first.payout);
  assert.equal(row.net, first.net);

  // overview：老虎机战绩单列，总盈亏 = 德州(0) + 老虎机净盈亏。
  const overview = (await api(server.port, 'GET', '/api/me/overview', { token })).json;
  assert.equal(overview.slotSpins, 1);
  assert.equal(overview.slotNet, first.net);
  assert.equal(overview.netProfit, first.net);
  assert.equal(overview.balance, first.balance);
});

test('slot spin idempotency: replaying the same spinId settles once and returns the same result', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => { await server.close(); });

  const reg = (await api(server.port, 'POST', '/api/register', { body: { name: 'retry', password: 'secret123' } })).json;
  const token = reg.token;

  const spinId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const first = (await api(server.port, 'POST', '/api/slot/spin', { token, body: { bet: 20, spinId } })).json;
  assert.equal(first.ok, true);

  // 并发/重复提交同一 spinId：三次都返回首次结果，余额只结算一次。
  const replays = await Promise.all([1, 2, 3].map(() =>
    api(server.port, 'POST', '/api/slot/spin', { token, body: { bet: 20, spinId } })));
  for (const { status, json } of replays) {
    assert.equal(status, 200);
    assert.equal(json.duplicate, true);
    assert.deepEqual(json.reels, first.reels);
    assert.equal(json.payout, first.payout);
    assert.equal(json.net, first.net);
  }
  const overview = (await api(server.port, 'GET', '/api/me/overview', { token })).json;
  assert.equal(overview.slotSpins, 1, 'same spinId must be recorded once');
  assert.equal(overview.balance, 10000 + first.net, 'balance must reflect exactly one settlement');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM spins').get().count, 1);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE type = 'SLOT_BET'").get().count, 1);
});

test('slot accepts custom bets between 10 and 100000 outside the preset tiers', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => { await server.close(); });

  const reg = (await api(server.port, 'POST', '/api/register', { body: { name: 'custom', password: 'secret123' } })).json;
  const token = reg.token;
  server.db.prepare('UPDATE wallets SET balance = 2000000').run();

  for (const [index, bet] of [10, 15, 66, 100000].entries()) {
    const { status, json } = await api(server.port, 'POST', '/api/slot/spin', {
      token,
      body: { bet, spinId: `ffffffff-0000-4${String(index).padStart(3, '0')}-8000-${String(index).padStart(12, '0')}` },
    });
    assert.equal(status, 200, `custom bet ${bet} must be accepted`);
    assert.equal(json.bet, bet);
    assert.equal(json.payout, bet * json.outcome.multiplier);
  }
  const overview = (await api(server.port, 'GET', '/api/me/overview', { token })).json;
  assert.equal(overview.slotSpins, 4);
});

test('slot spin rejects bad bets and insufficient balance with 400', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => { await server.close(); });

  const reg = (await api(server.port, 'POST', '/api/register', { body: { name: 'broke', password: 'secret123' } })).json;
  const token = reg.token;

  // 档位 50/100/200/500 之外的金额：自定义范围 10 - 100,000，之外拒绝。
  for (const bet of [0, 5, 9, 100001, -10, '10', 15.5]) {
    const { status, json } = await api(server.port, 'POST', '/api/slot/spin', { token, body: { bet, spinId: 'bbbbbbbb-1111-4222-8333-444444444444' } });
    assert.equal(status, 400, `bet=${bet} must be rejected`);
    assert.match(json.error, /下注金额不正确/);
  }
  // 缺少/非法 spinId。
  for (const body of [{ bet: 10 }, { bet: 10, spinId: 'x' }, { bet: 10, spinId: '' }]) {
    const { status } = await api(server.port, 'POST', '/api/slot/spin', { token, body });
    assert.equal(status, 400, `${JSON.stringify(body)} must be rejected`);
  }
  // 未登录 401。
  const anon = await api(server.port, 'POST', '/api/slot/spin', { body: { bet: 10, spinId: 'cccccccc-1111-4222-8333-444444444444' } });
  assert.equal(anon.status, 401);

  // 余额不足：耗尽钱包后真实下注被拒且不产生记录（50000 是合法自定义金额）。
  server.db.prepare('UPDATE wallets SET balance = 3').run();
  const poor = await api(server.port, 'POST', '/api/slot/spin', { token, body: { bet: 50000, spinId: 'dddddddd-1111-4222-8333-444444444444' } });
  assert.equal(poor.status, 400);
  assert.match(poor.json.error, /余额不足/);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM spins').get().count, 0);
  assert.equal(wallet.balanceOf(server.db, reg.accountId), 3, 'a rejected spin must not move the balance');
});

test('spins history endpoints paginate for the drawer and limit for the slot page', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => { await server.close(); });

  const reg = (await api(server.port, 'POST', '/api/register', { body: { name: 'regular', password: 'secret123' } })).json;
  const token = reg.token;
  for (let index = 0; index < 25; index += 1) {
    const { json } = await api(server.port, 'POST', '/api/slot/spin', {
      token,
      body: { bet: 10, spinId: `eeeeeeee-0000-4${String(index).padStart(3, '0')}-8000-${String(index).padStart(12, '0')}` },
    });
    assert.equal(json.ok, true);
  }

  // ?limit=20：slot 页"最近开奖"。
  const recent = (await api(server.port, 'GET', '/api/me/spins?limit=20', { token })).json;
  assert.equal(recent.spins.length, 20);
  assert.ok(recent.spins.every((spin) => Array.isArray(spin.reels) && spin.reels.length === 3));
  for (let index = 1; index < recent.spins.length; index += 1) {
    assert.ok(recent.spins[index - 1].time >= recent.spins[index].time, 'recent spins must be newest first');
  }

  // ?page=N：个人中心页签分页（每页 20，共两页）。
  const page1 = (await api(server.port, 'GET', '/api/me/spins?page=1', { token })).json;
  assert.equal(page1.page, 1);
  assert.equal(page1.pageSize, 20);
  assert.equal(page1.total, 25);
  assert.equal(page1.spins.length, 20);
  const page2 = (await api(server.port, 'GET', '/api/me/spins?page=2', { token })).json;
  assert.equal(page2.spins.length, 5);

  // 未登录 401。
  const anon = await api(server.port, 'GET', '/api/me/spins?limit=5');
  assert.equal(anon.status, 401);

  // 统计口径：slotSpins=25，slotNet 与 spins 表求和一致，netProfit 无德州成分时相等。
  const overview = (await api(server.port, 'GET', '/api/me/overview', { token })).json;
  assert.equal(overview.slotSpins, 25);
  const sum = server.db.prepare('SELECT COALESCE(SUM(net), 0) AS net FROM spins').get().net;
  assert.equal(overview.slotNet, sum);
  assert.equal(overview.netProfit, sum);
  assert.equal(stats.spinsPage(server.db, reg.accountId, 1).total, 25);
});
