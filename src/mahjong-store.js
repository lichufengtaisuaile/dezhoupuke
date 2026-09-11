import { GameError } from './errors.js';
import { balanceOf, credit } from './wallet.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mahjong_rooms (
  code TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mahjong_seats (
  id TEXT PRIMARY KEY, room_code TEXT NOT NULL, account_id TEXT,
  seat INTEGER NOT NULL, buy_in INTEGER NOT NULL, stack INTEGER NOT NULL CHECK(stack >= 0),
  practice INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mahjong_seats_active ON mahjong_seats(account_id, closed, practice);
CREATE TABLE IF NOT EXISTS mahjong_events (
  id TEXT PRIMARY KEY, room_code TEXT NOT NULL, round_id TEXT NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mahjong_rounds (
  id TEXT PRIMARY KEY, room_code TEXT NOT NULL, round_number INTEGER NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mahjong_round_players (
  round_id TEXT NOT NULL REFERENCES mahjong_rounds(id), account_id TEXT NOT NULL,
  seat INTEGER NOT NULL, net INTEGER NOT NULL, wins INTEGER NOT NULL,
  starting_stack INTEGER NOT NULL, ending_stack INTEGER NOT NULL,
  PRIMARY KEY(round_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_mahjong_round_players_account ON mahjong_round_players(account_id, round_id);
`;

function requireThat(condition, message) {
  if (!condition) throw new GameError(message);
}

function chips(value, label = '筹码') {
  requireThat(Number.isSafeInteger(value) && value >= 0, `${label}不正确`);
  return value;
}

function text(value) { return typeof value === 'string' ? value : ''; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function roundNumber(room) { return room.round?.number ?? room.roundNumber ?? 1; }
function seatKey(player) { return player.entryId ?? player.id; }

// Event projections are deliberately explicit: no wall, pending responses or opponents' hands.
function publicMeld(meld) {
  return { kind: text(meld.kind ?? meld.type), tile: meld.tile, tiles: clone(meld.tiles ?? []), sourceSeat: meld.sourceSeat, fromSeat: meld.fromSeat };
}

function publicEvent(event) {
  return {
    id: event.id, kind: event.kind, at: event.at, sourceSeat: event.sourceSeat, seat: event.seat,
    concealed: Boolean(event.concealed),
    selfDraw: Boolean(event.selfDraw), tile: event.tile, gangKind: event.gangKind,
    changes: event.changes.map(({ seat, delta }) => ({ seat, delta })),
    winners: (event.winners ?? []).map((winner) => ({
      seat: winner.seat, name: text(winner.name), multiplier: winner.multiplier,
      patterns: clone(winner.patterns ?? []), tiles: clone(winner.tiles ?? []),
      ...(winner.hand ? { hand: {
        name: text(winner.hand.name), tiles: clone(winner.hand.tiles ?? []),
        concealedTiles: clone(winner.hand.concealedTiles ?? []),
        melds: (winner.hand.melds ?? []).map(publicMeld),
        multiplier: winner.hand.multiplier, patterns: clone(winner.hand.patterns ?? []),
      } } : {}),
    })),
  };
}

/** Persistent escrow, snapshots and table-only settlement memos share one SQLite transaction. */
export function createMahjongStore(db) {
  db.exec(SCHEMA);

  function loadRooms() {
    // A corrupt monetary snapshot must fail loudly rather than silently losing a player's escrow.
    return db.prepare('SELECT payload FROM mahjong_rooms ORDER BY code').all().map(({ payload }) => JSON.parse(payload));
  }

  function validateRoom(room) {
    requireThat(room && typeof room.code === 'string' && room.code.length > 0, '麻将房间不存在');
    requireThat(Array.isArray(room.players) && room.players.length <= 4, '麻将座位数据不正确');
    const ids = new Set(), seats = new Set(), accounts = new Set();
    for (const player of room.players) {
      requireThat(typeof player.id === 'string' && player.id && !ids.has(player.id), '麻将座位标识重复');
      requireThat(Number.isInteger(player.seat) && player.seat >= 0 && player.seat < 4 && !seats.has(player.seat), '麻将座位不正确');
      chips(player.stack);
      if (!room.practice) {
        requireThat(typeof player.accountId === 'string' && player.accountId && !accounts.has(player.accountId), '正式桌需要独立账号');
        accounts.add(player.accountId);
      }
      ids.add(player.id); seats.add(player.seat);
    }
  }

  function writeRoom(room, events = room.round?.events ?? []) {
    validateRoom(room);
    const previous = db.prepare('SELECT payload FROM mahjong_rooms WHERE code = ?').get(room.code);
    if (previous) requireThat(Boolean(JSON.parse(previous.payload).practice) === Boolean(room.practice), '不能改变麻将房间筹码模式');
    const activeSeats = db.prepare('SELECT * FROM mahjong_seats WHERE room_code = ? AND closed = 0').all(room.code);
    requireThat(activeSeats.length === room.players.length, '请通过入桌或离桌结算更新座位');
    const deltas = new Map(room.players.map((player) => [player.seat, 0]));

    for (const event of events) {
      requireThat(room.round?.id && typeof event.id === 'string' && event.id, '麻将结算标识不正确');
      requireThat(['hu', 'gang'].includes(event.kind) && Array.isArray(event.changes), '麻将结算数据不正确');
      const seenSeats = new Set();
      let sum = 0;
      for (const change of event.changes) {
        requireThat(Number.isInteger(change.seat) && change.seat >= 0 && change.seat < 4 && !seenSeats.has(change.seat), '麻将结算座位不正确');
        requireThat(Number.isSafeInteger(change.delta), '麻将结算筹码不正确');
        seenSeats.add(change.seat);
        sum += change.delta;
        requireThat(Number.isSafeInteger(sum), '麻将结算筹码过大');
      }
      requireThat(sum === 0, '麻将结算筹码必须守恒');
      const payload = JSON.stringify(publicEvent(event));
      const existing = db.prepare('SELECT room_code, round_id, payload FROM mahjong_events WHERE id = ?').get(event.id);
      if (existing) {
        requireThat(existing.room_code === room.code && existing.round_id === room.round.id && existing.payload === payload, '重复麻将结算内容不一致');
        continue;
      }
      for (const { seat, delta } of event.changes) {
        requireThat(deltas.has(seat), '麻将结算玩家不在桌上');
        const next = deltas.get(seat) + delta;
        requireThat(Number.isSafeInteger(next), '麻将结算筹码过大');
        deltas.set(seat, next);
      }
      db.prepare('INSERT INTO mahjong_events (id, room_code, round_id, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(event.id, room.code, room.round.id, payload, event.at ?? Date.now());
      if (!room.practice) {
        for (const { seat, delta } of event.changes) {
          if (!delta) continue;
          const player = room.players.find((entry) => entry.seat === seat);
          // Memos describe movement between table stacks; spendable wallet balances stay untouched.
          db.prepare(`INSERT INTO ledger (account_id, type, amount, balance_after, ref_type, ref_id, created_at)
            VALUES (?, 'MAHJONG_SETTLE', ?, ?, 'mahjong-event', ?, ?)`)
            .run(player.accountId, delta, balanceOf(db, player.accountId), event.id, event.at ?? Date.now());
        }
      }
    }

    for (const player of room.players) {
      const prior = activeSeats.find((seat) => seat.id === seatKey(player));
      requireThat(prior && prior.seat === player.seat && prior.account_id === (player.accountId ?? null)
        && Boolean(prior.practice) === Boolean(room.practice), '麻将座位身份不一致');
      if (!room.practice) requireThat(player.stack === prior.stack + deltas.get(player.seat), '麻将筹码变化缺少结算记录');
      db.prepare('UPDATE mahjong_seats SET stack = ? WHERE id = ?').run(player.stack, seatKey(player));
    }
    db.prepare(`INSERT INTO mahjong_rooms (code, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(room.code, JSON.stringify(room), Date.now());
    saveHistory(room);
    return true;
  }

  function saveHistory(room) {
    const round = room.round;
    if (room.practice || round?.phase !== 'finished') return;
    if (db.prepare('SELECT 1 FROM mahjong_rounds WHERE id = ?').get(round.id)) return;
    requireThat(Array.isArray(round.players) && round.players.length === 4, '麻将整局记录缺少玩家');
    const players = round.players.map((player) => {
      const startingStack = chips(player.startStack, '开局筹码');
      const endingStack = chips(player.stack, '结算筹码');
      const wins = chips(player.huCount ?? 0, '胡牌次数');
      requireThat(typeof player.accountId === 'string' && player.accountId, '麻将战绩缺少玩家账号');
      return { seat: player.seat, name: text(player.name), net: endingStack - startingStack,
        wins, startingStack, endingStack, accountId: player.accountId };
    });
    requireThat(players.reduce((sum, player) => sum + player.net, 0) === 0, '麻将整局筹码必须守恒');
    const events = db.prepare('SELECT payload FROM mahjong_events WHERE round_id = ? ORDER BY created_at, rowid')
      .all(round.id).map(({ payload }) => JSON.parse(payload));
    const history = { roundId: round.id, roomCode: room.code, roundNumber: roundNumber(room),
      time: round.finishedAt ?? Date.now(), base: room.base ?? round.base, practice: false,
      reason: round.endReason ?? round.result?.reason ?? null,
      players: players.map(({ accountId, ...player }) => player), events };
    db.prepare('INSERT INTO mahjong_rounds (id, room_code, round_number, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(round.id, room.code, roundNumber(room), JSON.stringify(history), history.time);
    for (const player of players) {
      db.prepare(`INSERT INTO mahjong_round_players
        (round_id, account_id, seat, net, wins, starting_stack, ending_stack) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(round.id, player.accountId, player.seat, player.net, player.wins, player.startingStack, player.endingStack);
    }
  }

  function saveRoom(room, { events = room.round?.events ?? [] } = {}) {
    return db.transaction(() => writeRoom(room, events))();
  }

  function seatIn(nextRoom, player) {
    return db.transaction(() => {
      validateRoom(nextRoom);
      requireThat(nextRoom.players.some((entry) => entry.id === player.id && entry.stack === player.stack
        && entry.accountId === player.accountId && entry.seat === player.seat), '入桌玩家不在房间快照中');
      const entryId = seatKey(player);
      requireThat(typeof entryId === 'string' && entryId, '入桌标识不正确');
      const existing = db.prepare('SELECT * FROM mahjong_seats WHERE id = ?').get(entryId);
      if (existing) {
        requireThat(!existing.closed && existing.room_code === nextRoom.code && existing.account_id === (player.accountId ?? null)
          && existing.seat === player.seat && existing.buy_in === player.stack
          && Boolean(existing.practice) === Boolean(nextRoom.practice), '重复入桌请求不一致');
        return false;
      }
      chips(player.stack, '带入金额');
      requireThat(player.stack > 0, '带入金额需要大于零');
      if (!nextRoom.practice) {
        requireThat(!db.prepare('SELECT 1 FROM mahjong_seats WHERE account_id = ? AND closed = 0 AND practice = 0').get(player.accountId), '已有进行中的麻将牌桌');
        chips(balanceOf(db, player.accountId), '账户余额');
        credit(db, player.accountId, 'BRING_IN', -player.stack, 'mahjong-seat', entryId);
      }
      db.prepare(`INSERT INTO mahjong_seats (id, room_code, account_id, seat, buy_in, stack, practice, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entryId, nextRoom.code, player.accountId ?? null, player.seat, player.stack, player.stack, nextRoom.practice ? 1 : 0, Date.now());
      writeRoom(nextRoom);
      return true;
    })();
  }

  function seatOut(nextRoom, player, roomCode = nextRoom?.code, practice = false) {
    return db.transaction(() => {
      const entryId = seatKey(player);
      const prior = db.prepare('SELECT * FROM mahjong_seats WHERE id = ?').get(entryId);
      requireThat(prior && prior.room_code === roomCode && prior.account_id === (player.accountId ?? null)
        && prior.seat === player.seat && Boolean(prior.practice) === Boolean(practice), '离桌玩家身份不一致');
      if (prior.closed) {
        requireThat(prior.stack === player.stack, '重复离桌请求不一致');
        return false;
      }
      const oldRoom = db.prepare('SELECT payload FROM mahjong_rooms WHERE code = ?').get(roomCode);
      requireThat(oldRoom, '麻将房间快照不存在');
      const snapshot = JSON.parse(oldRoom.payload);
      requireThat(!snapshot.round || snapshot.round.phase === 'finished', '本局结束后才能离桌');
      requireThat(player.stack === prior.stack, '离桌筹码与结算不一致');
      if (nextRoom) {
        requireThat(nextRoom.code === roomCode && Boolean(nextRoom.practice) === Boolean(practice)
          && !nextRoom.players.some((entry) => entry.id === player.id), '离桌快照不正确');
      }
      if (!practice) {
        chips(balanceOf(db, player.accountId) + prior.stack, '退回后的账户余额');
        credit(db, player.accountId, 'CASH_OUT', prior.stack, 'mahjong-seat', entryId);
      }
      db.prepare('UPDATE mahjong_seats SET closed = 1, closed_at = ? WHERE id = ?').run(Date.now(), entryId);
      if (nextRoom) writeRoom(nextRoom);
      else deleteEmptyRoom(roomCode);
      return true;
    })();
  }

  function deleteEmptyRoom(code) {
    requireThat(!db.prepare('SELECT 1 FROM mahjong_seats WHERE room_code = ? AND closed = 0').get(code), '麻将房间还有未退回的筹码');
    return db.prepare('DELETE FROM mahjong_rooms WHERE code = ?').run(code).changes > 0;
  }

  function historyPage(accountId, requestedPage = 1) {
    const page = Math.max(1, Math.min(1000000, Number.parseInt(requestedPage, 10) || 1));
    const pageSize = 20;
    const total = db.prepare('SELECT COUNT(*) AS count FROM mahjong_round_players WHERE account_id = ?').get(accountId).count;
    const rows = db.prepare(`SELECT r.payload, p.net, p.wins, p.seat, p.starting_stack, p.ending_stack
      FROM mahjong_round_players p JOIN mahjong_rounds r ON r.id = p.round_id WHERE p.account_id = ?
      ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(accountId, pageSize, (page - 1) * pageSize);
    return { page, pageSize, total, rounds: rows.map((row) => ({ ...JSON.parse(row.payload), net: row.net,
      wins: row.wins, mySeat: row.seat, startingStack: row.starting_stack, endingStack: row.ending_stack })) };
  }

  function overview(accountId) {
    return db.prepare(`SELECT COUNT(*) AS mahjongRounds, COALESCE(SUM(net), 0) AS mahjongNet,
      COALESCE(SUM(wins), 0) AS mahjongWins FROM mahjong_round_players WHERE account_id = ?`).get(accountId);
  }

  function activeAssets() {
    return new Map(db.prepare(`SELECT account_id, SUM(stack) AS stack FROM mahjong_seats
      WHERE closed = 0 AND practice = 0 GROUP BY account_id`).all().map((row) => [row.account_id, row.stack]));
  }

  function myTables(accountId) {
    return loadRooms().flatMap((room) => {
      const player = room.players.find((entry) => entry.accountId === accountId);
      return player ? [{ game: 'mahjong', code: room.code, base: room.base, buyIn: room.buyIn,
        practice: Boolean(room.practice), playing: Boolean(room.round && room.round.phase !== 'finished'),
        myStack: player.stack }] : [];
    });
  }

  return { saveRoom, persistRoom: saveRoom, commitRound: (room, events) => saveRoom(room, { events }),
    loadRooms, seatIn, seatOut, deleteRoom: deleteEmptyRoom, historyPage, overview, activeAssets, myTables };
}
