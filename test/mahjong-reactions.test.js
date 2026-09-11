import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { createPokerServer } from '../server.js';
import { register } from '../src/account.js';

const tiles = value => value.split(' ');
const waiting = tiles('m1 m2 m3 p1 p2 p3 s1 s2 s3 s7 s8 s9 p9');
const rubbish = tiles('m1 m2 m4 m5 m7 m8 p1 p3 p5 p7 s2 s5 s8');
const request = (socket, event, payload = {}) => new Promise((resolve, reject) => {
  socket.timeout(4000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
});
function eventOnce(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`Missing ${event}`)); }, 4000);
    function listener(value) {
      if (!predicate(value)) return;
      clearTimeout(timer); socket.off(event, listener); resolve(value);
    }
    socket.on(event, listener);
  });
}
async function client(server, account) {
  const socket = connect(`http://127.0.0.1:${server.port}/mahjong`, {
    auth: { token: account.token }, transports: ['websocket'], reconnection: false,
  });
  socket.on('room:state', state => { socket.latest = state; });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
async function fixture(t) {
  const server = await createPokerServer({ dbPath: ':memory:', npcTables: 0,
    mahjongTurnTimeoutMs: 60000, mahjongBotDelayMs: 60000 });
  const accounts = Array.from({ length: 4 }, (_, seat) => register(server.db, `响应玩家${seat}`, 'reaction-test-pass'));
  const sockets = await Promise.all(accounts.map(account => client(server, account)));
  const extraSockets = [];
  t.after(async () => { await server.close(); [...sockets, ...extraSockets].forEach(socket => socket.disconnect()); });
  const created = await request(sockets[0], 'room:create', { base: 10, buyIn: 2000 });
  assert.equal(created.ok, true, created.error);
  for (let seat = 1; seat < 4; seat++) assert.equal((await request(sockets[seat], 'room:join', { code: created.code })).ok, true);
  for (const socket of sockets) assert.equal((await request(socket, 'room:ready', { ready: true })).ok, true);
  return { server, accounts, sockets, extraSockets, code: created.code };
}
const roomOf = fixture => fixture.server.mahjong.rooms.get(fixture.code);
async function rig(f, hands = [], wall = tiles('m9 p8 s9 m8 p7 s7')) {
  const room = structuredClone(roomOf(f));
  for (let seat = 0; seat < 4; seat++) {
    room.round.players[seat].hand = [...(hands[seat] ?? (seat === 0 ? [...rubbish, 'p9'] : rubbish))];
    room.round.players[seat].melds = [];
    room.round.players[seat].discards = [];
  }
  room.round.wall = [...wall];
  room.round.drawnTile = room.round.players[0].hand.at(-1);
  // These are deliberate server-side positions. They retain the existing escrow
  // and complete protocol path while making contested decisions deterministic.
  f.server.mahjong.store.saveRoom(room);
  f.server.mahjong.rooms.set(f.code, room);
  assert.equal((await request(f.sockets[0], 'room:trustee', { enabled: false })).ok, true);
}
function payload(f, action, tile, turnId = roomOf(f).round.turnId) {
  return { action, ...(tile === undefined ? {} : { tile }), turnId,
    roundId: roomOf(f).round.id, requestId: randomUUID() };
}
function wallet(f, seat) {
  return f.server.db.prepare('SELECT balance FROM wallets WHERE account_id = ?').get(f.accounts[seat].accountId).balance;
}

test('simultaneous Hu accepts both original revisions, preserves deadlines and replays each request exactly once', async t => {
  const f = await fixture(t);
  await rig(f, [undefined, waiting, waiting, ['p9', 'p9', ...rubbish.slice(0, 11)]]);
  assert.equal((await request(f.sockets[0], 'game:action', payload(f, 'discard', 'p9'))).ok, true);
  const windowTurn = roomOf(f).round.turnId;
  const initialDeadlines = { ...roomOf(f).deadlines };
  const firstHu = payload(f, 'hu', undefined, windowTurn);
  const secondHu = payload(f, 'hu', undefined, windowTurn);
  assert.equal(roomOf(f).responseWindowTurnId, windowTurn);
  assert.equal((await request(f.sockets[3], 'game:action', payload(f, 'pass', undefined, windowTurn))).ok, true);
  assert.equal(roomOf(f).deadlines[1], initialDeadlines[1]);
  assert.equal(roomOf(f).deadlines[2], initialDeadlines[2]);
  assert.equal(roomOf(f).deadlines[3], undefined);
  assert.equal(roomOf(f).responseWindowTurnId, windowTurn);
  assert.equal(roomOf(f).round.events.length, 0);
  const responses = await Promise.all([
    request(f.sockets[1], 'game:action', firstHu),
    request(f.sockets[2], 'game:action', secondHu),
  ]);
  for (const response of responses) assert.equal(response.ok, true, response.error);
  assert.deepEqual(roomOf(f).round.events[0].winners.map(winner => winner.seat), [1, 2]);
  assert.deepEqual(roomOf(f).players.map(player => player.stack), [1980, 2010, 2010, 2000]);
  assert.equal(roomOf(f).responseWindowTurnId, null);
  const saved = JSON.stringify(roomOf(f));
  for (const [seat, originalPayload] of [[1, firstHu], [2, secondHu]]) {
    const replay = await request(f.sockets[seat], 'game:action', originalPayload);
    assert.equal(replay.ok, true, replay.error);
    assert.equal(replay.duplicate, true);
  }
  assert.equal(JSON.stringify(roomOf(f)), saved);
  assert.equal(f.server.db.prepare('SELECT COUNT(*) AS n FROM mahjong_events').get().n, 1);
  assert.equal(f.server.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'MAHJONG_SETTLE'").get().n, 3);
  const changedReplay = await request(f.sockets[2], 'game:action', { ...secondHu, action: 'pass' });
  assert.equal(changedReplay.ok, false);
  assert.equal(JSON.stringify(roomOf(f)), saved);
});

test('a previously valid reply cannot enter a later response window even for the same tile and player', async t => {
  const f = await fixture(t);
  await rig(f, [undefined, waiting, waiting]);
  assert.equal((await request(f.sockets[0], 'game:action', payload(f, 'discard', 'p9'))).ok, true);
  const oldTurn = roomOf(f).round.turnId;
  const staleHu = payload(f, 'hu', undefined, oldTurn);
  const passed = await Promise.all([1, 2].map(seat => request(f.sockets[seat], 'game:action', payload(f, 'pass', undefined, oldTurn))));
  for (const response of passed) assert.equal(response.ok, true, response.error);
  assert.equal(roomOf(f).round.turnSeat, 1);
  assert.equal((await request(f.sockets[1], 'game:action', payload(f, 'discard', 'p9'))).ok, true);
  assert.ok(roomOf(f).responseWindowTurnId > oldTurn);
  assert.equal(roomOf(f).round.responses.tile, 'p9');
  assert.ok(roomOf(f).round.responses.candidates.some(candidate => candidate.seat === 2 && candidate.actions.includes('hu')));
  const before = JSON.stringify(roomOf(f));
  const rejected = await request(f.sockets[2], 'game:action', staleHu);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /牌局已更新/);
  assert.equal(JSON.stringify(roomOf(f)), before);
  assert.equal((await request(f.sockets[2], 'game:action', payload(f, 'hu'))).ok, true);
  assert.equal(roomOf(f).round.events.length, 1);
});

test('replacement connection owns the same seat, old tab cannot act, and disconnect can reclaim without another buy-in', async t => {
  const f = await fixture(t);
  await rig(f);
  const account = f.accounts[0];
  const playerId = roomOf(f).players[0].id;
  const beforeBringIns = f.server.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'BRING_IN'").get().n;
  const replaced = eventOnce(f.sockets[0], 'session:replaced');
  const newer = await client(f.server, account);
  f.extraSockets.push(newer);
  assert.equal((await request(newer, 'room:resume', { code: f.code })).ok, true);
  await replaced;
  assert.equal(newer.latest.selfId, playerId);
  assert.equal(roomOf(f).players[0].socketId, newer.id);
  const originalRound = JSON.stringify(roomOf(f).round);
  assert.equal((await request(f.sockets[0], 'game:action', payload(f, 'discard', 'p9'))).ok, false);
  assert.equal(JSON.stringify(roomOf(f).round), originalRound);
  f.sockets[0].disconnect();
  assert.equal((await request(newer, 'room:trustee', { enabled: false })).ok, true);
  assert.equal(roomOf(f).players[0].connected, true);
  const offline = eventOnce(f.sockets[1], 'room:state', state => state.players.some(player => player.seat === 0 && !player.connected));
  newer.disconnect();
  await offline;
  assert.equal(roomOf(f).players[0].trustee, true);
  assert.equal(wallet(f, 0), 8000);
  const resumed = await client(f.server, account);
  f.extraSockets.push(resumed);
  assert.equal((await request(resumed, 'room:resume', { code: f.code })).ok, true);
  assert.equal(resumed.latest.selfId, playerId);
  assert.equal(roomOf(f).players[0].connected, true);
  assert.equal(roomOf(f).players[0].trustee, false);
  assert.equal(JSON.stringify(roomOf(f).round), originalRound);
  assert.equal(f.server.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'BRING_IN'").get().n, beforeBringIns);
  assert.equal(f.server.db.prepare('SELECT COUNT(*) AS n FROM mahjong_seats WHERE closed = 0').get().n, 4);
});

test('pending leave keeps escrow until round completion and performs one final cashout with a recorded history', async t => {
  const f = await fixture(t);
  await rig(f, [], []);
  const originalSeat = { ...roomOf(f).players[3] };
  const leave = await request(f.sockets[3], 'room:leave');
  assert.equal(leave.ok, true, leave.error);
  assert.equal(leave.pending, true);
  assert.equal(roomOf(f).players[3].departing, true);
  assert.equal(roomOf(f).players[3].trustee, true);
  assert.equal(wallet(f, 3), 8000);
  assert.equal(f.server.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'CASH_OUT'").get().n, 0);
  const left = eventOnce(f.sockets[3], 'room:left');
  assert.equal((await request(f.sockets[0], 'game:action', payload(f, 'discard', 'p9'))).ok, true);
  await left;
  assert.equal(roomOf(f).phase, 'finished');
  assert.equal(roomOf(f).players.some(player => player.seat === 3), false);
  assert.equal(wallet(f, 3), 10000);
  assert.equal(f.server.db.prepare('SELECT closed FROM mahjong_seats WHERE id = ?').get(originalSeat.entryId).closed, 1);
  assert.equal(f.server.mahjong.store.historyPage(f.accounts[3].accountId).total, 1);
  assert.equal((await request(f.sockets[3], 'room:leave')).ok, false);
  assert.equal(f.server.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'CASH_OUT' AND account_id = ?").get(f.accounts[3].accountId).n, 1);
  assert.equal(wallet(f, 3), 10000);
});
