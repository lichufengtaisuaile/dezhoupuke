import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { createPokerServer } from '../server.js';
import { register } from '../src/account.js';

const WAIT_MS = 5000;

const request = (socket, event, payload = {}) => new Promise((resolve, reject) => {
  socket.timeout(WAIT_MS).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
});

async function client(server, account) {
  const socket = connect(`http://127.0.0.1:${server.port}/zjh`, {
    auth: { token: account.token },
    transports: ['websocket'],
    reconnection: false,
  });
  socket.latest = null;
  socket.on('room:state', state => { socket.latest = state; });
  await once(socket, 'connect', { signal: AbortSignal.timeout(WAIT_MS) });
  return socket;
}

async function api(server, account, url) {
  const response = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    headers: { Authorization: `Bearer ${account.token}` },
  });
  return { status: response.status, body: await response.json() };
}

async function fixture(t, count = 3, options = {}) {
  const server = await createPokerServer({
    dbPath: ':memory:',
    npcTables: 0,
    zjhTurnTimeoutMs: 60000,
    zjhTrusteeDelayMs: 60000,
    zjhNextRoundDelayMs: 60000,
    ...options,
  });
  const accounts = Array.from({ length: count }, (_, index) => register(server.db, `炸金花玩家${index}`, 'test-pass'));
  const sockets = await Promise.all(accounts.map(account => client(server, account)));
  t.after(async () => {
    await server.close();
    sockets.forEach(socket => socket.disconnect());
  });
  return { server, accounts, sockets };
}

async function action(socket, state, move) {
  return request(socket, 'game:action', {
    ...move,
    roundId: state.round.id,
    turnId: state.round.turnId,
    requestId: randomUUID(),
  });
}

test('两位玩家全额带入、准备开局、私有手牌、比牌结算与离桌退款', async t => {
  const f = await fixture(t, 2);
  const created = await request(f.sockets[0], 'room:create', { minBet: 10 });
  assert.equal(created.ok, true, created.error);
  const code = created.code;
  const joined = await request(f.sockets[1], 'room:join', { code });
  assert.equal(joined.ok, true, joined.error);
  for (const account of f.accounts) {
    const overview = await api(f.server, account, '/api/me/overview');
    assert.equal(overview.body.balance, 0);
    assert.equal(overview.body.tableStack, 10000);
    assert.equal(overview.body.totalAssets, 10000);
  }
  assert.equal((await request(f.sockets[0], 'room:ready', { ready: true })).ok, true);
  assert.equal((await request(f.sockets[1], 'room:ready', { ready: true })).ok, true);
  const room = f.server.zjh.rooms.get(code);
  assert.equal(room.phase, 'playing');
  for (const socket of f.sockets) {
    assert.equal(socket.latest.round.players.filter(player => player.cards).length, 0);
    assert.equal(JSON.stringify(socket.latest).includes('accountId'), false);
  }
  const actorSeat = room.round.turnSeat;
  const actorSocket = f.sockets[room.players.findIndex(player => player.seat === actorSeat)];
  const targetSeat = room.round.players.find(player => player.seat !== actorSeat).seat;
  const peekState = actorSocket.latest;
  assert.equal((await request(actorSocket, 'game:action', {
    action: 'peek',
    roundId: peekState.round.id,
    turnId: peekState.round.turnId,
    requestId: randomUUID(),
  })).ok, true);
  assert.equal(actorSocket.latest.round.players.find(player => player.seat === actorSeat).cards.length, 3);
  assert.equal(f.sockets.find(socket => socket !== actorSocket).latest.round.players
    .find(player => player.seat === actorSeat).cards, undefined);
  const state = actorSocket.latest;
  const payload = {
    action: 'compare',
    targetSeat,
    roundId: state.round.id,
    turnId: state.round.turnId,
    requestId: randomUUID(),
  };
  const first = await request(actorSocket, 'game:action', payload);
  assert.equal(first.ok, true, first.error);
  assert.equal((await request(actorSocket, 'game:action', payload)).duplicate, true);
  assert.equal(f.server.zjh.rooms.get(code).phase, 'finished');
  assert.equal(f.server.zjh.rooms.get(code).players.reduce((sum, player) => sum + player.stack, 0), 20000);
  assert.equal(f.server.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'ZJH_SETTLE'").get().n, 2);
  for (const [index, account] of f.accounts.entries()) {
    const history = await api(f.server, account, '/api/me/zjh');
    assert.equal(history.body.total, 1);
    assert.equal(history.body.rounds[0].mySeat, index);
    assert.equal((await request(f.sockets[index], 'room:leave')).ok, true);
    assert.equal((await api(f.server, account, '/api/me/overview')).body.totalAssets,
      f.server.db.prepare('SELECT balance FROM wallets WHERE account_id = ?').get(account.accountId).balance);
  }
  assert.equal(f.server.zjh.rooms.size, 0);
});

test('牌局中可进入等待，不能看到他人手牌，下一局前自行准备', async t => {
  const f = await fixture(t, 3);
  const { code } = await request(f.sockets[0], 'room:create', { minBet: 50, twoThreeFiveBeatsTrips: true });
  await request(f.sockets[1], 'room:join', { code });
  await request(f.sockets[0], 'room:ready', { ready: true });
  await request(f.sockets[1], 'room:ready', { ready: true });
  assert.equal(f.server.zjh.rooms.get(code).phase, 'playing');
  assert.equal((await request(f.sockets[2], 'room:join', { code })).ok, true);
  const waiting = f.sockets[2].latest;
  assert.equal(waiting.players.find(player => player.id === waiting.selfId).inRound, false);
  assert.equal(waiting.round.players.some(player => player.cards), false);
  const current = f.server.zjh.rooms.get(code);
  const actor = current.players.find(player => player.seat === current.round.turnSeat);
  const actorSocket = f.sockets[f.accounts.findIndex(account => account.accountId === actor.accountId)];
  const target = current.round.players.find(player => player.seat !== actor.seat);
  assert.equal((await action(actorSocket, actorSocket.latest, { action: 'compare', targetSeat: target.seat })).ok, true);
  assert.equal(f.server.zjh.rooms.get(code).players.find(player => player.accountId === f.accounts[2].accountId).ready, false);
});

test('服务重启恢复炸金花手牌和托管筹码，原账号可重新接管', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tongzhuo-zjh-'));
  const dbPath = path.join(directory, 'test.db');
  const server = await createPokerServer({ dbPath, npcTables: 0, zjhTurnTimeoutMs: 60000, zjhTrusteeDelayMs: 60000 });
  const accounts = [register(server.db, '重连甲', 'test-pass'), register(server.db, '重连乙', 'test-pass')];
  const sockets = await Promise.all(accounts.map(account => client(server, account)));
  const { code } = await request(sockets[0], 'room:create', { minBet: 10 });
  await request(sockets[1], 'room:join', { code });
  await request(sockets[0], 'room:ready', { ready: true });
  await request(sockets[1], 'room:ready', { ready: true });
  const saved = structuredClone(server.zjh.rooms.get(code).round);
  await server.close();
  sockets.forEach(socket => socket.disconnect());

  const resumed = await createPokerServer({ dbPath, npcTables: 0, zjhTurnTimeoutMs: 60000, zjhTrusteeDelayMs: 60000 });
  let reconnected;
  t.after(async () => {
    await resumed.close();
    reconnected?.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(resumed.zjh.rooms.get(code).round, saved);
  reconnected = await client(resumed, accounts[0]);
  assert.equal((await request(reconnected, 'room:resume', { code })).ok, true);
  assert.equal(reconnected.latest.round.players.filter(player => player.cards).length, 0);
  const me = reconnected.latest.players.find(player => player.id === reconnected.latest.selfId);
  if (reconnected.latest.round.turnSeat === me.seat) {
    assert.equal((await action(reconnected, reconnected.latest, { action: 'peek' })).ok, true);
    assert.equal(reconnected.latest.round.players.filter(player => player.cards).length, 1);
  }
  assert.equal((await api(resumed, accounts[0], '/api/me/overview')).body.totalAssets, 10000);
});
