import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDb } from '../src/db.js';
import { createMahjongStore } from '../src/mahjong-store.js';
import { balanceOf, credit, grantRegister } from '../src/wallet.js';
import * as stats from '../src/stats.js';
import { usersPage } from '../src/admin.js';

function setup(t, dbPath = ':memory:') {
  const db = createDb(dbPath);
  const store = createMahjongStore(db);
  t.after(() => { if (db.open) db.close(); });
  return { db, store };
}

function addAccount(db, id) {
  db.prepare('INSERT INTO accounts (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, `玩家${id}`, 'fixture-password-hash', 1);
  grantRegister(db, id);
  return id;
}

function player(accountId, seat, stack = 2000) {
  return { id: `player-${accountId ?? seat}`, entryId: `entry-${accountId ?? seat}`, accountId,
    name: `玩家${seat}`, seat, stack, connected: true };
}

function room(practice = false) {
  return { code: 'MJTEST', base: 10, buyIn: 2000, practice, phase: 'waiting', roundNumber: 0, round: null, players: [] };
}

function fourPlayers(db, store, practice = false) {
  const table = room(practice);
  for (let seat = 0; seat < 4; seat++) {
    const participant = player(practice ? null : addAccount(db, `account-${seat}`), seat);
    table.players.push(participant);
    store.seatIn(table, participant);
  }
  return table;
}

function startRound(table) {
  table.phase = 'playing'; table.roundNumber++;
  table.round = { id: 'round-1', number: table.roundNumber, phase: 'playing', base: table.base,
    players: table.players.map((entry) => ({ ...entry, startStack: entry.stack, huCount: 0,
      hand: ['hidden-hand', entry.seat], melds: [], discards: [] })),
    wall: ['hidden-wall'], pending: { responses: { 1: 'pass' } }, turnId: 9, events: [] };
  return table;
}

function finishRound(table) {
  const next = structuredClone(table);
  next.phase = 'finished'; next.round.phase = 'finished'; next.round.finishedAt = 123456789;
  next.round.endReason = 'wallEmpty';
  const changes = next.players.map((entry) => ({ seat: entry.seat, delta: entry.seat === 0 ? 30 : -10 }));
  for (const entry of next.players) entry.stack += changes[entry.seat].delta;
  for (const entry of next.round.players) {
    entry.stack += changes[entry.seat].delta; entry.net = changes[entry.seat].delta;
    if (entry.seat === 0) entry.huCount++;
  }
  next.round.events.push({ id: 'round-1:1', kind: 'hu', at: 123456780, sourceSeat: 0, selfDraw: true,
    changes, winners: [{ seat: 0, name: '玩家0', multiplier: 1, patterns: ['平胡'],
      tiles: [1, 2, 3], hand: { name: '平胡', tiles: [1, 2, 3], concealedTiles: [1, 2, 3],
        melds: [], multiplier: 1, patterns: ['平胡'] } }],
    privateDebug: { wall: ['must-not-be-public'], opponents: ['hidden-hand'] } });
  return next;
}

test('mahjong bring-in and cash-out are exactly once, with entry IDs independent from player IDs', (t) => {
  const { db, store } = setup(t);
  const accountId = addAccount(db, 'alice');
  const participant = player(accountId, 0);
  const table = room(); table.players.push(participant);
  assert.equal(store.seatIn(table, participant), true);
  assert.equal(store.seatIn(table, participant), false);
  assert.equal(balanceOf(db, accountId), 8000);
  assert.equal(store.activeAssets().get(accountId), 2000);
  assert.equal(store.myTables(accountId)[0].game, 'mahjong');
  assert.throws(() => store.deleteRoom(table.code), /未退回/);
  assert.equal(store.seatOut(null, participant, table.code, false), true);
  assert.equal(store.seatOut(null, participant, table.code, false), false);
  assert.equal(balanceOf(db, accountId), 10000);
  assert.equal(store.activeAssets().size, 0);
  assert.deepEqual(store.loadRooms(), []);
  const entries = db.prepare("SELECT type, amount, ref_id FROM ledger WHERE ref_type = 'mahjong-seat' ORDER BY id").all();
  assert.deepEqual(entries, [{ type: 'BRING_IN', amount: -2000, ref_id: participant.entryId },
    { type: 'CASH_OUT', amount: 2000, ref_id: participant.entryId }]);
  participant.entryId = 'second-visit';
  assert.equal(store.seatIn(table, participant), true);
  assert.equal(balanceOf(db, accountId), 8000);
});

test('mahjong insufficient wallet and malformed snapshots roll back escrow, ledger and room together', (t) => {
  const { db, store } = setup(t);
  const accountId = addAccount(db, 'poor');
  const participant = player(accountId, 0, 11000);
  const table = room(); table.players.push(participant);
  assert.throws(() => store.seatIn(table, participant), /余额不足/);
  assert.equal(balanceOf(db, accountId), 10000);
  assert.equal(store.loadRooms().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mahjong_seats').get().n, 0);
  participant.stack = 2000;
  table.players.push(player('missing-account', 1));
  assert.throws(() => store.seatIn(table, participant), /入桌或离桌/);
  assert.equal(balanceOf(db, accountId), 10000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'BRING_IN'").get().n, 0);
});

test('mahjong settlement conserves escrow, is idempotent and leaves spendable wallet unchanged', (t) => {
  const { db, store } = setup(t);
  const table = startRound(fourPlayers(db, store));
  store.saveRoom(table);
  const finished = finishRound(table);
  store.saveRoom(finished);
  store.commitRound(finished, finished.round.events);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mahjong_events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mahjong_rounds').get().n, 1);
  const memos = db.prepare("SELECT amount, balance_after FROM ledger WHERE type = 'MAHJONG_SETTLE'").all();
  assert.equal(memos.length, 4);
  assert.equal(memos.reduce((sum, entry) => sum + entry.amount, 0), 0);
  assert.ok(memos.every((entry) => entry.balance_after === 8000));
  assert.deepEqual([...store.activeAssets().values()].sort((a, b) => a - b), [1990, 1990, 1990, 2030]);
  while (finished.players.length) {
    const removed = finished.players.shift();
    store.seatOut(finished.players.length ? finished : null, removed, finished.code, false);
  }
  const balances = db.prepare('SELECT balance FROM wallets ORDER BY balance').all().map((entry) => entry.balance);
  assert.deepEqual(balances, [9990, 9990, 9990, 10030]);
});

test('mahjong rejects fabricated chips, reused event IDs and stale monetary snapshots atomically', (t) => {
  const { db, store } = setup(t);
  const table = startRound(fourPlayers(db, store)); store.saveRoom(table);
  const fabricated = structuredClone(table); fabricated.players[0].stack++;
  assert.throws(() => store.saveRoom(fabricated), /缺少结算/);
  const invalid = finishRound(table); invalid.players[0].stack++;
  assert.throws(() => store.saveRoom(invalid), /缺少结算/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mahjong_events').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'MAHJONG_SETTLE'").get().n, 0);
  const finished = finishRound(table); store.saveRoom(finished);
  const reused = structuredClone(finished); reused.round.events[0].winners[0].name = 'changed';
  assert.throws(() => store.saveRoom(reused), /内容不一致/);
  assert.throws(() => store.saveRoom(table), /缺少结算/);
  assert.equal(store.loadRooms()[0].players[0].stack, 2030);
});

test('mahjong cannot cash out while a round is active or erase another player escrow', (t) => {
  const { db, store } = setup(t);
  const table = startRound(fourPlayers(db, store)); store.saveRoom(table);
  const removed = table.players[0];
  assert.throws(() => store.seatOut(null, removed, table.code, false), /本局结束/);
  assert.equal(balanceOf(db, removed.accountId), 8000);
  const finished = finishRound(table); store.saveRoom(finished);
  assert.throws(() => store.seatOut(null, finished.players[0], table.code, false), /未退回/);
  assert.equal(balanceOf(db, removed.accountId), 8000);
  assert.equal(store.activeAssets().get(removed.accountId), 2030);
});

test('mahjong restart restores pending round privately and retains completed settlement only once', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mahjong-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const filename = path.join(dir, 'test.db');
  let db = createDb(filename); let store = createMahjongStore(db);
  const table = startRound(fourPlayers(db, store)); store.saveRoom(table);
  db.close(); db = createDb(filename); store = createMahjongStore(db);
  assert.deepEqual(store.loadRooms()[0], table);
  const finished = finishRound(table); store.saveRoom(finished);
  db.close(); db = createDb(filename); store = createMahjongStore(db);
  t.after(() => { if (db.open) db.close(); });
  store.saveRoom(store.loadRooms()[0]);
  assert.equal(store.historyPage(table.players[0].accountId).total, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE type = 'MAHJONG_SETTLE'").get().n, 4);
  db.close();
});

test('mahjong history is private to participants and exposes only revealed winning cards', (t) => {
  const { db, store } = setup(t);
  const table = startRound(fourPlayers(db, store)); store.saveRoom(table);
  const finished = finishRound(table); store.saveRoom(finished);
  const accountId = table.players[1].accountId;
  const history = store.historyPage(accountId);
  assert.equal(history.total, 1); assert.equal(history.rounds[0].net, -10);
  assert.equal(history.rounds[0].startingStack, 2000); assert.equal(history.rounds[0].endingStack, 1990);
  assert.deepEqual(history.rounds[0].events[0].winners[0].tiles, [1, 2, 3]);
  for (const secret of ['hidden-hand', 'hidden-wall', 'privateDebug', 'must-not-be-public', 'account-0', 'password']) {
    assert.ok(!JSON.stringify(history).includes(secret), `history leaked ${secret}`);
  }
  assert.equal(store.historyPage('unrelated-account').total, 0);
  assert.deepEqual(store.overview(table.players[0].accountId), { mahjongRounds: 1, mahjongNet: 30, mahjongWins: 1 });
});

test('mahjong and slots spend the same available wallet without spending table escrow', (t) => {
  const { db, store } = setup(t);
  const accountId = addAccount(db, 'cross-game');
  const participant = player(accountId, 0); const table = room(); table.players.push(participant);
  store.seatIn(table, participant);
  credit(db, accountId, 'SLOT_BET', -7900, 'spin', 'spin-one');
  assert.equal(balanceOf(db, accountId), 100);
  assert.throws(() => credit(db, accountId, 'SLOT_BET', -200, 'spin', 'spin-two'), /余额不足/);
  assert.equal(store.activeAssets().get(accountId), 2000);
  store.seatOut(null, participant, table.code, false);
  assert.equal(balanceOf(db, accountId), 2100);
});

test('mahjong practice keeps free chips isolated from wallet, fortune and personal history', (t) => {
  const { db, store } = setup(t);
  const table = startRound(fourPlayers(db, store, true)); store.saveRoom(table);
  const finished = finishRound(table); store.saveRoom(finished);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mahjong_rounds').get().n, 0);
  assert.equal(store.activeAssets().size, 0);
  while (finished.players.length) {
    const removed = finished.players.shift();
    store.seatOut(finished.players.length ? finished : null, removed, finished.code, true);
  }
  assert.equal(store.loadRooms().length, 0);
});

test('shared overview, fortune ranking and admin include pending mahjong escrow and completed net', (t) => {
  const { db, store } = setup(t);
  const table = startRound(fourPlayers(db, store));
  table.players[0].departing = true;
  store.saveRoom(table);
  const accountId = table.players[0].accountId;
  const pending = stats.overview(db, new Map(), accountId);
  assert.equal(pending.tableStack, 2000);
  assert.equal(pending.totalAssets, 10000);
  const finished = finishRound(table); store.saveRoom(finished);
  credit(db, accountId, 'SLOT_BET', -5, 'spin', 'profile-spin');
  db.prepare('INSERT INTO spins (id, account_id, bet, reels, payout, net, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('profile-spin', accountId, 5, '[]', 0, -5, 1);
  const overview = stats.overview(db, new Map(), accountId);
  assert.equal(overview.mahjongRounds, 1);
  assert.equal(overview.mahjongHuCount, 1);
  assert.equal(overview.mahjongNet, 30);
  assert.equal(overview.netProfit, 25);
  assert.equal(overview.totalAssets, 10025);
  assert.equal(overview.rank, 1);
  assert.equal(stats.leaderboard(db, new Map())[0].total, 10025);
  const admin = usersPage(db, new Map()).users.find((entry) => entry.id === accountId);
  assert.equal(admin.tableStack, 2030);
  assert.equal(admin.totalAssets, 10025);
  assert.equal(admin.netProfit, 25);
  assert.equal(admin.mahjongRounds, 1);
  assert.equal(admin.mahjongHuCount, 1);
});

test('shared stats remain compatible with databases before Mahjong initializes and pending poker departures', (t) => {
  const db = createDb(':memory:'); t.after(() => db.close());
  const accountId = addAccount(db, 'legacy-stats');
  credit(db, accountId, 'BRING_IN', -500, 'test', 'poker-seat');
  const rooms = new Map([['POKER', { players: [{ accountId, stack: 500, departing: true }] }]]);
  const overview = stats.overview(db, rooms, accountId);
  assert.equal(overview.totalAssets, 10000);
  assert.equal(overview.mahjongRounds, 0);
  assert.equal(overview.mahjongNet, 0);
  assert.equal(usersPage(db, rooms).users[0].totalAssets, 10000);
});
