(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const suitSymbols = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };
  const roundNames = {
    preflop: "翻牌前",
    flop: "翻牌",
    turn: "转牌",
    river: "河牌",
  };
  const actionNames = {
    fold: "已弃牌",
    check: "过牌",
    call: "跟注",
    bet: "下注",
    raise: "加注",
    "all-in": "全下",
    allin: "全下",
    smallBlind: "小盲",
    bigBlind: "大盲",
  };
  const storageKey = "tongzhuo-session";
  const auth = window.tongzhuoAuth;
  let state = null;
  let session = null;
  let socket = null;
  let pendingInviteCode = null;
  let pending = false;
  let toastTimeout;
  let previousTurn = "";
  let networkUrls = [];
  let skipNextDeal = true;
  let settlementTimer;
  let settlementReady = false;
  const dealing = window.createDealingEffects($("table-stage"), $("card-deck"));
  const chips = window.createChipEffects($("table-stage"));
  const celebration = window.createHandCelebration($("table-stage"));
  const audio = window.createTableAudio({
    button: $("sound-button"), volumeInput: $("sound-volume"), notify: toast,
  });
  const tableLayout = window.createTableLayout({ root: $("game-view") });
  try {
    session = JSON.parse(sessionStorage.getItem(storageKey) || "null");
  } catch {
    sessionStorage.removeItem(storageKey);
  }
  function socketConnected() {
    return Boolean(socket && socket.connected);
  }
  function connectSocket() {
    const account = auth.get();
    if (!account || socket) return;
    socket = io({ reconnection: true, auth: { token: account.token } });
    socket.on("connect", onSocketConnect);
    socket.on("disconnect", onSocketDisconnect);
    socket.on("connect_error", onSocketConnectError);
    socket.on("room:state", onRoomState);
    socket.on("lobby:state", data => {
      if (!state) updateLobbyRooms(data.rooms);
    });
    socket.on("room:reaction", event => social.receive(event));
    socket.on("room:closed", (data) => {
      clearSession();
      toast(data?.reason || "房间已关闭", true);
    });
    socket.on("session:replaced", (data) => {
      clearSession();
      toast(data?.reason || "你的座位已在其他页面登录", true);
    });
  }
  function teardownSocket() {
    if (!socket) return;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  const lobby = window.createLobby({
    root: $("home-view"),
    onCreate: payload => enterRoom("room:create", payload),
    onJoin: payload => enterRoom("room:join", payload),
    onRefresh: refreshLobby,
    onRequireAuth: (after) => requireAuth(after),
  });
  const portal = window.createPortal({
    root: $("portal-view"),
    onEnterGame: async (id) => {
      if (id === "slots") {
        location.assign("/slot/");
        return;
      }
      if (id !== "holdem") return;
      if (!(await requireAuth())) return;
      location.hash = "#/holdem";
    },
    onReturnToTable: (code) => { returnToTable(code); },
  });
  const topbar = window.createTopbar({
    mount: $("topbar-identity"),
    onRequireAuth: () => requireAuth(),
  });
  const social = window.createSocial({
    root: $("social-bar"), stage: $("table-stage"),
    send: payload => request("room:react", payload), notify: toast,
    onReaction: (_item, event) => audio.reaction(event),
  });

  async function requireAuth(after) {
    if (auth.get()) {
      if (after) after();
      return true;
    }
    const ok = await auth.openAuthModal();
    if (!ok) return false;
    await handleLoginSuccess();
    if (after) after();
    return true;
  }
  function currentRoute() {
    return location.hash === "#/holdem" ? "holdem" : "portal";
  }
  function updateLobbyRooms(rooms) {
    portal.setHoldemOnline(Array.isArray(rooms) ? rooms.length : 0);
    lobby.updateRooms(rooms);
  }
  async function refreshTables() {
    if (!auth.get()) {
      portal.setTables([]);
      return;
    }
    try {
      const data = await auth.api("/api/me/tables");
      portal.setTables(data.tables || []);
    } catch {
      portal.setTables([]);
    }
  }
  async function resumeSeat() {
    if (!session) return false;
    const response = await request("room:resume", { code: session.code });
    if (response) {
      saveSession(response);
      return true;
    }
    clearSession();
    return false;
  }
  async function returnToTable(code) {
    saveSession({ code });
    const alreadyConnected = socketConnected();
    if (!(await waitForSocket())) {
      toast("连接失败，请稍后重试", true);
      return;
    }
    // socket 已连接时不会触发 connect 事件，这里直接 resume；
    // 否则由 onSocketConnect 里的 resumeSeat 完成回桌。
    if (alreadyConnected && !(await resumeSeat())) refreshTables();
  }

  function waitForSocket(timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!auth.get()) return resolve(false);
      if (socketConnected()) return resolve(true);
      connectSocket();
      if (!socket) return resolve(false);
      const onConnect = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        socket?.off("connect", onConnect);
        resolve(socketConnected());
      }, timeoutMs);
      socket.once("connect", onConnect);
    });
  }
  async function refreshAccountBalance() {
    const account = await auth.refreshBalance();
    if (account) topbar.setAccount(account);
    portal.setLoggedIn(Boolean(account));
    renderRoom();
    window.dispatchEvent(new CustomEvent("tongzhuo:balance"));
    return account;
  }
  async function handleLoginSuccess() {
    connectSocket();
    await refreshAccountBalance();
    refreshWallet();
    refreshLobby();
    refreshTables();
    if (pendingInviteCode) {
      const code = pendingInviteCode;
      pendingInviteCode = null;
      lobby.showInvite(code);
    }
  }
  function handleLogout(reason) {
    if (!auth.get() && !reason) return;
    auth.clear(false);
    teardownSocket();
    clearSession();
    topbar.setAccount(null);
    portal.setLoggedIn(false);
    refreshLobby();
    refreshTables();
    if (reason) toast(reason, true);
  }
  async function claimSubsidy() {
    if (!auth.get()) {
      const ok = await auth.openAuthModal();
      if (!ok) return;
      await handleLoginSuccess();
    }
    if (!(await waitForSocket())) return;
    const response = await exclusive("room:subsidy", {});
    if (response) {
      toast("已领取每日补助 2,000 筹码");
      await refreshAccountBalance();
    }
  }
  window.addEventListener("tongzhuo:claim-subsidy", () => {
    claimSubsidy().then(() => { renderRoom(); icons(); });
  });
  window.addEventListener("tongzhuo:logout", () => handleLogout("登录已过期，请重新登录"));
  window.addEventListener("tongzhuo:logout-request", () => handleLogout());

  async function enterRoom(event, payload) {
    if (!auth.get()) {
      const ok = await auth.openAuthModal();
      if (!ok) return null;
      await handleLoginSuccess();
    }
    await waitForSocket();
    const response = await exclusive(event, payload);
    if (response) saveSession(response);
    else throw new Error($("toast").textContent || "未能进入房间，请重试");
    return response;
  }
  async function refreshLobby() {
    if (state) return null;
    if (auth.get() && socketConnected()) {
      const response = await request("lobby:list");
      if (response && !state) updateLobbyRooms(response.rooms);
      return response;
    }
    try {
      const data = await auth.api("/api/lobby");
      lobby.setConnection(true);
      updateLobbyRooms(data.rooms);
      return data;
    } catch {
      lobby.setConnection(false);
      return null;
    }
  }
  function refreshWallet() {
    const panel = $("room-wallet");
    if (!panel) return;
    const account = auth.get();
    const show = Boolean(account && state && !state.practice);
    panel.hidden = !show;
    if (show) {
      $("wallet-balance").textContent = money(account.balance);
      $("wallet-table").textContent = money(playerSelf()?.stack || 0);
    }
  }

  function icons() {
    if (window.lucide) window.lucide.createIcons();
  }
  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  function money(value) {
    return Number(value || 0).toLocaleString("zh-CN");
  }
  function toast(message, error = false) {
    clearTimeout(toastTimeout);
    $("toast").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    toastTimeout = setTimeout(
      () => {
        $("toast").hidden = true;
      },
      error ? 5500 : 3200,
    );
  }
  function saveSession(data) {
    session = { code: data.code, token: data.token, playerId: data.playerId };
    sessionStorage.setItem(storageKey, JSON.stringify(session));
    const url = new URL(location.href);
    url.searchParams.set("room", data.code);
    history.replaceState(null, "", url);
  }
  function clearSession() {
    dealing.cancel();
    chips.cancel();
    celebration.cancel();
    audio.cancel();
    social.cancel();
    tableLayout.reset();
    clearTimeout(settlementTimer);
    settlementReady = false;
    state = null;
    session = null;
    previousTurn = "";
    sessionStorage.removeItem(storageKey);
    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState(null, "", url);
    $("history-drawer").hidden = $("history-backdrop").hidden = true;
    render();
    refreshLobby();
    refreshTables();
  }
  function request(event, payload = {}) {
    return new Promise((resolve) => {
      if (!socketConnected()) {
        toast("连接已断开，正在重新连接", true);
        resolve(null);
        return;
      }
      socket.timeout(10000).emit(event, payload, (timeoutError, response) => {
        if (timeoutError) {
          toast("请求超时，请稍后重试", true);
          resolve(null);
          return;
        }
        if (!response?.ok) {
          toast(response?.error || "操作未完成，请重试", true);
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  }
  async function exclusive(event, payload) {
    if (pending) return null;
    pending = true;
    lobby.setBusy(true);
    renderActions();
    try {
      return await request(event, payload);
    } finally {
      pending = false;
      lobby.setBusy(false);
      renderRoom();
      renderActions();
      icons();
    }
  }
  function playerSelf() {
    return state?.players.find((player) => player.id === state.selfId);
  }
  function isHost() {
    return Boolean(state && state.hostId === state.selfId);
  }
  function cardMarkup(card, extra = "", key = "") {
    const cardKey = key ? ` data-card-key="${esc(key)}"` : "";
    if (!card)
      return `<div class="playing-card placeholder ${extra}" aria-hidden="true"></div>`;
    if (card === "back")
      return `<div class="playing-card back ${extra}"${cardKey} aria-label="未公开的底牌"></div>`;
    const suit = suitSymbols[card.suit] || "♠";
    const rank = card.rank === "T" ? "10" : card.rank;
    const red = card.suit === "hearts" || card.suit === "diamonds";
    return `<div class="playing-card ${red ? "red" : ""} ${extra}"${cardKey} aria-label="${esc(rank)} ${suit}"><span class="card-corner"><span class="card-rank">${esc(rank)}</span><span class="card-suit">${suit}</span></span><span class="card-symbol">${suit}</span></div>`;
  }
  function actionText(player) {
    if (!player.connected && !player.isBot) return "已断线";
    if (player.winner) return "赢得底池";
    if (player.folded) return "已弃牌";
    if (player.stack === 0 && player.inHand) return "全下";
    if (state?.turnSeat === player.seat && state.phase === "playing")
      return "思考中";
    if (player.lastAction) {
      if (typeof player.lastAction === "string")
        return actionNames[player.lastAction] || player.lastAction;
      return (
        actionNames[player.lastAction.action] ||
        actionNames[player.lastAction.type] ||
        ""
      );
    }
    if (!player.inHand && state?.phase === "playing") return "等待下一手";
    return player.id === state?.hostId ? "房主" : "已入座";
  }
  function renderSeats() {
    const self = playerSelf();
    const origin = self?.seat ?? 0;
    const players = state?.players || [];
    $("seats").innerHTML = Array.from({ length: 6 }, (_, position) => {
      const seat = (origin + position) % 6;
      const player = players.find((p) => p.seat === seat);
      if (!player)
        return `<div class="seat position-${position}"><div class="seat-empty"><span class="empty-avatar"><i data-lucide="user-round-plus"></i></span><span>空座</span></div></div>`;
      const active = state.phase === "playing" && state.turnSeat === seat;
      const own = player.id === state.selfId;
      let cards = "";
      if (player.cards?.length)
        cards = player.cards.map((card, index) => cardMarkup(card, "", `hole:${player.id}:${index}`)).join("");
      else if (player.hasCards) cards = [0, 1].map(index => cardMarkup("back", "", `hole:${player.id}:${index}`)).join("");
      const removeButton =
        player.isBot && isHost() && state.phase !== "playing"
          ? `<button class="icon-button seat-remove" data-remove-bot="${esc(player.id)}" title="移除 ${esc(player.name)}" aria-label="移除 ${esc(player.name)}"><i data-lucide="x"></i></button>`
          : "";
      return `<div class="seat position-${position} ${own ? "self" : ""} ${active ? "active" : ""} ${player.folded ? "folded" : ""} ${player.winner ? "winner" : ""}" data-player-id="${esc(player.id)}" aria-label="${esc(player.name)}，筹码 ${money(player.stack)}，${esc(actionText(player))}">
        <span class="seat-bet" data-chip-anchor="bet:${esc(player.id)}" style="visibility:${player.bet > 0 ? "visible" : "hidden"}">${window.chipPileMarkup(player.bet, "bet")}<span class="bet-amount chip-money" data-money-key="bet:${esc(player.id)}">${money(player.bet)}</span></span>
        <div class="seat-cards">${cards}</div><div class="seat-body">${state.dealerSeat === seat ? '<span class="seat-dealer" title="庄家">D</span>' : ""}${window.playerAvatarMarkup(player, own)}<div class="seat-details"><div class="seat-name">${player.isBot ? '<i data-lucide="bot"></i>' : ""}<span title="${esc(player.name)}">${esc(player.name)}</span>${own ? '<b class="self-tag">你</b>' : ""}</div>
        <div class="seat-bank" data-chip-anchor="bank:${esc(player.id)}">${window.chipPileMarkup(player.stack, "bank")}<div class="seat-stack chip-money" data-money-key="stack:${esc(player.id)}">${money(player.stack)}</div></div></div>
        ${active ? '<div class="seat-timer"><span id="seat-timer-bar"></span></div>' : ""}${removeButton}</div><span class="seat-status">${esc(actionText(player))}</span></div>`;
    }).join("");
  }
  function renderRoom() {
    const inRoom = Boolean(state);
    document.body.classList.toggle("in-room", inRoom);
    document.body.classList.toggle("playing", state?.phase === "playing");
    if (inRoom && (!$("home-view").hidden || !$("portal-view").hidden)) lobby.reset();
    const route = currentRoute();
    $("portal-view").hidden = inRoom || route !== "portal";
    $("home-view").hidden = inRoom || route !== "holdem";
    $("game-view").hidden = !inRoom;
    $("history-button").hidden = !inRoom;
    $("room-panel").hidden = !inRoom;
    lobby.setConnection(socketConnected() || !auth.get());
    social.update(state, socketConnected());
    if (!state) return;
    $("room-code").textContent = state.code;
    $("table-room-code").textContent = state.code;
    $("table-blinds").textContent = `${money(state.smallBlind)} / ${money(state.bigBlind)}`;
    $("room-blinds").textContent =
      `盲注 ${money(state.smallBlind)} / ${money(state.bigBlind)}`;
    $("player-count").textContent =
      `${state.players.length} / ${state.maxPlayers || 6} 人`;
    $("seated-count").textContent = `${state.players.length} / 6`;
    $("roster").innerHTML = state.players
      .map(
        (p) =>
          `<div class="roster-player">${window.playerAvatarMarkup(p, p.id === state.selfId)}<span class="roster-name">${esc(p.name)}${p.id === state.selfId ? " · 你" : ""}<span class="roster-tag">${p.isBot ? "电脑玩家" : !p.connected ? "已断线" : p.id === state.hostId ? "房主" : "在线"}</span></span><span class="roster-stack">${money(p.stack)}</span>${p.isBot && isHost() && state.phase !== "playing" ? `<button class="icon-button roster-remove" data-remove-bot="${esc(p.id)}" title="移除 ${esc(p.name)}" aria-label="移除 ${esc(p.name)}"><i data-lucide="x"></i></button>` : ""}</div>`,
      )
      .join("");
    const host = isHost();
    $("auto-next-control").hidden = !host || typeof state.autoNext !== "boolean";
    $("auto-next").checked = Boolean(state.autoNext);
    $("auto-next").disabled = pending || !socketConnected();
    const playing = state.phase === "playing";
    const funded = state.players.filter(
      (p) => (p.stack > 0 || p.isBot) && (p.connected || p.isBot),
    ).length;
    $("bot-button").hidden = !host;
    $("bot-button").disabled =
      playing || state.players.length >= 6 || pending || !socketConnected();
    $("start-button").hidden = !host;
    $("start-button").disabled =
      playing || funded < 2 || pending || !socketConnected();
    $("start-label").textContent = state.handNumber > 0 ? "下一手" : "开始牌局";
    const practice = Boolean(state.practice);
    const broke = !playing && Boolean(playerSelf()) && playerSelf().stack === 0;
    $("rebuy-button").hidden = !broke;
    $("rebuy-button").disabled = pending || !socketConnected();
    $("rebuy-button").innerHTML = practice
      ? '<i data-lucide="coins"></i>补充筹码'
      : '<i data-lucide="gift"></i>领取每日补助';
    $("quick-start").hidden = playing || !host;
    $("quick-start").disabled = $("start-button").disabled;
    $("quick-start").querySelector("span").textContent = $("start-label").textContent;
    $("quick-rebuy").hidden = $("rebuy-button").hidden;
    $("quick-rebuy").disabled = $("rebuy-button").disabled;
    $("quick-rebuy").querySelector("span").textContent = practice ? "补充筹码" : "领取每日补助";
    $("quick-invite").hidden = state.phase !== "lobby";
    $("room-wait").textContent = playing
      ? ""
      : funded < 2
        ? "等待至少两位玩家持有筹码"
        : state.phase === "finished" && state.autoNext
          ? nextHandText()
        : host
          ? `${funded} 位玩家已就绪`
          : "等待房主开始牌局";
    $("room-wait").hidden = !$("room-wait").textContent;
    refreshWallet();
  }
  function miniCards(cards) {
    return `<span class="hand-mini-cards">${cards.map(card => cardMarkup(card)).join("")}</span>`;
  }
  function renderHandInfo() {
    const self = playerSelf();
    const hand = state?.selfHand;
    const panel = $("self-hand-panel");
    panel.hidden = !hand || !self?.cards?.length || state?.phase === "finished";
    panel.innerHTML = panel.hidden ? "" : `<div class="hand-description"><span class="hand-label">${self.folded ? "已弃牌" : hand.complete ? "当前牌型" : "起手牌"}</span><strong>${esc(hand.name)}</strong><span class="hand-detail">${esc(hand.detail)}</span></div>`;
    $("table-ready").hidden = !panel.hidden || state?.phase === "finished";
    $("table-ready").textContent = state?.phase === "playing" ? "下一手入局" : "牌桌已就绪";
  }
  function winnerMarkup(winner) {
    const hand = winner.hand;
    const visibility = !winner.cards ? "未亮牌" : !winner.revealed ? "仅自己可见" : "底牌";
    const reason = winner.reason === "folds" ? `其余玩家弃牌${winner.revealed ? " · 已亮牌" : ""}` : "摊牌获胜";
    return `<article class="winner-result" aria-label="${esc(winner.name)} 获胜"><div class="winner-summary"><i data-lucide="trophy"></i><strong class="winner-name">${esc(winner.name)}</strong><strong class="winner-amount">+${money(winner.amount)}</strong><span class="winner-reason">${reason}</span></div><div class="winner-hand"><div class="winner-hole"><span class="hand-label">${visibility}</span>${miniCards(winner.cards || ["back", "back"])}</div>${hand ? `<div class="hand-description"><strong>${esc(hand.name)}</strong><span class="hand-detail">${esc(hand.detail)}</span></div>${hand.complete ? `<div class="winner-best"><span class="hand-label">最佳五张</span>${miniCards(hand.cards)}</div>` : ""}` : '<span class="hand-detail">底牌未公开</span>'}</div></article>`;
  }
  function renderTable() {
    $("hand-number").textContent = state?.handNumber
      ? `第 ${state.handNumber} 手`
      : "尚未开局";
    $("round-label").textContent =
      state?.phase === "playing"
        ? roundNames[state.round] || "进行中"
        : state?.phase === "finished"
          ? "本手结束"
          : state
            ? "准备中"
            : "等待入座";
    $("pot-amount").textContent = money(state?.pot || 0);
    $("pot-pile").innerHTML = window.chipPileMarkup(state?.pot || 0, "pot");
    $("pot-label").textContent =
      state?.phase === "finished" ? "本手底池" : "底池";
    const board = state?.board || [];
    $("board").innerHTML = Array.from({ length: 5 }, (_, i) =>
      cardMarkup(board[i], "", `board:${i}`),
    ).join("");
    $("center-message").textContent = !state
      ? "等待玩家入座"
      : state.phase === "lobby"
        ? "牌桌已就绪"
        : state.phase === "finished"
          ? "本手结束"
          : state.turnSeat == null
            ? "摊牌"
            : `${state.players.find((p) => p.seat === state.turnSeat)?.name || "玩家"} 行动中`;
    $("side-pots").textContent =
      state?.pots?.length > 1
        ? state.pots
            .map((pot, i) => `${i ? "边池 " + i : "主池"} ${money(pot.size)}`)
            .join(" · ")
        : "";
    renderSeats();
    renderHandInfo();
    const results = state?.result || [];
    $("result-panel").hidden = state?.phase !== "finished" || !results.length;
    $("result-panel").innerHTML = results.map(winnerMarkup).join("");
    $("settlement-strip").hidden = state?.phase !== "finished" || !results.length || !settlementReady;
    $("settlement-summary").innerHTML = results.length ? `${miniCards(results[0].cards || ["back", "back"])}<span class="settlement-text"><strong>${results.map(winner => `${esc(winner.name)} +${money(winner.amount)}`).join(" · ")}</strong><span>${results.map(winner => `${winner.reason === "folds" ? "其余玩家弃牌 · " : ""}${esc(winner.hand?.name || "未亮牌")}`).join(" · ")}</span></span>` : "";
    const log = state?.log || [];
    $("history-list").innerHTML = log.length
      ? log
          .slice()
          .reverse()
          .map((entry) => `<li>${esc(entry.text)}</li>`)
          .join("")
      : '<li class="empty-history">暂无记录</li>';
    $("last-event").textContent = log.length
      ? log[log.length - 1].text
      : "同桌 · TEXAS HOLD’EM";
  }
  function renderActions() {
    const self = playerSelf();
    $("your-stack").textContent = self ? money(self.stack) : "—";
    $("show-cards-row").hidden = !state?.canShowCards;
    $("show-cards-button").disabled = pending || !socketConnected();
    const myTurn = Boolean(
      state?.phase === "playing" &&
      state.legal &&
      state.turnSeat === self?.seat,
    );
    const legal = state?.legal;
    $("betting-controls").hidden = !myTurn;
    $("idle-controls").hidden = myTurn;
    $("idle-message").textContent = state?.phase === "playing" ? "牌局进行中" : "";
    tableLayout.update(state);
    let message = "等待入座";
    if (state)
      message =
        state.phase === "finished"
          ? nextHandText()
          : state.phase === "lobby"
            ? "等待开局"
            : self?.folded
              ? "本手已弃牌"
              : self?.inHand && self.stack === 0
                ? "已全下，等待摊牌"
                : myTurn
                  ? "轮到你行动"
                  : "等待其他玩家行动";
    if (!socketConnected()) message = "正在重新连接…";
    $("turn-message").textContent = message;
    if (!myTurn) {
      $("countdown").textContent = "";
      return;
    }
    const actions = legal.actions || [];
    const locked = pending || !socketConnected();
    $("fold-button").disabled = locked || !actions.includes("fold");
    const canCheck = actions.includes("check");
    $("call-button").disabled =
      locked || (!canCheck && !actions.includes("call"));
    $("call-button").querySelector("span").textContent = canCheck
      ? "过牌"
      : `跟注 ${money(legal.callAmount)}`;
    const canRaise = actions.includes("raise") || actions.includes("bet");
    $("raise-toggle").disabled = locked || !canRaise;
    $("raise-toggle").querySelector("span").textContent = actions.includes("bet") ? "下注" : "加注";
    $("raise-button").disabled = locked || !canRaise;
    $("raise-button").querySelector("span").textContent = actions.includes(
      "bet",
    )
      ? "确认下注"
      : "确认加注";
    $("all-in-button").disabled = locked || !legal.canAllIn;
    $("raise-amount").disabled = locked || !canRaise;
    $("raise-slider").disabled = locked || !canRaise;
    document.querySelectorAll("[data-preset]").forEach((button) => {
      button.disabled = locked || !canRaise;
    });
    const min = legal.minRaise ?? 0;
    const max = legal.maxRaise ?? self.stack + self.bet;
    for (const input of [$("raise-amount"), $("raise-slider")]) {
      input.min = String(min);
      input.max = String(max);
    }
    const turnKey = `${state.handNumber}:${state.turnId}`;
    if (previousTurn !== turnKey) {
      previousTurn = turnKey;
      setRaise(min);
    }
    updateCountdown();
  }
  function render() {
    renderRoom();
    renderTable();
    renderActions();
    icons();
    updateCountdown();
  }
  function setRaise(value) {
    const legal = state?.legal;
    if (!legal) return;
    const min = legal.minRaise ?? 0;
    const max = legal.maxRaise ?? min;
    const amount = Math.max(
      min,
      Math.min(max, Math.round(Number(value) || min)),
    );
    $("raise-amount").value = String(amount);
    $("raise-slider").value = String(amount);
  }
  function nextHandText() {
    if (!socketConnected()) return "正在重新连接…";
    if (state?.nextHandAt) return `${Math.max(0, Math.ceil((state.nextHandAt - Date.now()) / 1000))} 秒后开始下一手`;
    if (state?.autoNext) return "等待至少两位玩家持有筹码";
    return "本手结束，等待下一手";
  }
  function updateCountdown() {
    audio.tick(state);
    if (state?.phase === "finished") {
      $("turn-message").textContent = nextHandText();
      if (state.nextHandAt) $("room-wait").textContent = nextHandText();
    }
    if (!state || state.phase !== "playing" || !state.turnDeadline) {
      $("countdown").textContent = "";
      return;
    }
    const seconds = Math.max(
      0,
      Math.ceil((state.turnDeadline - Date.now()) / 1000),
    );
    const myTurn = state.turnSeat === playerSelf()?.seat;
    $("countdown").textContent = myTurn ? `${seconds}s` : "";
    $("countdown").classList.toggle("urgent", seconds <= 10);
    const bar = $("seat-timer-bar");
    if (bar) {
      bar.style.width = `${Math.min(100, (seconds / 30) * 100)}%`;
      bar.style.background = seconds <= 10 ? "var(--red)" : "var(--green)";
    }
  }
  async function act(action, amount) {
    if (!state?.legal || pending) return;
    const payload = {
      action,
      handNumber: state.handNumber,
      turnId: state.turnId,
    };
    if (amount !== undefined) payload.amount = amount;
    await exclusive("game:action", payload);
  }
  function inviteUrl() {
    let base = location.origin;
    if (
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname) &&
      networkUrls.length
    )
      base =
        networkUrls.find(
          (url) => !url.includes("localhost") && !url.includes("127.0.0.1"),
        ) || base;
    const url = new URL(base);
    url.searchParams.set("room", state?.code || session?.code || "");
    return url.href;
  }
  async function copyInvite() {
    const text = inviteUrl();
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext)
        await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement("textarea");
        input.value = text;
        input.style.position = "fixed";
        input.style.left = "-9999px";
        document.body.append(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("copy");
      }
      toast("邀请链接已复制");
    } catch {
      window.prompt("房间邀请链接", text);
    }
  }

  $("bot-button").addEventListener("click", async () => {
    await exclusive("room:bot", {});
    renderRoom();
    icons();
  });
  $("start-button").addEventListener("click", async () => {
    if (await exclusive("room:start", {})) tableLayout.close();
    renderRoom();
    icons();
  });
  $("auto-next").addEventListener("change", async (event) => {
    await exclusive("room:auto-next", { enabled: event.target.checked });
  });
  $("show-cards-button").addEventListener("click", async () => {
    if (state?.canShowCards) await exclusive("game:show-cards", { handNumber: state.handNumber });
  });
  $("rebuy-button").addEventListener("click", async () => {
    if (state?.practice) {
      await exclusive("room:rebuy", {});
      renderRoom();
      icons();
    } else {
      await claimSubsidy();
      renderRoom();
      icons();
    }
  });
  $("quick-start").addEventListener("click", () => $("start-button").click());
  $("quick-rebuy").addEventListener("click", () => $("rebuy-button").click());
  $("quick-invite").addEventListener("click", copyInvite);
  async function leaveRoom() {
    if (await exclusive("room:leave", {})) {
      clearSession();
      await refreshAccountBalance();
    }
  }
  $("leave-button").addEventListener("click", leaveRoom);
  document.querySelector(".brand").addEventListener("click", event => {
    event.preventDefault();
    if (state) leaveRoom();
    else if (currentRoute() !== "portal") location.hash = "#/";
    else { lobby.reset(); refreshLobby(); refreshTables(); }
  });
  window.addEventListener("hashchange", () => {
    renderRoom();
    if (state) return;
    if (currentRoute() === "holdem") refreshLobby();
    else refreshTables();
    icons();
  });
  $("roster").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-interact-player]");
    if (target) {
      $("close-room").click();
      social.openTarget(target.dataset.interactPlayer);
    }
    const button = event.target.closest("[data-remove-bot]");
    if (button) {
      await exclusive("room:remove-bot", { id: button.dataset.removeBot });
      renderRoom();
      icons();
    }
  });
  $("seats").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-interact-player]");
    if (target) social.openTarget(target.dataset.interactPlayer);
    const button = event.target.closest("[data-remove-bot]");
    if (button)
      await exclusive("room:remove-bot", { id: button.dataset.removeBot });
  });
  $("copy-button").addEventListener("click", copyInvite);
  $("share-button").addEventListener("click", async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "同桌 · 德州扑克",
          text: `来房间 ${state.code} 一起玩`,
          url: inviteUrl(),
        });
      } catch (error) {
        if (error.name !== "AbortError") await copyInvite();
      }
    } else await copyInvite();
  });
  $("fold-button").addEventListener("click", () => act("fold"));
  $("call-button").addEventListener("click", () =>
    act(state?.legal?.actions.includes("check") ? "check" : "call"),
  );
  $("raise-button").addEventListener("click", () => {
    setRaise($("raise-amount").value);
    act(
      state?.legal?.actions.includes("bet") ? "bet" : "raise",
      Number($("raise-amount").value),
    );
  });
  $("all-in-button").addEventListener("click", () => act("all-in"));
  $("raise-slider").addEventListener("input", (event) =>
    setRaise(event.target.value),
  );
  $("raise-amount").addEventListener("change", (event) =>
    setRaise(event.target.value),
  );
  document.querySelectorAll("[data-preset]").forEach((button) =>
    button.addEventListener("click", () => {
      if (!state?.legal) return;
      const preset = button.dataset.preset;
      if (preset === "max") {
        setRaise(state.legal.maxRaise);
        return;
      }
      const self = playerSelf();
      const callTo = self.bet + state.legal.callAmount;
      setRaise(
        preset === "min"
          ? state.legal.minRaise
          : callTo +
              Math.round(
                (state.pot + state.legal.callAmount) *
                  (preset === "half" ? 0.5 : 1),
              ),
      );
    }),
  );
  function toggleHistory(open) {
    $("history-drawer").hidden = !open;
    $("history-backdrop").hidden = !open;
    if (open) $("close-history").focus();
    else $("history-button").focus();
  }
  $("history-button").addEventListener("click", () => toggleHistory(true));
  $("close-history").addEventListener("click", () => toggleHistory(false));
  $("history-backdrop").addEventListener("click", () => toggleHistory(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("history-drawer").hidden)
      toggleHistory(false);
  });
  async function onSocketConnect() {
    $("connection").classList.add("connected");
    $("connection-label").textContent = "已连接";
    document.body.classList.remove("offline");
    lobby.setConnection(true);
    if (session) await resumeSeat();
    await refreshAccountBalance();
    if (!state) await refreshLobby();
    refreshTables();
    renderRoom();
    renderActions();
    icons();
  }
  function onSocketDisconnect() {
    skipNextDeal = true;
    dealing.cancel();
    chips.cancel();
    celebration.cancel();
    audio.cancel();
    tableLayout.reset();
    social.cancel();
    $("connection").classList.remove("connected");
    $("connection-label").textContent = "重连中";
    document.body.classList.add("offline");
    refreshTables();
    renderRoom();
    renderActions();
  }
  function onSocketConnectError(error) {
    if (auth.get() && error?.message && String(error.message).includes("登录")) {
      teardownSocket();
      handleLogout("登录已过期，请重新登录");
      return;
    }
    $("connection").classList.remove("connected");
    $("connection-label").textContent = "连接中";
    lobby.setConnection(false);
    renderActions();
  }
  function onRoomState(next) {
    const previous = state;
    const newSettlement = next.phase === "finished" && (previous?.phase !== "finished" || previous?.handNumber !== next.handNumber || previous?.code !== next.code);
    if (newSettlement || next.phase !== "finished") {
      clearTimeout(settlementTimer);
      settlementReady = false;
    }
    const chipPositions = chips.capture();
    state = next;
    render();
    dealing.update(previous, next, !skipNextDeal);
    celebration.update(previous, next, !skipNextDeal, dealing.remaining());
    chips.update(previous, next, chipPositions, !skipNextDeal, dealing.remaining());
    audio.update(previous, next, !skipNextDeal, dealing.remaining());
    if (newSettlement) {
      const delay = dealing.remaining();
      settlementTimer = setTimeout(() => {
        settlementReady = true;
        $("settlement-strip").hidden = state?.phase !== "finished";
      }, delay);
    }
    social.update(next, socketConnected());
    skipNextDeal = false;
  }
  const queryRoom = new URLSearchParams(location.search).get("room");
  if (queryRoom && !session) pendingInviteCode = queryRoom.toUpperCase().slice(0, 8);
  fetch("/api/network")
    .then((response) => response.json())
    .then((data) => {
      networkUrls = Array.isArray(data.urls)
        ? data.urls.filter((url) => /^https?:\/\//.test(url))
        : [];
      $("network-addresses").innerHTML = (
        networkUrls.length ? networkUrls : [location.origin]
      )
        .map(
          (url) =>
            `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ""))}<span aria-hidden="true"> ↗</span></a>`,
        )
        .join("");
    })
    .catch(() => {
      $("network-addresses").textContent = location.host;
    });
  render();
  topbar.setAccount(auth.get());
  portal.setLoggedIn(Boolean(auth.get()));
  if (auth.get()) {
    connectSocket();
  } else if (currentRoute() === "holdem") {
    refreshLobby();
  } else {
    refreshTables();
  }
  setInterval(updateCountdown, 1000);
  setInterval(() => {
    if (!auth.get() && !state && !document.hidden) refreshLobby();
  }, 12000);
})();
