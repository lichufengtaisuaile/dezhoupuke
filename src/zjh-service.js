import { randomBytes, randomUUID } from 'node:crypto';
import { authenticate } from './account.js';
import { GameError, requireThat } from './errors.js';
import { balanceOf } from './wallet.js';
import {
  applyZjhAction,
  automaticZjhAction,
  createZjhRound,
  legalZjhActions,
  snapshotZjh,
  ZJH_RULES,
} from './zjh-engine.js';
import { createZjhStore } from './zjh-store.js';

export function createZjhService({
  io,
  db,
  codeTaken = () => false,
  turnTimeoutMs = 30000,
  trusteeDelayMs = 900,
  nextRoundDelayMs = 4500,
}) {
  const store = createZjhStore(db);
  const rooms = new Map();
  const turnTimers = new Map();
  const nextTimers = new Map();
  const nsp = io.of('/zjh');
  const accountAvatar = db.prepare('SELECT avatar FROM accounts WHERE id = ?');
  let closing = false;

  const copy = value => structuredClone(value);
  const codeOf = value => String(value ?? '').trim().toUpperCase();
  const accountRoom = accountId => [...rooms.values()].find(room => room.players.some(player => player.accountId === accountId));
  const playerAvatars = room => new Map(room.players.map(player => [
    player.seat,
    accountAvatar.get(player.accountId)?.avatar ?? null,
  ]));

  function lobbyRooms() {
    return [...rooms.values()].map(room => {
      const avatars = playerAvatars(room);
      return {
        code: room.code,
        hostName: room.players.find(player => player.id === room.hostId)?.name ?? '',
        playerCount: room.players.length,
        onlineCount: room.players.filter(player => player.connected).length,
        maxPlayers: 8,
        minBet: room.minBet,
        twoThreeFiveBeatsTrips: room.twoThreeFiveBeatsTrips,
        phase: room.phase,
        game: 'zjh',
        players: room.players.map(player => ({
          name: player.name,
          seat: player.seat,
          avatar: avatars.get(player.seat) ?? null,
        })),
      };
    });
  }

  function roomSnapshot(room, viewer) {
    const avatars = playerAvatars(room);
    const round = room.round ? snapshotZjh(room.round, viewer.seat) : null;
    if (round) {
      round.number = room.roundNumber;
      round.deadline = room.turnDeadline;
      round.players = round.players.map(player => ({
        ...player,
        avatar: avatars.get(player.seat) ?? null,
      }));
    }
    return {
      code: room.code,
      phase: room.phase,
      minBet: room.minBet,
      twoThreeFiveBeatsTrips: room.twoThreeFiveBeatsTrips,
      hostId: room.hostId,
      selfId: viewer.id,
      rules: ZJH_RULES,
      nextRoundAt: room.nextRoundAt ?? null,
      round,
      players: room.players.map(player => ({
        id: player.id,
        name: player.name,
        seat: player.seat,
        stack: player.stack,
        avatar: avatars.get(player.seat) ?? null,
        connected: player.connected,
        ready: player.ready,
        trustee: player.trustee,
        departing: player.departing,
        inRound: Boolean(room.round?.players.some(entry => entry.id === player.id)),
      })),
    };
  }

  function broadcastLobby() {
    if (!closing) nsp.emit('lobby:state', { rooms: lobbyRooms() });
  }

  function broadcast(room) {
    if (closing) return;
    for (const player of room.players) {
      if (player.connected && player.socketId) {
        nsp.sockets.get(player.socketId)?.emit('room:state', roomSnapshot(room, player));
      }
    }
    broadcastLobby();
  }

  function clearTurn(code) {
    clearTimeout(turnTimers.get(code));
    turnTimers.delete(code);
  }

  function clearNext(code) {
    clearTimeout(nextTimers.get(code));
    nextTimers.delete(code);
  }

  function publish(room) {
    rooms.set(room.code, room);
    scheduleTurn(room);
    scheduleNext(room);
    broadcast(room);
  }

  function commit(next) {
    store.saveRoom(next);
    publish(next);
  }

  function eligible(room) {
    return room.players.filter(player => player.ready && player.connected && !player.departing && player.stack >= room.minBet);
  }

  function nextDealerSeat(room, participants) {
    const seats = participants.map(player => player.seat).sort((a, b) => a - b);
    if (!seats.length) return null;
    return seats.find(seat => seat > (room.dealerSeat ?? -1)) ?? seats[0];
  }

  function startRound(room) {
    const participants = eligible(room);
    requireThat(participants.length >= 2, '至少两位玩家准备后才能开始');
    const next = copy(room);
    next.roundNumber += 1;
    next.dealerSeat = nextDealerSeat(next, participants);
    next.round = createZjhRound({
      players: participants,
      minBet: next.minBet,
      dealerSeat: next.dealerSeat,
      twoThreeFiveBeatsTrips: next.twoThreeFiveBeatsTrips,
      roundId: randomUUID(),
    });
    for (const player of next.players) {
      const roundPlayer = next.round.players.find(entry => entry.id === player.id);
      if (roundPlayer) player.stack = roundPlayer.stack;
    }
    next.phase = 'playing';
    next.requests = [];
    next.nextRoundAt = null;
    clearNext(next.code);
    setDeadline(next);
    commit(next);
    return next;
  }

  function setDeadline(room, preserve = false) {
    if (room.phase !== 'playing' || room.round?.turnSeat == null) {
      room.turnDeadline = null;
      return;
    }
    const player = room.players.find(entry => entry.seat === room.round.turnSeat);
    const duration = player?.trustee || !player?.connected ? trusteeDelayMs : turnTimeoutMs;
    room.turnDeadline = preserve && room.turnDeadline
      ? Math.min(room.turnDeadline, Date.now() + duration)
      : Date.now() + duration;
  }

  function scheduleTurn(room) {
    clearTurn(room.code);
    if (closing || room.phase !== 'playing' || !room.turnDeadline) return;
    const timer = setTimeout(() => {
      turnTimers.delete(room.code);
      const current = rooms.get(room.code);
      if (!current || current.phase !== 'playing' || closing) return;
      const seat = current.round.turnSeat;
      const move = automaticZjhAction(current.round, seat);
      if (!move) return;
      try {
        act(current, seat, move);
      } catch (error) {
        console.error('ZJH timer failed:', error);
      }
    }, Math.max(0, room.turnDeadline - Date.now()));
    timer.unref();
    turnTimers.set(room.code, timer);
  }

  function scheduleNext(room) {
    clearNext(room.code);
    if (closing || room.phase !== 'finished' || eligible(room).length < 2) {
      room.nextRoundAt = null;
      return;
    }
    room.nextRoundAt = Date.now() + nextRoundDelayMs;
    const timer = setTimeout(() => {
      nextTimers.delete(room.code);
      const current = rooms.get(room.code);
      if (!current || current.phase !== 'finished' || closing || eligible(current).length < 2) return;
      try {
        startRound(current);
      } catch (error) {
        console.error('ZJH next round failed:', error);
      }
    }, nextRoundDelayMs);
    timer.unref();
    nextTimers.set(room.code, timer);
  }

  function removeSeat(room, player) {
    requireThat(room.phase !== 'playing', '本局结束后才能离桌');
    const next = copy(room);
    next.players = next.players.filter(entry => entry.id !== player.id);
    if (next.hostId === player.id) next.hostId = next.players[0]?.id ?? null;
    const socket = nsp.sockets.get(player.socketId);
    db.transaction(() => {
      store.seatOut(next.players.length ? next : null, player, room.code);
    })();
    if (socket?.data.code === room.code) {
      delete socket.data.code;
      socket.emit('room:left', { code: room.code });
    }
    if (!next.players.length) {
      clearTurn(room.code);
      clearNext(room.code);
      rooms.delete(room.code);
      broadcastLobby();
    } else {
      publish(next);
    }
  }

  function cleanFinished(code) {
    let room = rooms.get(code);
    if (!room || room.phase === 'playing') return;
    for (const player of [...room.players]) {
      if (player.departing || !player.connected || player.stack < room.minBet) {
        room = rooms.get(code);
        if (!room) break;
        removeSeat(room, room.players.find(entry => entry.id === player.id));
      }
    }
  }

  function act(room, seat, move, requestId, requestTurnId) {
    const next = copy(room);
    next.round = applyZjhAction(room.round, seat, move);
    for (const player of next.players) {
      const roundPlayer = next.round.players.find(entry => entry.id === player.id);
      if (roundPlayer) player.stack = roundPlayer.stack;
    }
    next.phase = next.round.phase;
    if (requestId) {
      next.requests.push({
        id: requestId,
        seat,
        roundId: room.round.id,
        turnId: requestTurnId,
        action: move.action,
        bet: move.bet ?? null,
        targetSeat: move.targetSeat ?? null,
      });
      next.requests = next.requests.slice(-256);
    }
    if (next.phase === 'finished') {
      for (const player of next.players) {
        player.ready = player.connected && !player.departing && player.stack >= next.minBet
          && Boolean(next.round.players.some(entry => entry.id === player.id));
      }
      next.turnDeadline = null;
    } else {
      setDeadline(next);
    }
    commit(next);
    if (next.phase === 'finished') cleanFinished(next.code);
  }

  function member(socket) {
    const room = rooms.get(socket.data.code);
    const player = room?.players.find(entry => entry.accountId === socket.data.account.id && entry.socketId === socket.id);
    requireThat(room && player, '请先进入炸金花房间');
    return { room, player };
  }

  function attach(socket, room) {
    const current = room.players.find(player => player.accountId === socket.data.account.id);
    requireThat(current, '你不在这个炸金花房间中');
    const next = copy(room);
    const player = next.players.find(entry => entry.id === current.id);
    player.connected = true;
    player.socketId = socket.id;
    player.trustee = false;
    player.departing = false;
    const old = nsp.sockets.get(current.socketId);
    if (old && old.id !== socket.id) {
      delete old.data.code;
      old.emit('session:replaced', { reason: '你的炸金花座位已在另一个页面打开' });
    }
    socket.data.code = room.code;
    if (next.phase === 'playing' && next.round.turnSeat === player.seat) setDeadline(next);
    store.saveRoom(next);
    publish(next);
    return { code: room.code };
  }

  nsp.use((socket, next) => {
    const account = authenticate(db, socket.handshake.auth?.token);
    if (!account || account.isBanned) return next(new Error(account?.isBanned ? '账号已被封禁' : '请先登录'));
    socket.data.account = account;
    next();
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
          if (!(error instanceof GameError)) console.error(`ZJH ${event}:`, error);
          reply({ ok: false, error: error instanceof GameError ? error.message : '操作未完成，请刷新重试' });
        }
      });
    }

    on('room:list', () => ({ rooms: lobbyRooms() }));
    on('room:create', payload => {
      requireThat(!accountRoom(socket.data.account.id), '你已有炸金花座位，请返回原房间');
      const minBet = Number(payload.minBet ?? 10);
      requireThat(Number.isSafeInteger(minBet) && minBet >= 1 && minBet <= 1_000_000, '最小下注需要为 1–1,000,000 的整数');
      requireThat(payload.twoThreeFiveBeatsTrips === undefined || typeof payload.twoThreeFiveBeatsTrips === 'boolean', '235 规则设置不正确');
      const stack = balanceOf(db, socket.data.account.id);
      requireThat(stack >= minBet, '钱包筹码不足以支付底注');
      let code;
      do {
        code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
      } while (rooms.has(code) || codeTaken(code));
      const player = {
        id: randomUUID(),
        entryId: randomUUID(),
        accountId: socket.data.account.id,
        name: socket.data.account.name,
        seat: 0,
        stack,
        connected: true,
        socketId: socket.id,
        ready: false,
        trustee: false,
        departing: false,
      };
      const room = {
        code,
        minBet,
        twoThreeFiveBeatsTrips: payload.twoThreeFiveBeatsTrips !== false,
        phase: 'lobby',
        hostId: player.id,
        dealerSeat: -1,
        roundNumber: 0,
        players: [player],
        round: null,
        requests: [],
        turnDeadline: null,
        nextRoundAt: null,
      };
      store.seatIn(room, player);
      socket.data.code = code;
      publish(room);
      return { code };
    });

    on('room:join', payload => {
      const room = rooms.get(codeOf(payload.code));
      requireThat(room, '炸金花房间不存在');
      if (room.players.some(player => player.accountId === socket.data.account.id)) return attach(socket, room);
      requireThat(!accountRoom(socket.data.account.id), '你已有炸金花座位，请先离开原房间');
      requireThat(room.players.length < 8, '这个炸金花房间已经坐满');
      const stack = balanceOf(db, socket.data.account.id);
      requireThat(stack >= room.minBet, '钱包筹码不足以支付本桌底注');
      const next = copy(room);
      const player = {
        id: randomUUID(),
        entryId: randomUUID(),
        accountId: socket.data.account.id,
        name: socket.data.account.name,
        seat: Array.from({ length: 8 }, (_, seat) => seat).find(seat => !room.players.some(entry => entry.seat === seat)),
        stack,
        connected: true,
        socketId: socket.id,
        ready: false,
        trustee: false,
        departing: false,
      };
      next.players.push(player);
      store.seatIn(next, player);
      socket.data.code = room.code;
      publish(next);
      return { code: room.code };
    });

    on('room:resume', payload => {
      const room = rooms.get(codeOf(payload.code));
      requireThat(room, '炸金花房间不存在或筹码已退回');
      return attach(socket, room);
    });

    on('room:ready', payload => {
      const { room, player } = member(socket);
      requireThat(room.phase !== 'playing', '本局已经开始');
      requireThat(typeof payload.ready === 'boolean', '准备状态不正确');
      const next = copy(room);
      next.players.find(entry => entry.id === player.id).ready = payload.ready;
      store.saveRoom(next);
      publish(next);
      if (payload.ready && eligible(next).length >= 2 && next.phase === 'lobby') startRound(next);
      return {};
    });

    on('game:action', payload => {
      const { room, player } = member(socket);
      requireThat(typeof payload.requestId === 'string' && payload.requestId.length >= 8 && payload.requestId.length <= 100,
        '缺少操作编号，请刷新页面');
      const prior = room.requests.find(entry => entry.id === payload.requestId && entry.seat === player.seat);
      if (prior) {
        requireThat(prior.roundId === payload.roundId && prior.turnId === payload.turnId && prior.action === payload.action
          && prior.bet === (payload.bet ?? null) && prior.targetSeat === (payload.targetSeat ?? null), '操作编号不能重复用于其他动作');
        socket.emit('room:state', roomSnapshot(room, player));
        return { duplicate: true };
      }
      requireThat(room.phase === 'playing' && room.round.id === payload.roundId && room.round.turnId === payload.turnId,
        '牌局已更新，请按当前提示操作');
      requireThat(!player.departing, '你已选择本局结束后离桌');
      act(room, player.seat, {
        action: payload.action,
        bet: payload.bet,
        targetSeat: payload.targetSeat,
      }, payload.requestId, payload.turnId);
      return {};
    });

    on('room:trustee', payload => {
      const { room, player } = member(socket);
      requireThat(typeof payload.enabled === 'boolean', '托管状态不正确');
      const next = copy(room);
      const target = next.players.find(entry => entry.id === player.id);
      target.trustee = payload.enabled;
      if (!target.trustee) target.departing = false;
      if (next.phase === 'playing' && next.round.turnSeat === target.seat) setDeadline(next);
      commit(next);
      return {};
    });

    on('room:leave', () => {
      const { room, player } = member(socket);
      if (room.phase !== 'playing') {
        removeSeat(room, player);
        return { pending: false };
      }
      const next = copy(room);
      const target = next.players.find(entry => entry.id === player.id);
      target.departing = true;
      target.trustee = true;
      if (next.round.turnSeat === target.seat && legalZjhActions(next.round, target.seat).actions.includes('fold')) {
        act(next, target.seat, { action: 'fold' });
      } else {
        commit(next);
      }
      return { pending: true };
    });

    socket.on('disconnect', () => {
      if (closing) return;
      const room = rooms.get(socket.data.code);
      const player = room?.players.find(entry => entry.socketId === socket.id);
      if (!player) return;
      try {
        if (room.phase !== 'playing') {
          removeSeat(room, player);
          return;
        }
        const next = copy(room);
        const target = next.players.find(entry => entry.id === player.id);
        target.connected = false;
        target.socketId = null;
        target.trustee = true;
        if (next.round.turnSeat === target.seat) setDeadline(next);
        commit(next);
      } catch (error) {
        console.error('ZJH disconnect:', error);
      }
    });

    socket.emit('lobby:state', { rooms: lobbyRooms() });
  });

  for (const room of store.loadRooms()) {
    for (const player of room.players) {
      player.connected = false;
      player.socketId = null;
      player.trustee = true;
    }
    if (room.phase === 'playing') room.turnDeadline = Date.now() + turnTimeoutMs;
    rooms.set(room.code, room);
    scheduleTurn(room);
  }

  return {
    rooms,
    store,
    rules: ZJH_RULES,
    lobbyRooms,
    hasCode: code => rooms.has(code),
    myTables: accountId => store.myTables(accountId),
    updateAccountAvatar(accountId, avatar) {
      for (const socket of nsp.sockets.values()) {
        if (socket.data.account?.id !== accountId) continue;
        socket.data.account.avatar = avatar;
        socket.emit('account:avatar', { accountId, avatar });
      }
      for (const room of rooms.values()) {
        if (room.players.some(player => player.accountId === accountId)) broadcast(room);
      }
    },
    kickAccount(accountId) {
      const room = accountRoom(accountId);
      if (room) {
        const player = room.players.find(entry => entry.accountId === accountId);
        if (room.phase === 'playing') {
          const next = copy(room);
          const target = next.players.find(entry => entry.id === player.id);
          target.departing = true;
          target.trustee = true;
          target.connected = false;
          if (next.round.turnSeat === target.seat) setDeadline(next);
          commit(next);
        } else {
          removeSeat(room, player);
        }
      }
      for (const socket of nsp.sockets.values()) {
        if (socket.data.account?.id === accountId) socket.disconnect(true);
      }
    },
    close() {
      closing = true;
      for (const timer of turnTimers.values()) clearTimeout(timer);
      for (const timer of nextTimers.values()) clearTimeout(timer);
      turnTimers.clear();
      nextTimers.clear();
      for (const room of rooms.values()) store.saveRoom(room);
    },
  };
}
