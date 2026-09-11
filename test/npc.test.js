import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createPokerServer } from '../server.js';
import * as stats from '../src/stats.js';
import * as wallet from '../src/wallet.js';
import * as npc from '../src/npc.js';

const WAIT_MS = 15000;
const ADMIN_TOKEN = 'npc-test-admin-1';

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

// 高速参数：NPC 思考 5–10ms、每手间隔 80ms、自愈每 80ms 一次。
function fastOptions(overrides = {}) {
  return {
    port: 0, host: '127.0.0.1', dbPath: ':memory:',
    npcTables: 2, npcHealIntervalMs: 80, nextHandDelayMs: 80,
    npcBaseDelayMs: 5, npcJitterMs: 5, botDelayMs: 5,
    adminToken: ADMIN_TOKEN,
    ...overrides,
  };
}

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
const request = (client, event, payload = {}) => new Promise((resolve, reject) => {
  client.socket.timeout(WAIT_MS).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
});
async function register(port, name) {
  const result = await api(port, 'POST', '/api/register', { body: { name, password: 'secret123' } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json;
}
async function poll(label, fn, timeout = WAIT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`poll timeout: ${label}`);
}
const npcPlayers = (server, code) => server.rooms.get(code).players.filter((p) => p.npc);

test('startup: two resident tables, each seated with five NPCs on real accounts', async (t) => {
  const server = await createPokerServer(fastOptions());
  t.after(async () => { await server.close(); });
  for (const code of npc.NPC_TABLE_CODES) {
    const room = await poll(`npc table ${code} seated to target`, () => {
      const candidate = server.rooms.get(code);
      return candidate && npcPlayers(server, code).length >= 5 ? candidate : null;
    });
    assert.equal(room.npcTable, true);
    assert.equal(room.practice, false);
    assert.equal(room.bigBlind, 10);
    assert.ok(npcPlayers(server, code).length <= 5, 'target is 5 (6 seats, 1 vacancy)');
    assert.ok(room.players.every((p) => p.isBot && p.accountId), 'NPC seats must be isBot with real account');
    assert.ok(room.players.every((p) => !p.socketId), 'NPC seats have no socket');
  }
  // NPC 账号带 npc 标记；钱包与流水恒等（余额 = 全部流水之和，资金只经真实变动）。
  const accounts = server.db.prepare('SELECT id, npc FROM accounts WHERE npc = 1').all();
  assert.ok(accounts.length >= 10, `expected >= 10 NPC accounts, got ${accounts.length}`);
  for (const account of accounts) {
    const sum = server.db.prepare('SELECT COALESCE(SUM(amount), 0) AS sum FROM ledger WHERE account_id = ?').get(account.id).sum;
    assert.equal(wallet.balanceOf(server.db, account.id), sum, 'NPC wallet must equal its ledger sum');
  }
});

test('npcTables 0 disables the whole system', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 0 }));
  t.after(async () => { await server.close(); });
  assert.equal(server.rooms.size, 0);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 0);
});

test('broadcast state hides NPC markers; room:bot bots keep theirs', async (t) => {
  const server = await createPokerServer(fastOptions());
  t.after(async () => { await server.close(); });
  const human = await register(server.port, '观察员');
  const client = await connectOk(server.port, human.token);
  const joined = await request(client, 'room:join', { code: npc.NPC_TABLE_CODES[0] });
  assert.equal(joined.ok, true);
  const state = await poll('join npc table', () => client.state?.players.some((p) => p.id === joined.playerId) && client.state);
  const npcNames = new Set(npc.NPC_ROSTER.map((entry) => entry.name));
  for (const player of state.players) {
    if (!npcNames.has(player.name)) continue;
    assert.equal(player.isBot, false, `NPC ${player.name} must not expose isBot`);
    assert.ok(!('difficulty' in player), `NPC ${player.name} must not expose difficulty`);
  }
  // 真人自己的座位也没有陪练标记。
  assert.equal(state.players.find((p) => p.id === joined.playerId).isBot, false);

  // 传统 room:bot 陪练保持 isBot + difficulty。
  const owner = await connectOk(server.port, (await register(server.port, '房主乙')).token);
  const created = await request(owner, 'room:create', { smallBlind: 10, bigBlind: 20, buyIn: 2000 });
  assert.equal(created.ok, true);
  await request(owner, 'room:bot', { difficulty: 'hard' });
  const botState = await poll('classic bot', () => owner.state?.players.some((p) => p.isBot) && owner.state);
  const classic = botState.players.find((p) => p.isBot);
  assert.equal(classic.difficulty, 'hard');
  client.socket.disconnect();
  owner.socket.disconnect();
});

test('NPC tables deal hands that count into history and the leaderboard', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 1 }));
  t.after(async () => { await server.close(); });
  const code = npc.NPC_TABLE_CODES[0];
  await poll('hands recorded', () => server.db.prepare('SELECT COUNT(*) AS count FROM hands WHERE room_code = ?').get(code).count >= 2);
  const npcRows = server.db.prepare(`SELECT COUNT(DISTINCT hp.account_id) AS count FROM hand_players hp
                                     JOIN accounts a ON a.id = hp.account_id WHERE a.npc = 1`).get();
  assert.ok(npcRows.count >= 3, `expected >= 3 NPCs in hand history, got ${npcRows.count}`);
  const wins = server.db.prepare(`SELECT COUNT(*) AS count FROM ledger l JOIN accounts a ON a.id = l.account_id
                                  WHERE a.npc = 1 AND l.type = 'HAND_WIN'`).get();
  assert.ok(wins.count >= 1, 'NPCs must have HAND_WIN memo ledger rows');
  const board = stats.leaderboard(server.db, server.rooms, 50);
  const names = new Set(board.map((entry) => entry.name));
  assert.ok([...npcNames()].some((name) => names.has(name)), 'leaderboard must include NPC players');
  function npcNames() { return new Set(npc.NPC_ROSTER.map((entry) => entry.name)); }
});

test('human join lowers the NPC target; leaving refills the seat', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 1 }));
  t.after(async () => { await server.close(); });
  const code = npc.NPC_TABLE_CODES[0];
  assert.equal(npcPlayers(server, code).length, 5);
  // 本用例只验证入座补位；避免自动下一手先发给不操作的真人，
  // 让座位自愈等待 30 秒行动超时而超过测试期限。
  const room = server.rooms.get(code);
  room.autoNext = false;
  await poll('npc hand settles before human joins', () => room.phase !== 'playing');

  const human = await register(server.port, '路人甲');
  const client = await connectOk(server.port, human.token);
  const joined = await request(client, 'room:join', { code });
  assert.equal(joined.ok, true);
  await poll('npc count drops to 4', () => npcPlayers(server, code).length === 4
    && server.rooms.get(code).players.some((p) => !p.isBot));
  assert.equal(server.rooms.get(code).players.length, 5); // 4 NPC + 1 human, one seat left open

  const left = await request(client, 'room:leave', {});
  assert.equal(left.ok, true, left.error);
  await poll('npc count refills to 5', () => npcPlayers(server, code).length === 5);
  client.socket.disconnect();
});

test('NPC funds cycle: wallet bring-in at start, daily subsidy once per day', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 1 }));
  t.after(async () => { await server.close(); });
  const code = npc.NPC_TABLE_CODES[0];
  const room = server.rooms.get(code);
  // 暂停自动开新牌局：等待中的桌面 stack 才不会被引擎 syncTable 覆盖，断言才确定。
  room.autoNext = false;
  await poll('current hand settles', () => room.phase !== 'playing');
  const target = npcPlayers(server, code)[0];
  const accountId = target.accountId;

  // 桌上低于最小带入（200）时，自动从自己的钱包 BRING_IN 补足到 500：
  // 把 stack 打到 100，期望出现一笔 400 的 BRING_IN（500-100）。
  const subsidies = () => server.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE account_id = ? AND type = 'SUBSIDY'").get(accountId).count;
  const bringIns = (amount) => server.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE account_id = ? AND type = 'BRING_IN' AND amount = ?").get(accountId, amount).count;
  const seated = room.players.find((p) => p.accountId === accountId);
  assert.equal(bringIns(-500), 1, 'initial seating must bring in 500 from own wallet');
  seated.stack = 100;
  await poll('wallet top-up bring-in', () => bringIns(-400) >= 1);
  assert.equal(seated.stack, 500, 'top-up must refill the seat stack to 500');

  // 破产场景：stack 与钱包都清零（总资产 < 2,000）→ 触发每日补助，再带入到 500。
  // 先清掉今日补助记录（高速对局中该 NPC 可能已自然领过），保证断言确定性。
  server.db.prepare('DELETE FROM subsidies WHERE account_id = ?').run(accountId);
  server.db.prepare('UPDATE wallets SET balance = 0 WHERE account_id = ?').run(accountId);
  seated.stack = 100;
  await poll('subsidy granted once and topped up', () => subsidies() === 1 && bringIns(-400) >= 2);

  // 同一天再次破产：补助每日一次，不能重复领取；钱包为空也无法再带入。
  server.db.prepare('UPDATE wallets SET balance = 0 WHERE account_id = ?').run(accountId);
  seated.stack = 100;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(subsidies(), 1, 'subsidy must be limited to once per day');
  assert.equal(wallet.balanceOf(server.db, accountId), 0, 'without subsidy nothing may be brought in');
});

test('banned NPC is kicked from the table and never reseated', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 1 }));
  t.after(async () => { await server.close(); });
  const code = npc.NPC_TABLE_CODES[0];
  // 本用例验证封禁与座位自愈；真人不会打牌，因此不要让自动下一手
  // 抢在自愈之前发给真人，导致移座等待 30 秒行动超时而超出测试期限。
  const room = server.rooms.get(code);
  room.autoNext = false;
  await poll('npc hand settles before moderation', () => room.phase !== 'playing');
  const victim = npcPlayers(server, code)[0];
  const ban = await api(server.port, 'POST', `/api/admin/users/${victim.accountId}/ban`, { body: { banned: true }, token: ADMIN_TOKEN });
  assert.equal(ban.status, 200);
  await poll('banned npc removed', () => !server.rooms.get(code).players.some((p) => p.accountId === victim.accountId));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!server.rooms.get(code).players.some((p) => p.accountId === victim.accountId),
    'self-heal must not reseat a banned NPC');
  // 解封后恢复资格：等桌上有空位时（真人加入再离开制造空位）自愈会把它加回。
  await api(server.port, 'POST', `/api/admin/users/${victim.accountId}/ban`, { body: { banned: false }, token: ADMIN_TOKEN });
  const guest = await register(server.port, '过客丁');
  const client = await connectOk(server.port, guest.token);
  const joined = await request(client, 'room:join', { code });
  assert.equal(joined.ok, true, joined.error);
  await poll('npc count drops after human joins', () => npcPlayers(server, code).length === 4);
  await request(client, 'room:leave', {});
  await poll('unbanned npc reseated when a seat frees', () =>
    server.rooms.get(code).players.some((p) => p.accountId === victim.accountId));
  client.socket.disconnect();
});

test('admin users list flags NPC accounts', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 1 }));
  t.after(async () => { await server.close(); });
  const page = (await api(server.port, 'GET', '/api/admin/users?page=1', { token: ADMIN_TOKEN })).json;
  const flagged = page.users.filter((user) => user.isNpc);
  assert.ok(flagged.length >= 5, `expected >= 5 flagged NPCs, got ${flagged.length}`);
  const human = await register(server.port, '真人丙');
  const after = (await api(server.port, 'GET', '/api/admin/users?page=1', { token: ADMIN_TOKEN })).json;
  assert.equal(after.users.find((user) => user.id === human.accountId).isNpc, false);
});

test('admin adds a configured npc table; heal seats it per config; disable retires it', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 4 }));
  t.after(async () => { await server.close(); });
  const created = (await api(server.port, 'POST', '/api/admin/npc-tables', {
    token: ADMIN_TOKEN,
    body: { smallBlind: 10, bigBlind: 20, buyIn: 1000, maxSeats: 3, keepVacant: 1 },
  })).json;
  assert.equal(created.ok, true, JSON.stringify(created));
  const { code, id } = created.table;
  assert.match(code, /^88\d{4}$/);
  const room = await poll('custom npc room created and seated', () => {
    const candidate = server.rooms.get(code);
    return candidate && npcPlayers(server, code).length >= 2 ? candidate : null;
  });
  assert.equal(room.bigBlind, 20);
  assert.equal(room.buyIn, 1000);
  assert.equal(npcPlayers(server, code).length, 2, '3 seats with 1 vacancy = 2 NPCs');
  assert.ok(room.players.every((p) => p.accountId), 'NPC seats carry real accounts');

  // 停用：NPC 撤出、房间清除；配置里 active=false
  await api(server.port, 'POST', `/api/admin/npc-tables/${id}/enabled`, { token: ADMIN_TOKEN, body: { enabled: false } });
  await poll('disabled npc room removed', () => (server.rooms.has(code) ? null : true));
  const list = (await api(server.port, 'GET', '/api/admin/npc-tables', { token: ADMIN_TOKEN })).json;
  const row = list.tables.find((table) => table.id === id);
  assert.equal(row.enabled, false);
  assert.equal(row.active, false);

  // 删除配置 + 审计留痕
  const deleted = (await api(server.port, 'DELETE', `/api/admin/npc-tables/${id}`, { token: ADMIN_TOKEN })).json;
  assert.equal(deleted.ok, true);
  const audit = server.db.prepare("SELECT action FROM admin_audit WHERE action LIKE 'NPC_TABLE_%'").all().map((r) => r.action);
  for (const action of ['NPC_TABLE_CREATE', 'NPC_TABLE_DISABLE', 'NPC_TABLE_DELETE']) {
    assert.ok(audit.includes(action), `audit must record ${action}`);
  }
});

test('keepVacant=2 caps npc count at maxSeats - 2', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 3 }));
  t.after(async () => { await server.close(); });
  const created = (await api(server.port, 'POST', '/api/admin/npc-tables', {
    token: ADMIN_TOKEN,
    body: { smallBlind: 5, bigBlind: 10, buyIn: 500, maxSeats: 6, keepVacant: 2 },
  })).json;
  const code = created.table.code;
  await poll('six-seat table keeps two vacancies', () => {
    const room = server.rooms.get(code);
    return room && npcPlayers(server, code).length === 4 ? room : null;
  });
});

test('npcTables cap: enabled configs beyond the limit stay inactive', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 1 }));
  t.after(async () => { await server.close(); });
  const created = (await api(server.port, 'POST', '/api/admin/npc-tables', {
    token: ADMIN_TOKEN,
    body: { smallBlind: 5, bigBlind: 10, buyIn: 500, maxSeats: 6, keepVacant: 1 },
  })).json;
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(server.rooms.has(created.table.code), false, 'beyond-cap config must not activate');
  const list = (await api(server.port, 'GET', '/api/admin/npc-tables', { token: ADMIN_TOKEN })).json;
  assert.equal(list.tables.find((table) => table.id === created.table.id).active, false);
  assert.equal(list.tables.find((table) => table.code === npc.NPC_TABLE_CODES[0]).active, true);
});

test('npc churn: accounts never double-seat, totals conserved, seats keep vacancies', async (t) => {
  const server = await createPokerServer(fastOptions({ npcTables: 4 }));
  t.after(async () => { await server.close(); });
  const tableA = (await api(server.port, 'POST', '/api/admin/npc-tables', {
    token: ADMIN_TOKEN,
    body: { smallBlind: 5, bigBlind: 10, buyIn: 500, maxSeats: 6, keepVacant: 1 },
  })).json.table;
  const tableB = (await api(server.port, 'POST', '/api/admin/npc-tables', {
    token: ADMIN_TOKEN,
    body: { smallBlind: 5, bigBlind: 10, buyIn: 500, maxSeats: 6, keepVacant: 1 },
  })).json.table;
  const codes = [npc.NPC_TABLE_CODES[0], npc.NPC_TABLE_CODES[1], tableA.code, tableB.code];
  const targetByCode = new Map(codes.map((code) => [code, 5]));

  // 采样 ~2s（80ms/tick ≈ 25 轮巡检）：守恒、不重复入座、每桌 ≤ 目标且留有空位
  const snapshots = new Set();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const seatKey = [];
    const seen = new Set();
    for (const code of codes) {
      const room = server.rooms.get(code);
      const npcs = room ? room.players.filter((p) => p.npc && !p.departing) : [];
      assert.ok(npcs.length <= targetByCode.get(code), `${code} over target: ${npcs.length}`);
      assert.ok(npcs.length >= 2, `${code} fell below heads-up minimum`);
      for (const p of npcs) {
        assert.ok(!seen.has(p.accountId), `NPC ${p.name} seated at two tables`);
        seen.add(p.accountId);
      }
      seatKey.push(`${code}:${npcs.length}`);
    }
    snapshots.add(seatKey.join('|'));
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.ok(snapshots.size > 1, `expected churn across samples, only saw ${[...snapshots][0]}`);
});
