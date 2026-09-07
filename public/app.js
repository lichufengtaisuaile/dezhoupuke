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
  let state = null;
  let session = null;
  let pending = false;
  let toastTimeout;
  let previousTurn = "";
  let networkUrls = [];
  let skipNextDeal = true;
  const dealing = window.createDealingEffects($("table-stage"), $("card-deck"));
  const chips = window.createChipEffects($("table-stage"));
  try {
    session = JSON.parse(sessionStorage.getItem(storageKey) || "null");
  } catch {
    sessionStorage.removeItem(storageKey);
  }
  const socket = io({ reconnection: true });
  const lobby = window.createLobby({
    root: $("home-view"),
    onCreate: payload => enterRoom("room:create", payload),
    onJoin: payload => enterRoom("room:join", payload),
    onRefresh: refreshLobby,
  });
  const social = window.createSocial({
    root: $("social-bar"), stage: $("table-stage"),
    send: payload => request("room:react", payload), notify: toast,
  });

  async function enterRoom(event, payload) {
    const response = await exclusive(event, payload);
    if (response) saveSession(response);
    else throw new Error($("toast").textContent || "未能进入房间，请重试");
    return response;
  }
  async function refreshLobby() {
    const response = await request("lobby:list");
    if (response && !state) lobby.updateRooms(response.rooms);
    return response;
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
    social.cancel();
    state = null;
    session = null;
    previousTurn = "";
    sessionStorage.removeItem(storageKey);
    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState(null, "", url);
    $("history-drawer").hidden = $("history-backdrop").hidden = true;
    render();
    if (socket.connected) refreshLobby();
  }
  function request(event, payload = {}) {
    return new Promise((resolve) => {
      if (!socket.connected) {
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
        <div class="seat-cards">${cards}</div><div class="seat-body">${state.dealerSeat === seat ? '<span class="seat-dealer" title="庄家">D</span>' : ""}<div class="seat-name">${player.isBot ? '<i data-lucide="bot"></i>' : ""}<button class="seat-interact" data-interact-player="${esc(player.id)}" title="与 ${esc(player.name)} 互动">${esc(player.name)}</button>${own ? '<b class="self-tag">你</b>' : ""}</div>
        <div class="seat-bank" data-chip-anchor="bank:${esc(player.id)}">${window.chipPileMarkup(player.stack, "bank")}<div class="seat-stack chip-money" data-money-key="stack:${esc(player.id)}">${money(player.stack)}</div></div>
        ${active ? '<div class="seat-timer"><span id="seat-timer-bar"></span></div>' : ""}${removeButton}</div><span class="seat-status">${esc(actionText(player))}</span></div>`;
    }).join("");
  }
  function renderRoom() {
    const inRoom = Boolean(state);
    document.body.classList.toggle("in-room", inRoom);
    document.body.classList.toggle("playing", state?.phase === "playing");
    if (inRoom && !$("home-view").hidden) lobby.reset();
    $("home-view").hidden = inRoom;
    $("game-view").hidden = !inRoom;
    $("history-button").hidden = !inRoom;
    $("room-panel").hidden = !inRoom;
    lobby.setConnection(socket.connected);
    social.update(state, socket.connected);
    if (!state) return;
    $("room-code").textContent = state.code;
    $("room-blinds").textContent =
      `盲注 ${money(state.smallBlind)} / ${money(state.bigBlind)}`;
    $("player-count").textContent =
      `${state.players.length} / ${state.maxPlayers || 6} 人`;
    $("seated-count").textContent = `${state.players.length} / 6`;
    $("roster").innerHTML = state.players
      .map(
        (p) =>
          `<div class="roster-player"><span class="roster-avatar">${p.isBot ? '<i data-lucide="bot"></i>' : esc(p.name.slice(0, 1))}</span><span class="roster-name">${esc(p.name)}${p.id === state.selfId ? " · 你" : ""}<span class="roster-tag">${p.isBot ? "电脑玩家" : !p.connected ? "已断线" : p.id === state.hostId ? "房主" : "在线"}</span></span><span class="roster-stack">${money(p.stack)}</span>${p.isBot && isHost() && state.phase !== "playing" ? `<button class="icon-button roster-remove" data-remove-bot="${esc(p.id)}" title="移除 ${esc(p.name)}" aria-label="移除 ${esc(p.name)}"><i data-lucide="x"></i></button>` : ""}</div>`,
      )
      .join("");
    const host = isHost();
    $("auto-next-control").hidden = !host || typeof state.autoNext !== "boolean";
    $("auto-next").checked = Boolean(state.autoNext);
    $("auto-next").disabled = pending || !socket.connected;
    const playing = state.phase === "playing";
    const funded = state.players.filter(
      (p) => (p.stack > 0 || p.isBot) && (p.connected || p.isBot),
    ).length;
    $("bot-button").hidden = !host;
    $("bot-button").disabled =
      playing || state.players.length >= 6 || pending || !socket.connected;
    $("start-button").hidden = !host;
    $("start-button").disabled =
      playing || funded < 2 || pending || !socket.connected;
    $("start-label").textContent = state.handNumber > 0 ? "下一手" : "开始牌局";
    $("rebuy-button").hidden =
      playing || !playerSelf() || playerSelf().stack > 0;
    $("rebuy-button").disabled = pending || !socket.connected;
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
    const results = state?.result || [];
    $("result-panel").hidden = state?.phase !== "finished" || !results.length;
    $("result-panel").innerHTML = results.length
      ? `<i data-lucide="trophy"></i><div class="result-items">${results.map((r) => `<div class="result-item">${esc(r.name)}<strong>+${money(r.amount)}</strong>${r.handName ? `<small>${esc(r.handName)}</small>` : ""}</div>`).join("")}</div>`
      : "";
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
    const myTurn = Boolean(
      state?.phase === "playing" &&
      state.legal &&
      state.turnSeat === self?.seat,
    );
    const legal = state?.legal;
    $("betting-controls").hidden = !myTurn;
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
    if (!socket.connected) message = "正在重新连接…";
    $("turn-message").textContent = message;
    if (!myTurn) {
      $("countdown").textContent = "";
      return;
    }
    const actions = legal.actions || [];
    const locked = pending || !socket.connected;
    $("fold-button").disabled = locked || !actions.includes("fold");
    const canCheck = actions.includes("check");
    $("call-button").disabled =
      locked || (!canCheck && !actions.includes("call"));
    $("call-button").querySelector("span").textContent = canCheck
      ? "过牌"
      : `跟注 ${money(legal.callAmount)}`;
    const canRaise = actions.includes("raise") || actions.includes("bet");
    $("raise-button").disabled = locked || !canRaise;
    $("raise-button").querySelector("span").textContent = actions.includes(
      "bet",
    )
      ? "下注"
      : "加注";
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
    if (!socket.connected) return "正在重新连接…";
    if (state?.nextHandAt) return `${Math.max(0, Math.ceil((state.nextHandAt - Date.now()) / 1000))} 秒后开始下一手`;
    if (state?.autoNext) return "等待至少两位玩家持有筹码";
    return "本手结束，等待下一手";
  }
  function updateCountdown() {
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
    await exclusive("room:start", {});
    renderRoom();
    icons();
  });
  $("auto-next").addEventListener("change", async (event) => {
    await exclusive("room:auto-next", { enabled: event.target.checked });
  });
  $("rebuy-button").addEventListener("click", async () => {
    await exclusive("room:rebuy", {});
    renderRoom();
    icons();
  });
  async function leaveRoom() {
    if (await exclusive("room:leave", {})) {
      clearSession();
    }
  }
  $("leave-button").addEventListener("click", leaveRoom);
  document.querySelector(".brand").addEventListener("click", event => {
    event.preventDefault();
    if (state) leaveRoom();
    else { lobby.reset(); refreshLobby(); }
  });
  $("roster").addEventListener("click", async (event) => {
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
  socket.on("connect", async () => {
    $("connection").classList.add("connected");
    $("connection-label").textContent = "已连接";
    document.body.classList.remove("offline");
    lobby.setConnection(true);
    if (session) {
      const response = await request("room:resume", {
        code: session.code,
        token: session.token,
      });
      if (response) saveSession(response);
      else clearSession();
    }
    if (!state) await refreshLobby();
    renderRoom();
    renderActions();
    icons();
  });
  socket.on("disconnect", () => {
    skipNextDeal = true;
    dealing.cancel();
    chips.cancel();
    social.cancel();
    $("connection").classList.remove("connected");
    $("connection-label").textContent = "重连中";
    document.body.classList.add("offline");
    renderRoom();
    renderActions();
  });
  socket.on("connect_error", () => {
    $("connection").classList.remove("connected");
    $("connection-label").textContent = "连接中";
    lobby.setConnection(false);
    renderActions();
  });
  socket.on("room:state", (next) => {
    const previous = state;
    const chipPositions = chips.capture();
    state = next;
    render();
    dealing.update(previous, next, !skipNextDeal);
    chips.update(previous, next, chipPositions, !skipNextDeal, dealing.remaining());
    social.update(next, socket.connected);
    skipNextDeal = false;
  });
  socket.on("lobby:state", data => {
    if (!state) lobby.updateRooms(data.rooms);
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
  const queryRoom = new URLSearchParams(location.search).get("room");
  if (queryRoom && !session) lobby.showInvite(queryRoom.toUpperCase().slice(0, 8));
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
  setInterval(updateCountdown, 1000);
})();
