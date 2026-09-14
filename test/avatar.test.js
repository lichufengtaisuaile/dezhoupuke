import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { io } from 'socket.io-client';
import { createPokerServer } from '../server.js';
import { createDb } from '../src/db.js';
import * as accounts from '../src/account.js';

const WAIT_MS = 5000;
const PASSWORD = 'avatar-test-pass';

async function fixture(t, options = {}) {
  const server = await createPokerServer({
    port: 0, host: '127.0.0.1', dbPath: ':memory:', npcTables: 0,
    turnTimeoutMs: 60000, mahjongTurnTimeoutMs: 60000, mahjongBotDelayMs: 60000,
    ...options,
  });
  const clients = [];
  t.after(async () => {
    await server.close();
    clients.forEach(client => client.socket.disconnect());
  });
  async function connect(account, namespace = '') {
    const socket = io(`http://127.0.0.1:${server.port}${namespace}`, {
      auth: { token: account.token }, transports: ['websocket'], forceNew: true,
      reconnection: false, autoConnect: false,
    });
    const client = { socket, state: null, avatarEvents: [] };
    clients.push(client);
    socket.on('room:state', state => { client.state = state; });
    socket.on('account:avatar', event => { client.avatarEvents.push(event); });
    const connected = once(socket, 'connect', { signal: AbortSignal.timeout(WAIT_MS) });
    socket.connect();
    await connected;
    return client;
  }
  return { server, connect };
}

async function api(server, method, url, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function update(server, account, avatar, extra = {}) {
  return api(server, 'POST', '/api/me/avatar', { token: account?.token, body: { avatar, ...extra } });
}

async function request(client, event, payload = {}) {
  const response = await new Promise((resolve, reject) => {
    client.socket.timeout(WAIT_MS).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  });
  assert.equal(response?.ok, true, `${event}: ${JSON.stringify(response)}`);
  return response;
}

function stateWhere(client, predicate) {
  if (client.state && predicate(client.state)) return Promise.resolve(client.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.socket.off('room:state', listener);
      reject(new Error(`Avatar state did not arrive: ${JSON.stringify(client.state)}`));
    }, WAIT_MS);
    function listener(state) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      client.socket.off('room:state', listener);
      resolve(state);
    }
    client.socket.on('room:state', listener);
  });
}

function withoutAvatars(state) {
  const stripPlayers = players => players.map(({ avatar, ...player }) => player);
  return {
    ...state, players: stripPlayers(state.players),
    ...(state.round && typeof state.round === 'object'
      ? { round: { ...state.round, players: stripPlayers(state.round.players) } } : {}),
  };
}

test('avatar API requires a current unbanned account and rejects paths, URLs and malformed selections', async t => {
  const { server } = await fixture(t);
  const alice = accounts.register(server.db, 'avatar-alice', PASSWORD);
  const bob = accounts.register(server.db, 'avatar-bob', PASSWORD);
  assert.equal((await update(server, null, '01-corgi')).status, 401);
  assert.equal((await update(server, { token: 'invalid-token' }, '01-corgi')).status, 401);

  for (const body of [
    {}, { avatar: '' }, { avatar: 1 }, { avatar: {} }, { avatar: ['01-corgi'] },
    { avatar: '../01-corgi' }, { avatar: '/assets/avatars/01-corgi.png' },
    { avatar: 'https://example.com/avatar.png' }, { avatar: 'data:image/png;base64,AAAA' },
    { avatar: '16-unlisted' }, { avatar: '01-corgi.png' },
  ]) {
    const result = await api(server, 'POST', '/api/me/avatar', { token: alice.token, body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.ok, false);
    assert.equal(server.db.prepare('SELECT avatar FROM accounts WHERE id = ?').get(alice.accountId).avatar, null);
  }

  const saved = await update(server, alice, '15-hamster', { accountId: bob.accountId });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { ok: true, avatar: '15-hamster' });
  assert.equal(accounts.authenticate(server.db, alice.token).avatar, '15-hamster');
  assert.equal(accounts.authenticate(server.db, bob.token).avatar, null, 'body accountId cannot edit someone else');
  server.db.prepare('UPDATE accounts SET is_banned = 1 WHERE id = ?').run(alice.accountId);
  assert.equal((await update(server, alice, '01-corgi')).status, 401);
  assert.equal(server.db.prepare('SELECT avatar FROM accounts WHERE id = ?').get(alice.accountId).avatar, '15-hamster');
});

test('chosen avatar survives a new login and reopening the database, and null restores the default', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tongzhuo-avatar-'));
  const dbPath = path.join(directory, 'avatars.db');
  const { server } = await fixture(t, { dbPath });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registered = await api(server, 'POST', '/api/register', { body: { name: 'avatar-save', password: PASSWORD } });
  assert.equal(registered.status, 200);
  const account = registered.body;
  assert.equal(account.avatar, null);
  assert.equal((await update(server, account, '06-red-panda')).status, 200);
  const overview = await api(server, 'GET', '/api/me/overview', { token: account.token });
  assert.equal(overview.body.avatar, '06-red-panda');
  const loggedIn = await api(server, 'POST', '/api/login', { body: { name: account.name, password: PASSWORD } });
  assert.equal(loggedIn.status, 200);
  assert.notEqual(loggedIn.body.token, account.token);
  assert.equal(loggedIn.body.avatar, '06-red-panda');
  await server.close();
  const reopened = createDb(dbPath);
  try {
    assert.equal(accounts.authenticate(reopened, loggedIn.body.token).avatar, '06-red-panda');
    assert.equal(accounts.login(reopened, account.name, PASSWORD).avatar, '06-red-panda');
    assert.equal(reopened.prepare('SELECT balance FROM wallets WHERE account_id = ?').get(account.accountId).balance, 10000);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM ledger WHERE account_id = ?').get(account.accountId).n, 1);
  } finally { reopened.close(); }

  const fresh = await fixture(t);
  const resetAccount = accounts.register(fresh.server.db, 'avatar-reset', PASSWORD);
  assert.equal((await update(fresh.server, resetAccount, '01-corgi')).status, 200);
  assert.deepEqual((await update(fresh.server, resetAccount, null)).body, { ok: true, avatar: null });
  assert.equal((await api(fresh.server, 'GET', '/api/me/overview', { token: resetAccount.token })).body.avatar, null);
  assert.equal(accounts.login(fresh.server.db, resetAccount.name, PASSWORD).avatar, null);
});

test('migration adds an unset avatar to an existing account without changing credentials or balances', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tongzhuo-avatar-migration-'));
  const dbPath = path.join(directory, 'legacy.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let db = createDb(dbPath);
  const account = accounts.register(db, 'old-avatar', PASSWORD);
  const oldAccount = db.prepare('SELECT id, name, password_hash, created_at FROM accounts WHERE id = ?').get(account.accountId);
  const oldLedger = db.prepare('SELECT * FROM ledger WHERE account_id = ?').all(account.accountId);
  db.close();
  const legacy = new Database(dbPath);
  legacy.exec('ALTER TABLE accounts DROP COLUMN avatar');
  legacy.close();
  db = createDb(dbPath);
  try {
    assert.deepEqual(db.prepare('SELECT id, name, password_hash, created_at FROM accounts WHERE id = ?').get(account.accountId), oldAccount);
    assert.deepEqual(db.prepare('SELECT * FROM ledger WHERE account_id = ?').all(account.accountId), oldLedger);
    assert.equal(accounts.authenticate(db, account.token).avatar, null);
    assert.equal(accounts.login(db, account.name, PASSWORD).balance, 10000);
  } finally { db.close(); }
  db = createDb(dbPath);
  try {
    assert.equal(db.prepare('PRAGMA table_info(accounts)').all().filter(column => column.name === 'avatar').length, 1);
  } finally { db.close(); }
});

test('avatar changes reach the poker table and the same account across namespaces without changing the hand', async t => {
  const { server, connect } = await fixture(t);
  const alice = accounts.register(server.db, 'avatar-poker', PASSWORD);
  const bob = accounts.register(server.db, 'avatar-peer', PASSWORD);
  await update(server, alice, '01-corgi');
  const host = await connect(alice);
  const guest = await connect(bob);
  const secondTab = await connect(alice);
  const ownMahjong = await connect(alice, '/mahjong');
  const otherMahjong = await connect(bob, '/mahjong');
  const identity = await request(host, 'room:create', { smallBlind: 10, bigBlind: 20, buyIn: 2000 });
  await request(guest, 'room:join', { code: identity.code });
  await request(host, 'room:start');
  await Promise.all([host, guest].map(client => stateWhere(client, state => state.phase === 'playing')));
  assert.equal(guest.state.players.find(player => player.id === identity.playerId).avatar, '01-corgi');
  const beforeHost = structuredClone(withoutAvatars(host.state));
  const beforeGuest = structuredClone(withoutAvatars(guest.state));
  const beforeLedger = server.db.prepare('SELECT * FROM ledger ORDER BY id').all();

  assert.equal((await update(server, alice, '13-piglet')).status, 200);
  await Promise.all([host, guest].map(client => stateWhere(client, state => state.players.find(player => player.id === identity.playerId)?.avatar === '13-piglet')));
  await Promise.all([
    request(secondTab, 'lobby:list'), request(ownMahjong, 'room:list'), request(otherMahjong, 'room:list'),
  ]);
  for (const client of [host, secondTab, ownMahjong]) {
    assert.equal(client.avatarEvents.at(-1)?.avatar, '13-piglet');
    assert.equal(client.avatarEvents.at(-1)?.accountId, alice.accountId);
  }
  assert.deepEqual(guest.avatarEvents, [], 'another seated account does not receive account events');
  assert.deepEqual(otherMahjong.avatarEvents, [], 'another namespace does not broadcast account events globally');
  assert.deepEqual(withoutAvatars(host.state), beforeHost, 'changing an avatar does not change the private hand, chips or turn');
  assert.deepEqual(withoutAvatars(guest.state), beforeGuest, 'peer still receives only its own hole cards');
  assert.deepEqual(server.db.prepare('SELECT * FROM ledger ORDER BY id').all(), beforeLedger);
});

test('avatar changes refresh an active mahjong table and lobby while preserving tiles, deadlines and escrow', async t => {
  const { server, connect } = await fixture(t);
  const players = Array.from({ length: 4 }, (_, i) => accounts.register(server.db, `avatar-mj-${i}`, PASSWORD));
  await update(server, players[0], '02-lop-rabbit');
  const clients = await Promise.all(players.map(account => connect(account, '/mahjong')));
  const { code } = await request(clients[0], 'room:create', { base: 1, buyIn: 2000 });
  for (const client of clients.slice(1)) await request(client, 'room:join', { code });
  for (const client of clients) await request(client, 'room:ready', { ready: true });
  await Promise.all(clients.map(client => stateWhere(client, state => state.phase === 'playing')));
  assert.equal(clients[1].state.players.find(player => player.seat === 0).avatar, '02-lop-rabbit');
  const beforeStates = clients.map(client => structuredClone(withoutAvatars(client.state)));
  const beforeRound = structuredClone(server.mahjong.rooms.get(code).round);
  const beforeLedger = server.db.prepare('SELECT * FROM ledger ORDER BY id').all();
  assert.equal((await update(server, players[0], '15-hamster')).status, 200);
  await Promise.all(clients.map(client => stateWhere(client, state => state.players.find(player => player.seat === 0)?.avatar === '15-hamster')));
  for (const [index, client] of clients.entries()) assert.deepEqual(withoutAvatars(client.state), beforeStates[index]);
  assert.deepEqual(server.mahjong.rooms.get(code).round, beforeRound);
  assert.deepEqual(server.db.prepare('SELECT * FROM ledger ORDER BY id').all(), beforeLedger);
  const lobby = await request(clients[1], 'room:list');
  const listedPlayers = lobby.rooms.find(room => room.code === code).players;
  const publicLobby = await api(server, 'GET', '/api/mahjong/rooms');
  assert.equal(publicLobby.status, 200);
  assert.deepEqual(publicLobby.body.rooms.find(room => room.code === code).players, listedPlayers);
  assert.equal(listedPlayers.find(player => player.name === players[0].name).avatar, '15-hamster');
  assert.equal(listedPlayers.length, 4);
  for (const player of listedPlayers) {
    assert.equal(player.hand, undefined, 'lobby avatars must not expose private tiles');
    assert.equal(player.accountId, undefined);
    assert.equal(player.token, undefined);
  }
});
