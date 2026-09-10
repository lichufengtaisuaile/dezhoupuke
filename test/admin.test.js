import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { createPokerServer } from '../server.js';
import { createDb } from '../src/db.js';
import * as accounts from '../src/account.js';
import * as wallet from '../src/wallet.js';
import * as adminOps from '../src/admin.js';

const WAIT_MS = 5000;
const ADMIN_TOKEN = 'test-admin-token-0001';

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
const admin = (port, method, url, options = {}) =>
  api(port, method, url, { ...options, token: options.token ?? ADMIN_TOKEN });

function connect(port, token) {
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'], forceNew: true, reconnection: false, autoConnect: false,
    ...(token ? { auth: { token } } : {}),
  });
  const client = { socket, state: null };
  socket.on('room:state', (state) => { client.state = state; });
  return client;
}
async function connectOk(port, token) {
  const client = connect(port, token);
  const connected = once(client.socket, 'connect', { signal: AbortSignal.timeout(WAIT_MS) });
  client.socket.connect();
  await connected;
  return client;
}
function request(client, event, payload = {}) {
  return new Promise((resolve, reject) => {
    client.socket.timeout(WAIT_MS).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}
function stateWhere(client, predicate, timeout = WAIT_MS) {
  if (client.state && predicate(client.state)) return Promise.resolve(client.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.socket.off('room:state', listener);
      reject(new Error(`state wait timeout: ${JSON.stringify(client.state)}`));
    }, timeout);
    function listener(state) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      client.socket.off('room:state', listener);
      resolve(state);
    }
    client.socket.on('room:state', listener);
  });
}

test('admin api without adminToken returns 503, wrong token returns 401', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => { await server.close(); });
  await api(server.port, 'POST', '/api/register', { body: { name: 'plain', password: 'secret123' } });

  for (const [method, url, body] of [
    ['GET', '/api/admin/users?page=1', undefined],
    ['GET', '/api/admin/audit?page=1', undefined],
    ['POST', '/api/admin/users/x/adjust', { amount: 1, reason: 'x' }],
    ['POST', '/api/admin/users/x/ban', { banned: true }],
  ]) {
    const missing = await api(server.port, method, url, { body });
    assert.equal(missing.status, 503, `${method} ${url} must be 503 when unconfigured`);
    assert.match(missing.json.error, /未配置/);
    const wrong = await api(server.port, method, url, { token: 'nope', body });
    assert.equal(wrong.status, 503, `${method} ${url} stays 503 when unconfigured, token ignored`);
  }
  // 普通功能不受影响。
  const login = await api(server.port, 'POST', '/api/login', { body: { name: 'plain', password: 'secret123' } });
  assert.equal(login.status, 200);
});

test('admin users list carries stats and supports name search', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', adminToken: ADMIN_TOKEN, npcTables: 0 });
  t.after(async () => { await server.close(); });

  const alice = (await admin(server.port, 'POST', '/api/register', { body: { name: 'alice', password: 'secret123' } })).json;
  await admin(server.port, 'POST', '/api/register', { body: { name: 'bob', password: 'secret123' } });
  const spin = await admin(server.port, 'POST', '/api/slot/spin', { body: { bet: 50, spinId: 'admin-list-0000-4000-8000-000000000001' }, token: alice.token });
  assert.equal(spin.status, 200, JSON.stringify(spin.json));

  const page = (await admin(server.port, 'GET', '/api/admin/users?page=1')).json;
  assert.equal(page.ok, true);
  const wrongToken = await api(server.port, 'GET', '/api/admin/users?page=1', { token: 'nope' });
  assert.equal(wrongToken.status, 401);
  assert.equal(page.pageSize, 20);
  assert.equal(page.total, 2);
  const byName = Object.fromEntries(page.users.map((user) => [user.name, user]));
  for (const user of page.users) {
    for (const field of ['id', 'name', 'isBanned', 'balance', 'tableStack', 'totalAssets', 'handsPlayed', 'slotSpins', 'netProfit', 'createdAt']) {
      assert.ok(field in user, `users list must include ${field}`);
    }
    assert.equal(user.totalAssets, user.balance + user.tableStack);
  }
  assert.equal(byName.alice.slotSpins, 1);
  assert.equal(byName.alice.netProfit, byName.alice.balance - 10000);
  assert.equal(byName.bob.slotSpins, 0);
  assert.equal(byName.alice.isBanned, false);

  const searched = (await admin(server.port, 'GET', '/api/admin/users?q=ali&page=1')).json;
  assert.equal(searched.total, 1);
  assert.equal(searched.users[0].name, 'alice');
  const none = (await admin(server.port, 'GET', '/api/admin/users?q=不存在&page=1')).json;
  assert.equal(none.total, 0);
  assert.equal(none.users.length, 0);
});

test('admin adjust: positive/negative balance, ADMIN_ADJUST ledger, audit trail, validation', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', adminToken: ADMIN_TOKEN, npcTables: 0 });
  t.after(async () => { await server.close(); });

  const reg = (await admin(server.port, 'POST', '/api/register', { body: { name: 'target', password: 'secret123' } })).json;
  const id = reg.accountId;

  const plus = await admin(server.port, 'POST', `/api/admin/users/${id}/adjust`, { body: { amount: 500, reason: '活动补偿' } });
  assert.equal(plus.status, 200);
  assert.equal(plus.json.balance, 10500);
  assert.equal(plus.json.name, 'target');

  const minus = await admin(server.port, 'POST', `/api/admin/users/${id}/adjust`, { body: { amount: -300, reason: '扣除多发的补助' } });
  assert.equal(minus.json.balance, 10200);

  // ledger：两笔 ADMIN_ADJUST，ref 为 audit-<id>，与审计一一对应。
  const rows = server.db.prepare("SELECT * FROM ledger WHERE type = 'ADMIN_ADJUST' ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, 500);
  assert.equal(rows[1].amount, -300);
  assert.equal(rows[1].balance_after, 10200);
  for (const row of rows) {
    assert.equal(row.ref_type, 'admin');
    assert.match(row.ref_id, /^audit-\d+$/);
  }
  const audit = (await admin(server.port, 'GET', '/api/admin/audit?page=1')).json;
  assert.equal(audit.total, 2);
  assert.deepEqual(audit.entries.map((entry) => entry.action), ['ADJUST_BALANCE', 'ADJUST_BALANCE']);
  assert.equal(audit.entries[0].targetName, 'target');
  assert.equal(audit.entries[0].detail.amount, -300);
  assert.equal(audit.entries[0].detail.reason, '扣除多发的补助');

  // 校验：0、非整数、空原因、超额扣减、不存在的用户。
  for (const body of [{ amount: 0, reason: 'x' }, { amount: 1.5, reason: 'x' }, { amount: 100, reason: '  ' }]) {
    const bad = await admin(server.port, 'POST', `/api/admin/users/${id}/adjust`, { body });
    assert.equal(bad.status, 400, `${JSON.stringify(body)} must be rejected`);
  }
  const over = await admin(server.port, 'POST', `/api/admin/users/${id}/adjust`, { body: { amount: -99999, reason: '超额' } });
  assert.equal(over.status, 400);
  assert.match(over.json.error, /超出用户余额/);
  assert.equal(wallet.balanceOf(server.db, id), 10200, 'rejected adjusts must not move the balance');
  const ghost = await admin(server.port, 'POST', '/api/admin/users/no-such-id/adjust', { body: { amount: 1, reason: 'x' } });
  assert.equal(ghost.status, 400);
  assert.match(ghost.json.error, /没有找到这个用户/);
  // 幂等键：两笔审计的 ref_id 不重复。
  assert.notEqual(rows[0].ref_id, rows[1].ref_id);
});

test('admin ban: kicks from room with CASH_OUT refund, blocks login/socket/REST, unban restores', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', adminToken: ADMIN_TOKEN, npcTables: 0 });
  t.after(async () => { await server.close(); });

  const reg = (await admin(server.port, 'POST', '/api/register', { body: { name: 'cheater', password: 'secret123' } })).json;
  const client = await connectOk(server.port, reg.token);
  const created = await request(client, 'room:create', { smallBlind: 10, bigBlind: 20, buyIn: 2000, bringIn: 2000 });
  assert.equal(created.ok, true);
  await stateWhere(client, (state) => state.players.length === 1);
  assert.equal(wallet.balanceOf(server.db, reg.accountId), 8000);

  const disconnectSeen = once(client.socket, 'disconnect');
  const banned = await admin(server.port, 'POST', `/api/admin/users/${reg.accountId}/ban`, { body: { banned: true } });
  assert.equal(banned.status, 200);
  assert.equal(banned.json.banned, true);
  await disconnectSeen;

  // 座位清理 + 桌上筹码退回钱包（CASH_OUT），房间销毁。
  assert.equal(server.rooms.size, 0);
  assert.equal(wallet.balanceOf(server.db, reg.accountId), 10000);
  const cashOut = server.db.prepare("SELECT * FROM ledger WHERE type = 'CASH_OUT' AND account_id = ?").get(reg.accountId);
  assert.equal(cashOut.amount, 2000);
  // 审计。
  const audit = (await admin(server.port, 'GET', '/api/admin/audit?page=1')).json;
  const banEntry = audit.entries.find((entry) => entry.action === 'BAN');
  assert.ok(banEntry, 'BAN audit must exist');
  assert.equal(banEntry.targetName, 'cheater');
  // 列表状态。
  const users = (await admin(server.port, 'GET', '/api/admin/users?q=cheat')).json;
  assert.equal(users.users[0].isBanned, true);

  // 登录 403、socket 拒绝、REST 401。
  const login = await api(server.port, 'POST', '/api/login', { body: { name: 'cheater', password: 'secret123' } });
  assert.equal(login.status, 403);
  assert.match(login.json.error, /账号已被封禁/);
  const denied = connect(server.port, reg.token);
  const racing = Promise.race([
    once(denied.socket, 'connect_error').then((result) => ({ error: result[0] })),
    once(denied.socket, 'connect').then(() => ({ error: null })),
  ]);
  denied.socket.connect();
  const outcome = await racing;
  denied.socket.disconnect();
  assert.ok(outcome.error, 'banned account socket must be rejected');
  assert.match(outcome.error.message, /已被封禁/);
  const overview = await api(server.port, 'GET', '/api/me/overview', { token: reg.token });
  assert.equal(overview.status, 401);

  // 解封恢复。
  const unbanned = await admin(server.port, 'POST', `/api/admin/users/${reg.accountId}/ban`, { body: { banned: false } });
  assert.equal(unbanned.json.banned, false);
  const loginAgain = await api(server.port, 'POST', '/api/login', { body: { name: 'cheater', password: 'secret123' } });
  assert.equal(loginAgain.status, 200);
  const reconnected = await connectOk(server.port, loginAgain.json.token);
  reconnected.socket.disconnect();
  const auditAfter = (await admin(server.port, 'GET', '/api/admin/audit?page=1')).json;
  assert.ok(auditAfter.entries.some((entry) => entry.action === 'UNBAN'));
});

test('admin ban mid-hand: engine fold advances the hand, stack refunded exactly once', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', adminToken: ADMIN_TOKEN, npcTables: 0 });
  t.after(async () => { await server.close(); });

  const hostReg = (await admin(server.port, 'POST', '/api/register', { body: { name: 'hoster', password: 'secret123' } })).json;
  const guestReg = (await admin(server.port, 'POST', '/api/register', { body: { name: 'guester', password: 'secret123' } })).json;
  const host = await connectOk(server.port, hostReg.token);
  const guest = await connectOk(server.port, guestReg.token);
  host.identity = await request(host, 'room:create', { smallBlind: 10, bigBlind: 20, buyIn: 2000, bringIn: 2000 });
  await request(guest, 'room:join', { code: host.identity.code, bringIn: 2000 });
  await stateWhere(host, (state) => state.players.length === 2);
  await request(host, 'room:start', {});
  const playing = await stateWhere(host, (state) => state.phase === 'playing' && state.turnSeat !== null);
  // 封禁当前行动玩家（host 是庄家/小盲，翻牌前先行）。
  const victim = playing.players.find((player) => player.seat === playing.turnSeat);
  const victimToken = victim.name === 'hoster' ? hostReg.token : guestReg.token;
  const victimClient = victim.name === 'hoster' ? host : guest;
  const bystander = victim.name === 'hoster' ? guest : host;

  const disconnectSeen = once(victimClient.socket, 'disconnect');
  const banned = await admin(server.port, 'POST', `/api/admin/users/${victimToken === hostReg.token ? hostReg.accountId : guestReg.accountId}/ban`, { body: { banned: true } });
  assert.equal(banned.status, 200);
  await disconnectSeen;

  // 对局安全推进到结束（被封禁者已弃牌）。
  await stateWhere(bystander, (state) => state.phase === 'finished');
  const victimId = victimToken === hostReg.token ? hostReg.accountId : guestReg.accountId;
  // 桌上 2,000 已扣小盲 10，剩余 1,990 一次性退回：余额 = 8,000 + 1,990 = 9,990，只退一次。
  assert.equal(wallet.balanceOf(server.db, victimId), 9990);
  const cashOuts = server.db.prepare("SELECT * FROM ledger WHERE type = 'CASH_OUT' AND account_id = ?").all(victimId);
  assert.equal(cashOuts.length, 1);
  assert.equal(cashOuts[0].amount, 1990);
  victimClient.socket.disconnect();
  bystander.socket.disconnect();
});

test('legacy ledger schemas (six types and eight types) migrate to nine losslessly', async () => {
  const mkSchema = (types) => `CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    type TEXT NOT NULL CHECK (type IN (${types.map((type) => `'${type}'`).join(', ')})),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    ref_type TEXT,
    ref_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, type, ref_type, ref_id)
  );`;
  const SIX = ['REGISTER_GRANT', 'SUBSIDY', 'BRING_IN', 'CASH_OUT', 'HAND_WIN', 'PRACTICE'];
  const EIGHT = [...SIX, 'SLOT_BET', 'SLOT_WIN'];

  for (const [label, types] of [['six-type', SIX], ['eight-type', EIGHT]]) {
    const dir = mkdtempSync(path.join(tmpdir(), `dezhou-admin-migrate-${label}-`));
    const dbPath = path.join(dir, 'dezhou.db');
    try {
      // 造老库：旧枚举的 ledger 表（无 SLOT_/ADMIN_ADJUST），并造一个无 is_banned 列的 accounts。
      const legacy = createDb(dbPath);
      legacy.exec(`DROP TABLE ledger; ${mkSchema(types)};`);
      if (label === 'six-type') legacy.exec('ALTER TABLE accounts DROP COLUMN is_banned');
      const { accountId } = accounts.register(legacy, label === 'six-type' ? 'legacy-6' : 'legacy-8', 'secret123');
      legacy.prepare(`INSERT INTO ledger (account_id, type, amount, balance_after, ref_type, ref_id, created_at)
                      VALUES (?, 'SUBSIDY', 2000, 12000, 'subsidy', 'day-x', 7)`).run(accountId);
      legacy.close();

      const db = createDb(dbPath);
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get().sql;
      assert.ok(sql.includes('ADMIN_ADJUST'), `${label}: new CHECK must include ADMIN_ADJUST`);
      const row = db.prepare("SELECT * FROM ledger WHERE type = 'SUBSIDY' AND account_id = ?").get(accountId);
      assert.equal(row.amount, 2000);
      assert.equal(row.balance_after, 12000);
      assert.equal(row.ref_id, 'day-x');
      // 九种类型全部可写。
      db.prepare(`INSERT INTO ledger (account_id, type, amount, balance_after, ref_type, ref_id, created_at)
                  VALUES (?, 'ADMIN_ADJUST', 1, 12001, 'admin', 'audit-test', 8)`).run(accountId);
      // accounts.is_banned 迁移补齐且旧数据为 0。
      const account = db.prepare('SELECT is_banned FROM accounts WHERE id = ?').get(accountId);
      assert.equal(account.is_banned, 0, `${label}: is_banned must default to 0`);
      db.close();
    } finally {
      // Windows 下刚 close 的库文件句柄释放有延迟，清理临时目录需要重试。
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 300)); }
      }
    }
  }
});

test('adminOps unit: adjust audit id pairs with ledger ref, ban flag validation', () => {
  const db = createDb(':memory:');
  const { accountId } = accounts.register(db, 'unit', 'secret123');
  const adjusted = adminOps.adjustBalance(db, accountId, 100, '测试');
  const row = db.prepare("SELECT * FROM ledger WHERE type = 'ADMIN_ADJUST' AND account_id = ?").get(accountId);
  assert.equal(row.ref_id, `audit-${adjusted.auditId}`);
  assert.equal(row.balance_after, 10100);
  assert.throws(() => adminOps.adjustBalance(db, accountId, 0, 'x'), /不能为 0/);
  assert.throws(() => adminOps.adjustBalance(db, accountId, -99999, 'x'), /超出用户余额/);
  const banned = adminOps.setBanned(db, accountId, true);
  assert.equal(banned.banned, true);
  assert.equal(adminOps.isBanned(db, accountId), true);
  assert.throws(() => adminOps.setBanned(db, accountId, 'yes'), /true 或 false/);
  adminOps.setBanned(db, accountId, false);
  assert.equal(adminOps.isBanned(db, accountId), false);
  db.close();
});
