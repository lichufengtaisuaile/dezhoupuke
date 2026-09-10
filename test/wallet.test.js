import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createPokerServer } from '../server.js';
import { createDb, saveSnapshot } from '../src/db.js';
import * as accounts from '../src/account.js';
import * as wallet from '../src/wallet.js';
import * as stats from '../src/stats.js';

const WAIT_MS = 5000;

function freshDb() {
  return createDb(':memory:');
}

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

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(WAIT_MS).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function success(socket, event, payload = {}) {
  const response = await request(socket, event, payload);
  assert.equal(response?.ok, true, `${event}: ${JSON.stringify(response)}`);
  return response;
}

async function rejected(socket, event, payload = {}) {
  const response = await request(socket, event, payload);
  assert.equal(response?.ok, false, `${event} must reject ${JSON.stringify(payload)}`);
  return response;
}

async function connect(port, token) {
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    autoConnect: false,
    ...(token ? { auth: { token } } : {}),
  });
  const client = { socket, state: null };
  socket.on('room:state', (state) => { client.state = state; });
  if (!token) {
    const outcome = Promise.race([
      once(socket, 'connect_error').then(result => ({ error: result[0] })),
      once(socket, 'connect').then(() => ({ error: null })),
    ]);
    socket.connect();
    const { error } = await outcome;
    socket.disconnect();
    return { socket, denied: error };
  }
  const connected = once(socket, 'connect', { signal: AbortSignal.timeout(WAIT_MS) });
  socket.connect();
  await connected;
  return client;
}

function stateWhere(client, predicate, timeout = WAIT_MS) {
  if (client.state && predicate(client.state)) return Promise.resolve(client.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.socket.off('room:state', listener);
      reject(new Error(`Timed out waiting for room state: ${JSON.stringify(client.state)}`));
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

function self(client) {
  return client.state.players.find((player) => player.id === client.identity.playerId);
}

test('register grants 10000 once, enforces unique names, and login verifies scrypt password', () => {
  const db = freshDb();
  const alice = accounts.register(db, 'alice', 'secret123');
  assert.equal(alice.balance, 10000);
  const grant = db.prepare("SELECT * FROM ledger WHERE account_id = ? AND type = 'REGISTER_GRANT'").get(alice.accountId);
  assert.equal(grant.amount, 10000);
  assert.equal(grant.balance_after, 10000);

  assert.throws(() => accounts.register(db, 'alice', 'secret123'), /已被注册/);
  assert.throws(() => accounts.register(db, 'bob', '123'), /密码需要/);

  assert.throws(() => accounts.login(db, 'alice', 'wrong-password'), /昵称或密码不正确/);
  const loggedIn = accounts.login(db, 'alice', 'secret123');
  assert.equal(accounts.authenticate(db, loggedIn.token)?.id, alice.accountId);
  assert.equal(accounts.authenticate(db, 'bad-token'), null);
  // 密码以 salt:hash 形式存储，不出现明文
  const row = db.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(alice.accountId);
  assert.ok(row.password_hash.includes(':'));
  assert.ok(!row.password_hash.includes('secret123'));
});

test('subsidy grants 2000 once per day and only through the idempotent key', () => {
  const db = freshDb();
  const { accountId } = accounts.register(db, 'broke', 'secret123');
  wallet.bringIn(db, accountId, 9100, 'TEST01');
  assert.equal(wallet.balanceOf(db, accountId), 900);
  wallet.grantSubsidy(db, accountId);
  assert.equal(wallet.balanceOf(db, accountId), 2900);
  const entry = db.prepare("SELECT * FROM ledger WHERE account_id = ? AND type = 'SUBSIDY'").get(accountId);
  assert.equal(entry.amount, 2000);
  assert.equal(entry.balance_after, 2900);
  assert.throws(() => wallet.grantSubsidy(db, accountId), /今天已经领取过/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subsidies WHERE account_id = ?').get(accountId).count, 1);
  assert.equal(wallet.balanceOf(db, accountId), 2900);
});

test('settleHand writes hands and HAND_WIN memos idempotently without moving balances', () => {
  const db = freshDb();
  const a = accounts.register(db, 'winner', 'secret123');
  const b = accounts.register(db, 'loser', 'secret123');
  const players = [
    {
      accountId: a.accountId, playerId: 'p1', name: 'winner', seat: 0,
      holeCards: [{ rank: 'A', suit: 'spades' }, { rank: 'A', suit: 'hearts' }],
      net: 30, isWinner: true, handName: '一对', handDetail: null, revealed: true,
    },
    {
      accountId: b.accountId, playerId: 'p2', name: 'loser', seat: 1,
      holeCards: null, net: -30, isWinner: false, handName: null, handDetail: null, revealed: false,
    },
  ];
  const hand = {
    handId: 'hand-1', roomCode: 'ROOM01', handNumber: 1, smallBlind: 10, bigBlind: 20,
    board: [{ rank: 'K', suit: 'clubs' }], pot: 60, players,
  };
  assert.equal(wallet.settleHand(db, hand), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM hands').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM hand_players').get().count, 2);
  const winMemos = db.prepare("SELECT * FROM ledger WHERE type = 'HAND_WIN' ORDER BY amount DESC").all();
  assert.equal(winMemos.length, 2);
  assert.equal(winMemos.reduce((sum, row) => sum + row.amount, 0), 0);
  assert.equal(winMemos[0].ref_type, 'hand');
  assert.equal(winMemos[0].ref_id, 'hand-1');
  // HAND_WIN 是备忘流水：可用余额不变，总资产变化体现在桌上筹码
  assert.equal(wallet.balanceOf(db, a.accountId), 10000);
  assert.equal(wallet.balanceOf(db, b.accountId), 10000);

  // 同一手重复结算（新 handId、相同 room+hand_number）必须被唯一键挡掉
  assert.equal(wallet.settleHand(db, { ...hand, handId: 'hand-1-duplicate' }), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM hands').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE type = 'HAND_WIN'").get().count, 2);

  const mine = stats.handsPage(db, a.accountId, 1);
  assert.equal(mine.total, 1);
  assert.equal(mine.hands[0].net, 30);
  assert.equal(mine.hands[0].winners.length, 1);
  assert.equal(mine.hands[0].winners[0].name, 'winner');
  const view = stats.overview(db, new Map(), a.accountId);
  assert.equal(view.handsPlayed, 1);
  assert.equal(view.netProfit, 30);
  assert.equal(view.winRate, 1);
  assert.equal(view.rank, 1);
  const board = stats.leaderboard(db, new Map(), 50);
  assert.equal(board[0].name, 'winner');
  assert.equal(board[0].total, 10000);
  assert.equal(stats.ledgerPage(db, b.accountId, 1).total, 2);
});

test('auth-gated socket play: bring-in deducts, rebuy is refused, settlement settles, leave refunds', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => { await server.close(); });

  const denied = await connect(server.port, null);
  assert.ok(denied.denied, 'anonymous socket must be rejected when auth is on');

  const alice = (await api(server.port, 'POST', '/api/register', { body: { name: 'alice', password: 'secret123' } })).json;
  const bob = (await api(server.port, 'POST', '/api/register', { body: { name: 'bob', password: 'secret123' } })).json;
  assert.equal(alice.balance, 10000);

  const host = await connect(server.port, alice.token);
  const guest = await connect(server.port, bob.token);
  for (const client of [host, guest]) {
    client.identity = null;
  }
  host.identity = await success(host.socket, 'room:create', { smallBlind: 10, bigBlind: 20, buyIn: 2000, bringIn: 2000 });
  guest.identity = await success(guest.socket, 'room:join', { code: host.identity.code, bringIn: 2000 });
  assert.equal(host.state.practice, false);

  let overview = (await api(server.port, 'GET', '/api/me/overview', { token: alice.token })).json;
  assert.equal(overview.balance, 8000);
  assert.equal(overview.tableStack, 2000);
  assert.equal(overview.totalAssets, 10000);

  await rejected(guest.socket, 'room:rebuy'); // 真人桌禁止免费回满
  await success(host.socket, 'room:start');
  await stateWhere(host, (state) => state.phase === 'playing' && state.turnSeat !== null);
  const actor = self(host).seat === host.state.turnSeat ? host : guest;
  await success(actor.socket, 'game:action', { action: 'fold', handNumber: host.state.handNumber, turnId: host.state.turnId });
  await stateWhere(host, (state) => state.phase === 'finished');

  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM hands').get().count, 1);
  const winSum = server.db.prepare("SELECT COALESCE(SUM(amount), 0) AS sum FROM ledger WHERE type = 'HAND_WIN'").get().sum;
  assert.equal(winSum, 0, 'HAND_WIN memos must net to zero across the table');

  await success(host.socket, 'room:leave');
  await success(guest.socket, 'room:leave');
  const balances = server.db.prepare('SELECT name, balance FROM wallets w JOIN accounts a ON a.id = w.account_id').all()
    .map((row) => row.balance).sort((x, y) => x - y);
  assert.deepEqual(balances, [9990, 10010], 'bring-in then cash-out must conserve total assets');
  assert.equal(server.rooms.size, 0);

  // 补助：总资产门槛 + 每日一次
  server.db.prepare('UPDATE wallets SET balance = 5000').run();
  const lobbyClient = await connect(server.port, alice.token);
  await rejected(lobbyClient.socket, 'room:subsidy');
  server.db.prepare('UPDATE wallets SET balance = 100').run();
  await success(lobbyClient.socket, 'room:subsidy');
  assert.equal(server.db.prepare('SELECT balance FROM wallets').get().balance, 2100);
  server.db.prepare('UPDATE wallets SET balance = 100').run();
  const subsidyError = (await rejected(lobbyClient.socket, 'room:subsidy')).error;
  assert.match(subsidyError, /今天已经领取过/);
  assert.equal(server.db.prepare('SELECT balance FROM wallets').get().balance, 100, 'a rejected subsidy must not change the balance');
});

test('practice rooms use free chips, keep free rebuy, and skip the ledger', async (t) => {
  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0 });
  t.after(async () => { await server.close(); });

  const carol = (await api(server.port, 'POST', '/api/register', { body: { name: 'carol', password: 'secret123' } })).json;
  const dave = (await api(server.port, 'POST', '/api/register', { body: { name: 'dave', password: 'secret123' } })).json;
  const host = await connect(server.port, carol.token);
  const guest = await connect(server.port, dave.token);
  host.identity = await success(host.socket, 'room:create', { smallBlind: 10, bigBlind: 20, buyIn: 2000, practice: true });
  guest.identity = await success(guest.socket, 'room:join', { code: host.identity.code });
  assert.equal(host.state.practice, true);
  for (const token of [carol.token, dave.token]) {
    const overview = (await api(server.port, 'GET', '/api/me/overview', { token })).json;
    assert.equal(overview.balance, 10000, 'practice chips never touch the wallet');
    assert.equal(overview.tableStack, 0);
  }
  await success(host.socket, 'room:start');
  await stateWhere(host, (state) => state.phase === 'playing' && state.turnSeat !== null);
  const actor = self(host).seat === host.state.turnSeat ? host : guest;
  await success(actor.socket, 'game:action', { action: 'fold', handNumber: host.state.handNumber, turnId: host.state.turnId });
  await stateWhere(host, (state) => state.phase === 'finished');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM hands').get().count, 0, 'practice hands are not recorded');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM ledger').get().count, 2, 'only the two register grants exist');

  const room = server.rooms.get(host.identity.code);
  room.players.find((p) => !p.isBot).stack = 0;
  await success(host.socket, 'room:rebuy', {});
  assert.equal(self(host).stack, 2000, 'practice rooms keep the free rebuy');
  await success(host.socket, 'room:bot', {});
});

test('restart restores seats and voids an in-progress hand without losing chips', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dezhou-restore-'));
  const dbPath = path.join(dir, 'dezhou.db');

  const setup = createDb(dbPath);
  accounts.register(setup, 'restored', 'secret123');
  saveSnapshot(setup, {
    code: 'LIVE42', smallBlind: 10, bigBlind: 20, buyIn: 2000, practice: false,
    autoNext: true, hostId: 'p1', handNumber: 7, dealerSeat: 1, phase: 'playing',
    log: [], logSequence: 0, revealed: [1],
    players: [
      { id: 'p1', accountId: null, name: 'restored', seat: 0, stack: 1490, bet: 10, isBot: false, folded: false, inHand: true, departing: false },
      { id: 'p2', accountId: null, name: 'bot·陪练', seat: 1, stack: 1980, bet: 20, isBot: true, folded: false, inHand: true, departing: false },
    ],
  });
  saveSnapshot(setup, {
    code: 'LOBBY7', smallBlind: 10, bigBlind: 20, buyIn: 2000, practice: false,
    autoNext: true, hostId: 'p3', handNumber: 3, dealerSeat: 0, phase: 'lobby',
    log: [], logSequence: 0, revealed: [],
    players: [
      { id: 'p3', accountId: null, name: 'waiting', seat: 0, stack: 2000, bet: 0, isBot: false, folded: false, inHand: false, departing: false },
    ],
  });
  setup.close();

  const server = await createPokerServer({ port: 0, host: '127.0.0.1', dbPath, npcTables: 0 });
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const live = server.rooms.get('LIVE42');
  assert.ok(live);
  assert.equal(live.phase, 'lobby', 'an in-progress hand is voided on restart');
  const restored = live.players.find((p) => p.name === 'restored');
  assert.equal(restored.stack, 1500, 'voided bets fold back into the seat stack');
  assert.equal(restored.connected, false);
  assert.match(live.log.at(-1).text, /作废/);

  const lobby = server.rooms.get('LOBBY7');
  assert.ok(lobby);
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.players[0].stack, 2000);
  assert.equal(lobby.handNumber, 3);
});
