import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { createPokerServer } from '../server.js';
import { register } from '../src/account.js';
import { automaticMahjongAction } from '../src/mahjong-engine.js';

const request = (socket, name, data = {}) => new Promise((resolve, reject) => {
  socket.timeout(4000).emit(name, data, (error, ack) => error ? reject(error) : resolve(ack));
});
async function client(server, account) {
  const socket = connect(`http://127.0.0.1:${server.port}/mahjong`, {
    auth: { token: account.token }, transports: ['websocket'], reconnection: false,
  });
  socket.on('room:state', state => { socket.latest = state; });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
async function fixture(t, options = {}) {
  const server = await createPokerServer({ dbPath: ':memory:', npcTables: 0,
    mahjongTurnTimeoutMs: 60000, mahjongBotDelayMs: 60000, ...options });
  const accounts = Array.from({ length: 4 }, (_, n) => register(server.db, `麻友${n}`, 'test-pass'));
  const sockets = await Promise.all(accounts.map(a => client(server, a)));
  t.after(async () => { await server.close(); sockets.forEach(s => s.disconnect()); });
  const result = await request(sockets[0], 'room:create', { base: 1, buyIn: 2000 });
  assert.equal(result.ok, true, result.error);
  const code = result.code;
  assert.equal((await request(sockets[0], 'room:ready', { ready: true })).ok, true);
  for (let i = 1; i < 4; i++) {
    assert.equal((await request(sockets[i], 'room:join', { code })).ok, true);
    assert.equal(server.mahjong.rooms.get(code).players[0].ready, true, 'arriving friends preserve waiting players readiness');
  }
  return { server, accounts, sockets, code };
}
async function begin(sockets) {
  for (const socket of sockets) assert.equal((await request(socket, 'room:ready', { ready: true })).ok, true);
}
const roomOf = f => f.server.mahjong.rooms.get(f.code);
async function api(server, account, url, options) {
  const res = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    ...options, headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' },
  });
  return { status: res.status, body: await res.json() };
}
async function playToEnd(f) {
  let moves = 0;
  while (roomOf(f)?.phase === 'playing') {
    const round = roomOf(f).round;
    const candidates = f.sockets.map((socket, seat) => ({ socket, seat, move: automaticMahjongAction(round, seat) })).filter(x => x.move);
    assert.ok(candidates.length);
    // Same-turn concurrent reactions must all be accepted in the same response window.
    const replies = await Promise.all(candidates.map(({ socket, move }) => request(socket, 'game:action', {
      ...move, roundId: round.id, turnId: round.turnId, requestId: randomUUID(),
    })));
    for (const reply of replies) assert.equal(reply.ok, true, reply.error);
    assert.ok(++moves < 600, 'round should terminate');
    assert.equal(roomOf(f)?.players.reduce((sum, p) => sum + p.stack, 0), 8000);
  }
}

test('four authenticated clients: private hands, stale/duplicate guards, complete round, shared wealth, history and refunds', async t => {
  const f = await fixture(t);
  const { server, accounts, sockets, code } = f;
  await begin(sockets);
  for (const [seat, socket] of sockets.entries()) {
    assert.equal(socket.latest.phase, 'playing');
    assert.equal(socket.latest.players.find(p => p.seat === seat).hand.length, seat === 0 ? 14 : 13);
    for (const p of socket.latest.players.filter(p => p.seat !== seat)) assert.ok(!p.hand?.length);
    assert.equal(socket.latest.round.wall, undefined);
    assert.equal(JSON.stringify(socket.latest).includes(accounts[seat].token), false);
    const overview = await api(server, accounts[seat], '/api/me/overview');
    assert.equal(overview.body.balance, 8000);
    assert.equal(overview.body.tableStack, 2000);
    assert.equal(overview.body.totalAssets, 10000);
  }
  const round = roomOf(f).round;
  const move = automaticMahjongAction(round, 0);
  const payload = { ...move, roundId: round.id, turnId: round.turnId, requestId: randomUUID() };
  assert.equal((await request(sockets[0], 'game:action', payload)).ok, true);
  const saved = JSON.stringify(roomOf(f).round);
  assert.equal((await request(sockets[0], 'game:action', payload)).duplicate, true);
  assert.equal(JSON.stringify(roomOf(f).round), saved);
  assert.equal((await request(sockets[0], 'game:action', { ...payload, roundId: 'old', requestId: randomUUID() })).ok, false);
  assert.equal((await request(sockets[0], 'game:action', { ...payload, action: 'invented' })).ok, false);
  const tables = await api(server, accounts[0], '/api/me/tables');
  assert.equal(tables.body.tables.find(r => r.code === code).game, 'mahjong');
  await playToEnd(f);
  assert.equal(roomOf(f).phase, 'finished');
  for (const [seat, account] of accounts.entries()) {
    const history = (await api(server, account, '/api/me/mahjong')).body;
    assert.equal(history.total, 1);
    assert.equal(history.rounds[0].mySeat, seat);
    assert.equal(history.rounds[0].net, roomOf(f).round.players.find(p => p.seat === seat).net);
    assert.ok(history.rounds[0].players.every(p => !p.hand && !p.accountId));
  }
  const total = (await api(server, accounts[0], '/api/leaderboard')).body.entries.reduce((sum, p) => sum + p.total, 0);
  assert.equal(total, 40000);
  for (const [seat, socket] of sockets.entries()) {
    const expected = 8000 + roomOf(f).players.find(p => p.seat === seat).stack;
    assert.equal((await request(socket, 'room:leave')).ok, true);
    assert.equal((await api(server, accounts[seat], '/api/me/overview')).body.balance, expected);
  }
  assert.equal(server.mahjong.rooms.size, 0);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM mahjong_seats WHERE closed = 0').get().n, 0);
});

test('practice bots are free, server-authoritative and do not enter wealth or history', async t => {
  const server = await createPokerServer({ dbPath: ':memory:', npcTables: 0, mahjongTurnTimeoutMs: 60000, mahjongBotDelayMs: 5 });
  const account = register(server.db, '练习玩家', 'test-pass');
  const socket = await client(server, account);
  t.after(async () => { await server.close(); socket.disconnect(); });
  const result = await request(socket, 'room:create', { base: 1, buyIn: 2000, practice: true });
  assert.equal(result.ok, true, result.error);
  assert.equal(socket.latest.players.length, 4);
  assert.equal(socket.latest.players.filter(p => p.isBot).length, 3);
  assert.equal((await api(server, account, '/api/me/overview')).body.tableStack, 0);
  assert.equal((await request(socket, 'room:ready', { ready: true })).ok, true);
  assert.equal((await request(socket, 'room:trustee', { enabled: true })).ok, true);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('room:state', done); reject(new Error('practice did not finish')); }, 10000);
    function done(state) { if (state.phase === 'finished') { clearTimeout(timer); socket.off('room:state', done); resolve(); } }
    socket.on('room:state', done);
  });
  assert.equal((await api(server, account, '/api/me/mahjong')).body.total, 0);
  assert.equal((await api(server, account, '/api/me/overview')).body.balance, 10000);
  assert.equal((await request(socket, 'room:leave')).ok, true);
  assert.equal(server.mahjong.rooms.size, 0);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM mahjong_seats WHERE closed = 0').get().n, 0);
});

test('server restart restores identical concealed wall, pending decisions and escrow; account can reclaim seat', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tongzhuo-mahjong-'));
  const f = await fixture(t, { dbPath: path.join(directory, 'test.db') });
  await begin(f.sockets);
  const round = JSON.parse(JSON.stringify(roomOf(f).round));
  await f.server.close();
  f.sockets.forEach(s => s.disconnect());
  const resumed = await createPokerServer({ dbPath: path.join(directory, 'test.db'), npcTables: 0, mahjongTurnTimeoutMs: 60000 });
  let socket;
  t.after(async () => { await resumed.close(); socket?.disconnect(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(resumed.mahjong.rooms.get(f.code).round, round);
  socket = await client(resumed, f.accounts[0]);
  assert.equal((await request(socket, 'room:resume', { code: f.code })).ok, true);
  assert.equal(socket.latest.selfId, roomOf(f).players[0].id);
  assert.equal(socket.latest.players.filter(p => p.hand?.length).length, 1);
  assert.equal((await api(resumed, f.accounts[0], '/api/me/overview')).body.totalAssets, 10000);
  const before = resumed.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'BRING_IN'").get().n;
  assert.equal((await request(socket, 'room:resume', { code: f.code })).ok, true);
  assert.equal(resumed.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'BRING_IN'").get().n, before);
});

test('escrow blocks subsidy farming and banned accounts cannot issue Mahjong actions', async t => {
  const f = await fixture(t, { adminToken: 'test-admin' });
  const { server, accounts, sockets, code } = f;
  server.db.prepare('UPDATE wallets SET balance = 0 WHERE account_id = ?').run(accounts[0].accountId);
  const subsidy = await api(server, accounts[0], '/api/me/subsidy', { method: 'POST', body: '{}' });
  assert.equal(subsidy.status, 400);
  const ban = await fetch(`http://127.0.0.1:${server.port}/api/admin/users/${accounts[0].accountId}/ban`, {
    method: 'POST', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ banned: true }),
  });
  assert.equal(ban.status, 200);
  assert.ok(!server.mahjong.rooms.get(code).players.some(p => p.accountId === accounts[0].accountId));
  assert.equal((await api(server, accounts[0], '/api/me/mahjong')).status, 401);
  assert.equal(sockets[1].connected, true);
});
