import { GameError } from './errors.js';
import { balanceOf, credit } from './wallet.js';
import { evaluateZjhHand } from './zjh-engine.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS zjh_rooms (
  code TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS zjh_seats (
  id TEXT PRIMARY KEY, room_code TEXT NOT NULL, account_id TEXT NOT NULL,
  seat INTEGER NOT NULL, buy_in INTEGER NOT NULL, stack INTEGER NOT NULL CHECK(stack >= 0),
  closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_zjh_seats_active ON zjh_seats(account_id, closed);
CREATE TABLE IF NOT EXISTS zjh_rounds (
  id TEXT PRIMARY KEY, room_code TEXT NOT NULL, round_number INTEGER NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS zjh_round_players (
  round_id TEXT NOT NULL REFERENCES zjh_rounds(id), account_id TEXT NOT NULL,
  seat INTEGER NOT NULL, net INTEGER NOT NULL, is_winner INTEGER NOT NULL,
  starting_stack INTEGER NOT NULL, ending_stack INTEGER NOT NULL, hand_name TEXT,
  PRIMARY KEY(round_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_zjh_round_players_account ON zjh_round_players(account_id, round_id);
`;

function requireThat(condition, message) {
  if (!condition) throw new GameError(message);
}

function chips(value, label = '筹码') {
  requireThat(Number.isSafeInteger(value) && value >= 0, `${label}不正确`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function seatKey(player) {
  return player.entryId ?? player.id;
}

function roomAssets(room) {
  const stacks = room.players.reduce((sum, player) => sum + chips(player.stack), 0);
  const pot = room.round?.phase === 'playing' ? chips(room.round.pot, '底池') : 0;
  return chips(stacks + pot, '牌桌总筹码');
}

function publicHistory(room) {
  const round = room.round;
  return {
    roundId: round.id,
    roomCode: room.code,
    roundNumber: room.roundNumber,
    time: round.finishedAt ?? Date.now(),
    minBet: room.minBet,
    twoThreeFiveBeatsTrips: room.twoThreeFiveBeatsTrips,
    finalPot: round.finalPot,
    reason: round.endReason,
    players: round.players.map(player => ({
      name: player.name,
      seat: player.seat,
      net: player.net,
      isWinner: player.seat === round.result?.winnerSeat,
      seen: player.seen,
      folded: player.folded,
      hand: round.publicRevealSeats.includes(player.seat) ? evaluateZjhHand(player.cards) : null,
      cards: round.publicRevealSeats.includes(player.seat) ? clone(player.cards) : null,
    })),
  };
}

export function createZjhStore(db) {
  db.exec(SCHEMA);

  function validateRoom(room) {
    requireThat(room && typeof room.code === 'string' && room.code, '炸金花房间不存在');
    requireThat(Number.isSafeInteger(room.minBet) && room.minBet > 0, '最小下注不正确');
    requireThat(Array.isArray(room.players) && room.players.length <= 8, '炸金花座位数据不正确');
    const ids = new Set();
    const seats = new Set();
    const accounts = new Set();
    for (const player of room.players) {
      requireThat(typeof player.id === 'string' && player.id && !ids.has(player.id), '炸金花座位标识重复');
      requireThat(typeof player.accountId === 'string' && player.accountId && !accounts.has(player.accountId), '炸金花账号重复');
      requireThat(Number.isInteger(player.seat) && player.seat >= 0 && player.seat < 8 && !seats.has(player.seat), '炸金花座位不正确');
      chips(player.stack);
      ids.add(player.id);
      seats.add(player.seat);
      accounts.add(player.accountId);
    }
    roomAssets(room);
  }

  function saveHistory(room) {
    const round = room.round;
    if (round?.phase !== 'finished') return;
    if (db.prepare('SELECT 1 FROM zjh_rounds WHERE id = ?').get(round.id)) return;
    const players = round.players.map(player => ({
      accountId: player.accountId,
      seat: player.seat,
      net: chips(player.stack, '结算筹码') - chips(player.startStack, '开局筹码'),
      isWinner: player.seat === round.result?.winnerSeat,
      startingStack: player.startStack,
      endingStack: player.stack,
      handName: evaluateZjhHand(player.cards).name,
    }));
    requireThat(players.reduce((sum, player) => sum + player.net, 0) === 0, '炸金花结算筹码必须守恒');
    const history = publicHistory(room);
    db.prepare('INSERT INTO zjh_rounds (id, room_code, round_number, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(round.id, room.code, room.roundNumber, JSON.stringify(history), history.time);
    const insertPlayer = db.prepare(`INSERT INTO zjh_round_players
      (round_id, account_id, seat, net, is_winner, starting_stack, ending_stack, hand_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMemo = db.prepare(`INSERT INTO ledger
      (account_id, type, amount, balance_after, ref_type, ref_id, created_at)
      VALUES (?, 'ZJH_SETTLE', ?, ?, 'zjh-round', ?, ?)`);
    for (const player of players) {
      insertPlayer.run(round.id, player.accountId, player.seat, player.net, player.isWinner ? 1 : 0,
        player.startingStack, player.endingStack, player.handName);
      insertMemo.run(player.accountId, player.net, balanceOf(db, player.accountId), round.id, history.time);
    }
  }

  function writeRoom(room, { expectedAssets } = {}) {
    validateRoom(room);
    const activeSeats = db.prepare('SELECT * FROM zjh_seats WHERE room_code = ? AND closed = 0').all(room.code);
    requireThat(activeSeats.length === room.players.length, '请通过入桌或离桌结算更新炸金花座位');
    const previous = db.prepare('SELECT payload FROM zjh_rooms WHERE code = ?').get(room.code);
    const expected = expectedAssets ?? (previous ? roomAssets(JSON.parse(previous.payload)) : roomAssets(room));
    requireThat(roomAssets(room) === expected, '炸金花牌桌筹码不守恒');
    for (const player of room.players) {
      const seat = activeSeats.find(row => row.id === seatKey(player));
      requireThat(seat && seat.account_id === player.accountId && seat.seat === player.seat, '炸金花座位身份不一致');
      db.prepare('UPDATE zjh_seats SET stack = ? WHERE id = ?').run(player.stack, seatKey(player));
    }
    db.prepare(`INSERT INTO zjh_rooms (code, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(room.code, JSON.stringify(room), Date.now());
    saveHistory(room);
  }

  function saveRoom(room) {
    return db.transaction(() => writeRoom(room))();
  }

  function seatIn(room, player) {
    return db.transaction(() => {
      validateRoom(room);
      const entryId = seatKey(player);
      const existing = db.prepare('SELECT * FROM zjh_seats WHERE id = ?').get(entryId);
      if (existing) {
        requireThat(!existing.closed && existing.room_code === room.code && existing.account_id === player.accountId,
          '重复进入炸金花房间的数据不一致');
        return false;
      }
      requireThat(!db.prepare('SELECT 1 FROM zjh_seats WHERE account_id = ? AND closed = 0').get(player.accountId),
        '你已有进行中的炸金花牌桌');
      requireThat(player.stack > 0 && player.stack === balanceOf(db, player.accountId), '进入炸金花需带入当前全部钱包筹码');
      const previous = db.prepare('SELECT payload FROM zjh_rooms WHERE code = ?').get(room.code);
      const priorAssets = previous ? roomAssets(JSON.parse(previous.payload)) : 0;
      credit(db, player.accountId, 'BRING_IN', -player.stack, 'zjh-seat', entryId);
      db.prepare(`INSERT INTO zjh_seats
        (id, room_code, account_id, seat, buy_in, stack, closed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
        .run(entryId, room.code, player.accountId, player.seat, player.stack, player.stack, Date.now());
      writeRoom(room, { expectedAssets: priorAssets + player.stack });
      return true;
    })();
  }

  function seatOut(nextRoom, player, roomCode = nextRoom?.code) {
    return db.transaction(() => {
      const entryId = seatKey(player);
      const prior = db.prepare('SELECT * FROM zjh_seats WHERE id = ?').get(entryId);
      requireThat(prior && prior.room_code === roomCode && prior.account_id === player.accountId && prior.seat === player.seat,
        '炸金花离桌玩家身份不一致');
      if (prior.closed) return false;
      const previous = db.prepare('SELECT payload FROM zjh_rooms WHERE code = ?').get(roomCode);
      requireThat(previous, '炸金花房间快照不存在');
      const oldRoom = JSON.parse(previous.payload);
      requireThat(!oldRoom.round || oldRoom.round.phase === 'finished', '本局结束后才能离开炸金花牌桌');
      requireThat(prior.stack === player.stack, '炸金花离桌筹码不一致');
      if (player.stack > 0) credit(db, player.accountId, 'CASH_OUT', player.stack, 'zjh-seat', entryId);
      db.prepare('UPDATE zjh_seats SET closed = 1, closed_at = ? WHERE id = ?').run(Date.now(), entryId);
      if (nextRoom) {
        const expectedAssets = roomAssets(oldRoom) - player.stack;
        writeRoom(nextRoom, { expectedAssets });
      } else {
        db.prepare('DELETE FROM zjh_rooms WHERE code = ?').run(roomCode);
      }
      return true;
    })();
  }

  function loadRooms() {
    return db.prepare('SELECT payload FROM zjh_rooms ORDER BY code').all().map(row => JSON.parse(row.payload));
  }

  function historyPage(accountId, requestedPage = 1) {
    const page = Math.max(1, Number.parseInt(requestedPage, 10) || 1);
    const pageSize = 20;
    const total = db.prepare('SELECT COUNT(*) AS count FROM zjh_round_players WHERE account_id = ?').get(accountId).count;
    const rows = db.prepare(`SELECT r.payload, p.net, p.seat, p.is_winner, p.starting_stack, p.ending_stack, p.hand_name
      FROM zjh_round_players p JOIN zjh_rounds r ON r.id = p.round_id
      WHERE p.account_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .all(accountId, pageSize, (page - 1) * pageSize);
    return {
      page,
      pageSize,
      total,
      rounds: rows.map(row => ({
        ...JSON.parse(row.payload),
        net: row.net,
        mySeat: row.seat,
        isWinner: Boolean(row.is_winner),
        startingStack: row.starting_stack,
        endingStack: row.ending_stack,
        handName: row.hand_name,
      })),
    };
  }

  function overview(accountId) {
    return db.prepare(`SELECT COUNT(*) AS zjhRounds, COALESCE(SUM(net), 0) AS zjhNet,
      COALESCE(SUM(is_winner), 0) AS zjhWins FROM zjh_round_players WHERE account_id = ?`).get(accountId);
  }

  function activeAssets() {
    const assets = new Map();
    for (const room of loadRooms()) {
      for (const player of room.players) {
        const roundPlayer = room.round?.phase === 'playing'
          ? room.round.players.find(entry => entry.accountId === player.accountId)
          : null;
        const amount = player.stack + (roundPlayer?.contribution ?? 0);
        assets.set(player.accountId, (assets.get(player.accountId) ?? 0) + amount);
      }
    }
    return assets;
  }

  function myTables(accountId) {
    return loadRooms().flatMap(room => {
      const player = room.players.find(entry => entry.accountId === accountId);
      return player ? [{
        game: 'zjh',
        code: room.code,
        minBet: room.minBet,
        myStack: player.stack,
        playing: room.phase === 'playing',
      }] : [];
    });
  }

  return { saveRoom, seatIn, seatOut, loadRooms, historyPage, overview, activeAssets, myTables };
}
