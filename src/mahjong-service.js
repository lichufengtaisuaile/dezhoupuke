import { randomBytes, randomUUID } from 'node:crypto';
import { authenticate } from './account.js';
import { GameError, requireThat } from './errors.js';
import { createMahjongStore } from './mahjong-store.js';
import { MAHJONG_RULES, createMahjongRound, applyMahjongAction, legalMahjongActions, automaticMahjongAction, snapshotMahjong } from './mahjong-engine.js';

// Timers and sockets stay outside durable room data. Every mutation commits before publication.
export function createMahjongService({ io, db, pokerRooms, turnTimeoutMs = 20000, botDelayMs = 750 }) {
  const store = createMahjongStore(db);
  const rooms = new Map();
  const timers = new Map();
  const nsp = io.of('/mahjong');
  let closing = false;
  const copy = value => structuredClone(value);
  const codeOf = value => String(value ?? '').trim().toUpperCase();
  const member = (socket) => {
    const room = rooms.get(socket.data.code);
    const player = room?.players.find(p => p.accountId === socket.data.account.id && p.socketId === socket.id);
    requireThat(room && player, '请先入座');
    return { room, player };
  };
  const accountRoom = id => [...rooms.values()].find(r => r.players.some(p => p.accountId === id));
  function lobbyRooms() {
    return [...rooms.values()].map(r => ({ code: r.code, hostName: r.players.find(p => !p.isBot)?.name ?? '',
      playerCount: r.players.length, onlineCount: r.players.filter(p => p.connected).length, maxPlayers: 4,
      base: r.base, buyIn: r.buyIn, practice: r.practice, phase: r.phase, game: 'mahjong' }));
  }
  function snapshot(room, player) {
    const round = room.round ? snapshotMahjong(room.round, player.seat) : null;
    if (round) {
      round.number = room.roundNumber;
      round.responseWindowTurnId = room.responseWindowTurnId ?? null;
      round.deadline = room.deadlines?.[player.seat] ?? Math.min(...Object.values(room.deadlines ?? {}), Infinity);
      if (!Number.isFinite(round.deadline)) round.deadline = null;
      round.deadlines = room.deadlines ?? {};
    }
    return { code: room.code, base: room.base, buyIn: room.buyIn, practice: room.practice,
      phase: room.phase, selfId: player.id, rules: MAHJONG_RULES, round,
      players: room.players.map(p => ({ ...round?.players.find(rp => rp.seat === p.seat),
        id: p.id, name: p.name, seat: p.seat, stack: p.stack, ready: p.ready,
        connected: p.connected, departing: p.departing, trustee: p.trustee, isBot: p.isBot })) };
  }
  function broadcastLobby() { if (!closing) nsp.emit('lobby:state', { rooms: lobbyRooms() }); }
  function broadcast(room) {
    if (closing) return;
    for (const p of room.players) if (p.connected && p.socketId) nsp.sockets.get(p.socketId)?.emit('room:state', snapshot(room, p));
    broadcastLobby();
  }
  function pendingSeats(room) {
    if (room.round?.phase !== 'playing') return [];
    return room.players.filter(p => legalMahjongActions(room.round, p.seat).actions.length).map(p => p.seat);
  }
  function setDeadlines(next, previous, preserve = false) {
    const sameResponse = previous?.round?.responses && next.round?.responses
      && previous.round.id === next.round.id
      && previous.round.responses.kind === next.round.responses.kind
      && previous.round.responses.sourceSeat === next.round.responses.sourceSeat
      && previous.round.responses.tile === next.round.responses.tile;
    next.responseWindowTurnId = next.round?.responses
      ? (sameResponse ? previous.responseWindowTurnId ?? previous.round.turnId : next.round.turnId)
      : null;
    const deadlines = {};
    for (const seat of pendingSeats(next)) {
      const p = next.players.find(p => p.seat === seat);
      const duration = p.isBot || p.trustee || !p.connected ? botDelayMs : turnTimeoutMs;
      const existing = (preserve || sameResponse) ? previous?.deadlines?.[seat] : null;
      deadlines[seat] = existing ? Math.min(existing, Date.now() + duration) : Date.now() + duration;
    }
    next.deadlines = deadlines;
  }
  function schedule(room) {
    clearTimeout(timers.get(room.code));
    timers.delete(room.code);
    if (closing) return;
    const deadlines = Object.values(room.deadlines ?? {});
    if (!deadlines.length) return;
    const timer = setTimeout(() => {
      timers.delete(room.code);
      const current = rooms.get(room.code);
      if (!current || closing) return;
      const due = Object.entries(current.deadlines ?? {}).filter(([, at]) => at <= Date.now() + 2).sort((a, b) => a[1] - b[1])[0];
      if (!due) { schedule(current); return; }
      const seat = Number(due[0]);
      try {
        const move = automaticMahjongAction(current.round, seat);
        if (move) act(current, seat, move);
      } catch (error) {
        // Do not advance or publish an action whose durable commit failed.
        console.error('Mahjong timer failed:', error);
        const retry = setTimeout(() => schedule(rooms.get(room.code) ?? current), 1000);
        retry.unref(); timers.set(room.code, retry);
      }
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
    timer.unref(); timers.set(room.code, timer);
  }
  function publish(next) {
    rooms.set(next.code, next);
    schedule(next); broadcast(next);
  }
  function commit(next, previous, preserve = false) {
    setDeadlines(next, previous, preserve);
    store.saveRoom(next);
    publish(next);
  }
  function removeSeat(room, player) {
    const next = copy(room);
    next.players = next.players.filter(p => p.id !== player.id);
    const hasHuman = next.players.some(p => !p.isBot);
    db.transaction(() => {
      if (!hasHuman && room.practice) {
        const closingRoom = copy(room);
        for (const bot of room.players.filter(p => p.isBot)) {
          closingRoom.players = closingRoom.players.filter(p => p.id !== bot.id);
          store.seatOut(closingRoom, bot, room.code, true);
        }
      }
      store.seatOut(hasHuman ? next : null, player, room.code, room.practice);
    })();
    const socket = nsp.sockets.get(player.socketId);
    if (socket?.data.code === room.code) {
      delete socket.data.code;
      socket.emit('room:left', { code: room.code });
    }
    if (hasHuman) publish(next);
    else { clearTimeout(timers.get(room.code)); timers.delete(room.code); rooms.delete(room.code); broadcastLobby(); }
  }
  function cleanFinished(code) {
    let room = rooms.get(code);
    if (!room || room.phase === 'playing') return;
    for (const p of [...room.players]) {
      if (!p.isBot && (p.departing || !p.connected || p.stack <= 0)) {
        room = rooms.get(code);
        if (room) removeSeat(room, p);
      }
    }
  }
  function act(room, seat, move, requestId, requestTurnId) {
    const next = copy(room);
    next.round = applyMahjongAction(room.round, seat, move);
    next.phase = next.round.phase;
    for (const p of next.players) p.stack = next.round.players.find(rp => rp.seat === p.seat).stack;
    if (requestId) {
      next.requests ??= [];
      next.requests.push({ id: requestId, seat, roundId: room.round.id, turnId: requestTurnId ?? room.round.turnId,
        action: move.action, tile: move.tile ?? null });
      next.requests = next.requests.slice(-256);
    }
    if (next.phase === 'finished') next.players.forEach(p => { p.ready = Boolean(p.isBot); });
    commit(next, room);
    cleanFinished(next.code);
  }
  function startIfReady(next) {
    if (next.phase === 'playing' || next.players.length !== 4 || next.players.some(p => !p.ready || !p.connected || p.stack <= 0 || p.departing)) return;
    next.roundNumber += 1;
    next.round = createMahjongRound({ players: next.players, base: next.base,
      dealerSeat: (next.roundNumber - 1) % 4, roundId: randomUUID() });
    next.round.number = next.roundNumber;
    next.phase = 'playing'; next.requests = [];
  }
  function attach(socket, room) {
    const current = room.players.find(p => p.accountId === socket.data.account.id);
    requireThat(current, '你不在这个房间中');
    const next = copy(room);
    const p = next.players.find(p => p.id === current.id);
    p.connected = true; p.socketId = socket.id; p.trustee = false; p.departing = false;
    // Persist before replacing the old connection's ownership.
    setDeadlines(next, room, true); store.saveRoom(next);
    const old = nsp.sockets.get(current.socketId);
    if (old && old.id !== socket.id) {
      delete old.data.code;
      old.emit('session:replaced', { reason: '你的座位已在另一个页面打开' });
    }
    socket.data.code = room.code; publish(next);
    return { code: room.code };
  }
  nsp.use((socket, next) => {
    const account = authenticate(db, socket.handshake.auth?.token);
    if (!account || account.isBanned) return next(new Error(account?.isBanned ? '账号已被封禁' : '请先登录'));
    socket.data.account = account; next();
  });
  nsp.on('connection', socket => {
    function on(event, handler) {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          requireThat(!closing, '服务器正在重启，请稍后重连');
          const account = authenticate(db, socket.handshake.auth?.token);
          requireThat(account && !account.isBanned, '登录已失效或账号已被封禁');
          requireThat(payload == null || (typeof payload === 'object' && !Array.isArray(payload)), '请求格式不正确');
          reply({ ok: true, ...handler(payload ?? {}) });
        } catch (error) {
          if (!(error instanceof GameError)) console.error(`Mahjong ${event}:`, error);
          reply({ ok: false, error: error instanceof GameError ? error.message : '操作未完成，请刷新重试' });
        }
      });
    }
    on('room:list', () => { socket.emit('lobby:state', { rooms: lobbyRooms() }); return { rooms: lobbyRooms() }; });
    on('room:create', payload => {
      requireThat(!accountRoom(socket.data.account.id), '你已有麻将座位，请从大厅返回原房间');
      const base = payload.base ?? 10, buyIn = payload.buyIn ?? 2000;
      requireThat(Number.isSafeInteger(base) && base >= 1 && base <= 1000, '底分需要为 1–1000 的整数');
      requireThat(Number.isSafeInteger(buyIn) && buyIn >= base * 16 && buyIn <= 1000000, '带入需至少为底分的 16 倍，且不超过 1,000,000');
      requireThat(payload.practice === undefined || typeof payload.practice === 'boolean', '练习房设置不正确');
      let code;
      do { code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); } while (rooms.has(code) || pokerRooms.has(code));
      const player = { id: randomUUID(), entryId: randomUUID(), accountId: socket.data.account.id, name: socket.data.account.name,
        seat: 0, stack: buyIn, connected: true, socketId: socket.id, ready: false, trustee: false, departing: false, isBot: false };
      const room = { code, base, buyIn, practice: Boolean(payload.practice), phase: 'lobby', roundNumber: 0,
        players: [player], round: null, deadlines: {}, requests: [] };
      db.transaction(() => {
        store.seatIn(room, player);
        if (room.practice) for (let seat = 1; seat < 4; seat++) {
          const bot = { id: randomUUID(), accountId: null, name: ['小竹', '阿川', '红豆'][seat - 1], seat, stack: buyIn,
            connected: true, ready: true, trustee: true, isBot: true, departing: false };
          room.players.push(bot); store.seatIn(room, bot);
        }
      })();
      socket.data.code = code; publish(room);
      return { code };
    });
    on('room:join', payload => {
      const room = rooms.get(codeOf(payload.code));
      requireThat(room, '房间不存在');
      if (room.players.some(p => p.accountId === socket.data.account.id)) return attach(socket, room);
      requireThat(!accountRoom(socket.data.account.id), '你已有麻将座位，请先离开原房间');
      requireThat(!room.practice && room.phase !== 'playing' && room.players.length < 4, '房间已满或正在对局');
      const next = copy(room);
      const player = { id: randomUUID(), entryId: randomUUID(), accountId: socket.data.account.id, name: socket.data.account.name,
        seat: [0, 1, 2, 3].find(seat => !room.players.some(p => p.seat === seat)), stack: room.buyIn,
        connected: true, socketId: socket.id, ready: false, trustee: false, departing: false, isBot: false };
      next.players.push(player);
      // A completed round is retained only while its original four seats remain present.
      if (next.round) next.players.forEach(p => { p.ready = Boolean(p.isBot); });
      next.round = null; next.phase = 'lobby';
      store.seatIn(next, player); socket.data.code = room.code; publish(next);
      return { code: room.code };
    });
    on('room:resume', payload => {
      const room = rooms.get(codeOf(payload.code)); requireThat(room, '房间不存在或已结算离桌');
      return attach(socket, room);
    });
    on('room:ready', payload => {
      const { room, player } = member(socket);
      requireThat(room.phase !== 'playing', '对局已经开始');
      requireThat(typeof payload.ready === 'boolean', '准备状态不正确');
      const next = copy(room); next.players.find(p => p.id === player.id).ready = payload.ready;
      startIfReady(next); commit(next, room); return {};
    });
    on('game:action', payload => {
      const { room, player } = member(socket);
      requireThat(typeof payload.requestId === 'string' && payload.requestId.length >= 8 && payload.requestId.length <= 100, '缺少操作编号，请刷新页面');
      const prior = room.requests?.find(r => r.id === payload.requestId && r.seat === player.seat);
      if (prior) {
        requireThat(prior.roundId === payload.roundId && prior.turnId === payload.turnId && prior.action === payload.action && prior.tile === (payload.tile ?? null), '操作编号不能重复用于其他动作');
        socket.emit('room:state', snapshot(room, player)); return { duplicate: true };
      }
      // A reply from another seat advances the durable revision without closing this
      // claim window. Accept every still-pending player's observed window revision.
      const sameResponseWindow = room.round?.stage === 'responses'
        && Number.isSafeInteger(payload.turnId)
        && payload.turnId >= (room.responseWindowTurnId ?? room.round.turnId)
        && payload.turnId <= room.round.turnId
        && legalMahjongActions(room.round, player.seat).actions.length > 0;
      requireThat(room.phase === 'playing' && room.round.id === payload.roundId
        && (room.round.turnId === payload.turnId || sameResponseWindow), '牌局已更新，请按当前提示操作');
      requireThat(!player.departing, '你已选择本局结束后离桌');
      act(room, player.seat, { action: payload.action, tile: payload.tile }, payload.requestId, payload.turnId); return {};
    });
    on('room:trustee', payload => {
      const { room, player } = member(socket);
      requireThat(typeof payload.enabled === 'boolean', '托管状态不正确');
      const next = copy(room); const p = next.players.find(p => p.id === player.id);
      p.trustee = payload.enabled; if (!p.trustee) p.departing = false;
      commit(next, room, true); return {};
    });
    on('room:leave', () => {
      const { room, player } = member(socket);
      if (room.phase !== 'playing') { removeSeat(room, player); return { pending: false }; }
      const next = copy(room); const p = next.players.find(p => p.id === player.id);
      p.departing = true; p.trustee = true; commit(next, room, true); return { pending: true };
    });
    socket.on('disconnect', () => {
      if (closing) return;
      const room = rooms.get(socket.data.code);
      const player = room?.players.find(p => p.socketId === socket.id);
      if (!player) return;
      try {
        if (room.phase !== 'playing') { removeSeat(room, player); return; }
        const next = copy(room); const p = next.players.find(p => p.id === player.id);
        p.connected = false; p.socketId = null; p.trustee = true;
        commit(next, room, true);
      } catch (error) { console.error('Mahjong disconnect:', error); }
    });
    socket.emit('lobby:state', { rooms: lobbyRooms() });
  });
  // Resume exactly the persisted wall/hands/events. Startup is not a new deal or refund.
  for (const room of store.loadRooms()) {
    room.players.forEach(p => { p.socketId = null; p.connected = Boolean(p.isBot); if (!p.isBot) p.trustee = true; });
    rooms.set(room.code, room);
    if (room.phase === 'playing') {
      // Give returning clients one normal turn window before unattended play starts.
      room.deadlines = Object.fromEntries(pendingSeats(room).map(seat => [seat, Date.now() + turnTimeoutMs]));
      store.saveRoom(room); schedule(room);
    } else cleanFinished(room.code);
  }
  return { rooms, store, lobbyRooms, rules: MAHJONG_RULES,
    hasCode: code => rooms.has(code),
    myTables: accountId => [...rooms.values()].filter(r => r.players.some(p => p.accountId === accountId)).map(r => ({
      code: r.code, game: 'mahjong', base: r.base, myStack: r.players.find(p => p.accountId === accountId).stack,
      practice: r.practice, playing: r.phase === 'playing' })),
    kickAccount(accountId) {
      const room = accountRoom(accountId);
      if (room) {
        const p = room.players.find(p => p.accountId === accountId);
        if (room.phase === 'playing') {
          const next = copy(room); const player = next.players.find(p => p.accountId === accountId);
          player.departing = true; player.trustee = true; commit(next, room, true);
        } else removeSeat(room, p);
      }
      for (const socket of nsp.sockets.values()) if (socket.data.account.id === accountId) socket.disconnect(true);
    },
    close() {
      closing = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const room of rooms.values()) store.saveRoom(room);
    },
  };
}
