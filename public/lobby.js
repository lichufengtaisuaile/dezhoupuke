(() => {
  "use strict";

  window.createLobby = function ({ root, onCreate, onJoin, onRefresh }) {
    let rooms = [];
    let connected = false;
    let pending = false;
    let loading = true;
    let refreshing = false;
    let submitting = false;
    let filter = "all";
    let query = "";

    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
    const number = (value) => Number(value || 0).toLocaleString("zh-CN");
    const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
    const icons = () => window.lucide?.createIcons();
    const get = (name) => root.querySelector(`[data-lobby="${name}"]`);
    const busy = () => pending || submitting;
    const phaseText = (room) => room.phase === "playing" ? "对局中" : room.phase === "finished" ? "等待下一手" : "等待开局";
    let savedName = "";
    try { savedName = localStorage.getItem("tongzhuo-name") || ""; } catch { /* Storage may be disabled. */ }

    root.classList.add("home-view");
    root.innerHTML = `
      <section class="home-heading" aria-labelledby="home-title">
        <div class="home-title-group">
          <span class="home-overline">同桌 · 德州扑克</span>
          <h1 id="home-title">房间大厅</h1>
        </div>
        <div class="home-commands">
          <button class="button secondary" type="button" data-lobby="open-join">${icon("hash")}<span>房间号加入</span></button>
          <button class="button primary" type="button" data-lobby="open-create">${icon("plus")}<span>创建房间</span></button>
        </div>
      </section>

      <section class="home-identity" aria-label="玩家资料">
        <div class="home-avatar" aria-hidden="true">${icon("user-round")}</div>
        <div class="home-name-field">
          <label for="home-nickname">你的昵称</label>
          <input id="home-nickname" data-lobby="nickname" autocomplete="nickname" maxlength="12" value="${esc(savedName)}" placeholder="牌桌上的名字" />
        </div>
        <div class="home-live-meta"><span class="home-live-dot"></span><span data-lobby="connection">连接中</span></div>
      </section>

      <section class="home-rooms" aria-labelledby="home-rooms-heading">
        <div class="home-room-heading">
          <h2 id="home-rooms-heading">在线牌桌 <span class="home-room-count" data-lobby="count">0</span></h2>
          <button type="button" class="icon-button bordered" data-lobby="refresh" title="刷新房间" aria-label="刷新房间">${icon("refresh-cw")}</button>
        </div>
        <div class="home-filter-row">
          <div class="home-filters" role="group" aria-label="房间状态">
            <button type="button" data-filter="all" aria-pressed="true">全部</button>
            <button type="button" data-filter="waiting" aria-pressed="false">等待中</button>
            <button type="button" data-filter="playing" aria-pressed="false">对局中</button>
          </div>
          <div class="input-wrap home-search">${icon("search")}<input data-lobby="search" type="search" aria-label="搜索房间号或房主" placeholder="搜索房间号 / 房主" autocomplete="off" /></div>
        </div>
        <div class="home-room-list" data-lobby="rooms"></div>
        <p class="home-list-status" data-lobby="status" role="status" aria-live="polite"></p>
      </section>

      <dialog class="home-dialog" data-lobby="create-dialog" aria-labelledby="home-create-title">
        <div class="home-dialog-heading"><h2 id="home-create-title">创建房间</h2><button type="button" class="icon-button" data-close="create-dialog" aria-label="关闭创建房间" title="关闭">${icon("x")}</button></div>
        <form data-lobby="create-form" class="home-dialog-form" autocomplete="off">
          <label for="home-create-name">你的昵称</label>
          <div class="input-wrap">${icon("user-round")}<input id="home-create-name" name="name" maxlength="12" autocomplete="nickname" required /></div>
          <div class="form-pair">
            <div><label for="home-blinds">小盲 / 大盲</label><select id="home-blinds" name="blinds"><option value="10,20">10 / 20</option><option value="25,50">25 / 50</option><option value="50,100">50 / 100</option></select></div>
            <div><label for="home-buy-in">初始筹码</label><select id="home-buy-in" name="buyIn"><option value="2000">2,000</option><option value="5000">5,000</option><option value="10000">10,000</option></select></div>
          </div>
          <div class="home-create-summary"><span>${icon("users-round")}2–6 人</span><span>${icon("coins")}无限注</span><span>休闲筹码</span></div>
          <p class="home-dialog-error" data-lobby="create-error" role="alert" hidden></p>
          <button type="submit" class="button primary full">${icon("plus")}创建牌桌</button>
        </form>
      </dialog>

      <dialog class="home-dialog" data-lobby="join-dialog" aria-labelledby="home-join-title">
        <div class="home-dialog-heading"><h2 id="home-join-title">加入房间</h2><button type="button" class="icon-button" data-close="join-dialog" aria-label="关闭加入房间" title="关闭">${icon("x")}</button></div>
        <form data-lobby="join-form" class="home-dialog-form" autocomplete="off">
          <label for="home-join-name">你的昵称</label>
          <div class="input-wrap">${icon("user-round")}<input id="home-join-name" name="name" maxlength="12" autocomplete="nickname" required /></div>
          <label for="home-join-code">房间号</label>
          <div class="input-wrap">${icon("hash")}<input id="home-join-code" name="code" minlength="6" maxlength="6" pattern="[A-Za-z0-9]{6}" placeholder="6 位房间号" autocapitalize="characters" spellcheck="false" required /></div>
          <p class="home-join-detail" data-lobby="join-detail" hidden></p>
          <p class="home-dialog-error" data-lobby="join-error" role="alert" hidden></p>
          <button type="submit" class="button primary full">${icon("log-in")}加入牌桌</button>
        </form>
      </dialog>`;

    function rememberName(value) {
      get("nickname").value = value;
      try { localStorage.setItem("tongzhuo-name", value); } catch { /* Storage may be disabled. */ }
    }

    function tableMarkup(room) {
      const count = Math.min(6, Math.max(0, Number(room.playerCount) || 0));
      return `<div class="home-table-art" aria-hidden="true"><div class="home-mini-felt"><span class="home-mini-suit">♠</span><span class="home-mini-chip"></span></div>${Array.from({ length: 6 }, (_, index) => `<span class="home-mini-seat seat-${index}${index < count ? " occupied" : ""}"></span>`).join("")}</div>`;
    }

    function renderRooms() {
      get("count").textContent = String(rooms.length);
      const shown = rooms.filter((room) => {
        const phaseMatches = filter === "all" || (filter === "playing" ? room.phase === "playing" : room.phase !== "playing");
        return phaseMatches && `${room.code} ${room.hostName}`.toLowerCase().includes(query.toLowerCase());
      });
      let emptyTitle = "还没有房间";
      let emptyIcon = "armchair";
      let emptyAction = `<button class="button primary" type="button" data-empty-create>${icon("plus")}创建房间</button>`;
      if (!connected) {
        emptyTitle = "正在连接牌桌";
        emptyIcon = "wifi";
        emptyAction = "";
      } else if (loading) {
        emptyTitle = "正在获取房间";
        emptyIcon = "loader-circle";
        emptyAction = "";
      } else if (rooms.length) {
        emptyTitle = "暂无符合条件的房间";
        emptyIcon = "search";
        emptyAction = `<button type="button" class="button secondary" data-clear-filter>${icon("list-filter")}全部房间</button>`;
      }

      get("rooms").innerHTML = shown.length && connected ? shown.map((room) => {
        const full = room.playerCount >= room.maxPlayers;
        const playing = room.phase === "playing";
        return `<article class="home-room-card${full ? " is-full" : ""}" aria-label="${esc(room.hostName)}的牌桌，房间 ${esc(room.code)}">
          <div class="home-card-top"><span class="home-room-phase${playing ? " is-playing" : ""}"><span></span>${phaseText(room)}</span><span class="home-code">#${esc(room.code)}</span></div>
          <div class="home-card-main">${tableMarkup(room)}<div class="home-card-info"><h3 title="${esc(room.hostName)}">${esc(room.hostName)}的牌桌</h3><span class="home-room-host">${icon("crown")}<span>${esc(room.hostName)}</span></span></div></div>
          <dl class="home-card-stakes"><div><dt>小盲 / 大盲</dt><dd>${number(room.smallBlind)} <span>/</span> ${number(room.bigBlind)}</dd></div><div><dt>初始筹码</dt><dd>${number(room.buyIn)}</dd></div></dl>
          <div class="home-card-bottom"><span class="home-occupancy">${icon("users-round")}<strong>${number(room.playerCount)}</strong><span>/ ${number(room.maxPlayers)} 人</span></span><button type="button" class="button ${full ? "secondary" : "primary"}" data-room-code="${esc(room.code)}"${full || busy() ? " disabled" : ""}>${icon(full ? "lock-keyhole" : "log-in")}${full ? "已满员" : "加入牌桌"}</button></div>
        </article>`;
      }).join("") : `<div class="home-empty${loading || !connected ? " is-loading" : ""}"><div class="home-empty-icon">${icon(emptyIcon)}</div><h3>${emptyTitle}</h3>${emptyAction}</div>`;
      get("status").textContent = connected && !loading && rooms.length ? `显示 ${shown.length} 个房间 · ${rooms.reduce((total, room) => total + (Number(room.onlineCount) || 0), 0)} 人在线` : "";
      icons();
      syncControls();
    }

    function syncControls() {
      get("refresh").disabled = !connected || refreshing;
      get("refresh").classList.toggle("is-refreshing", refreshing);
      for (const form of [get("create-form"), get("join-form")]) {
        form.querySelector('[type="submit"]').disabled = !connected || busy();
        form.setAttribute("aria-busy", String(busy()));
      }
      for (const button of root.querySelectorAll("[data-room-code]")) {
        const room = rooms.find((item) => item.code === button.dataset.roomCode);
        button.disabled = !connected || busy() || !room || room.playerCount >= room.maxPlayers;
      }
    }

    function openDialog(kind, code = "") {
      const dialog = get(`${kind}-dialog`);
      const form = get(`${kind}-form`);
      form.elements.name.value = get("nickname").value;
      form.elements.name.setCustomValidity("");
      get(`${kind}-error`).hidden = true;
      if (kind === "join") {
        form.elements.code.value = String(code).trim().toUpperCase();
        updateJoinDetail();
      }
      if (!dialog.open) dialog.showModal();
      const target = !form.elements.name.value.trim() ? form.elements.name : kind === "join" && !code ? form.elements.code : form.querySelector('[type="submit"]');
      target.focus();
    }

    function updateJoinDetail() {
      const room = rooms.find((item) => item.code === get("join-form").elements.code.value);
      const detail = get("join-detail");
      detail.hidden = !room;
      detail.textContent = room ? `${room.hostName}的牌桌 · ${phaseText(room)} · ${room.playerCount} / ${room.maxPlayers} 人` : "";
    }

    async function submit(kind, event) {
      event.preventDefault();
      if (!connected || busy()) return;
      const form = get(`${kind}-form`);
      const name = form.elements.name.value.trim();
      form.elements.name.setCustomValidity(name ? "" : "请输入昵称");
      if (!form.reportValidity()) return;
      rememberName(name);
      submitting = true;
      syncControls();
      get(`${kind}-error`).hidden = true;
      try {
        let response;
        if (kind === "create") {
          const [smallBlind, bigBlind] = form.elements.blinds.value.split(",").map(Number);
          response = await onCreate({ name, smallBlind, bigBlind, buyIn: Number(form.elements.buyIn.value) });
        } else {
          response = await onJoin({ name, code: form.elements.code.value.trim().toUpperCase() });
        }
        if (response) get(`${kind}-dialog`).close();
      } catch (error) {
        get(`${kind}-error`).textContent = error?.message || "操作未完成，请稍后重试";
        get(`${kind}-error`).hidden = false;
      } finally {
        submitting = false;
        syncControls();
      }
    }

    get("nickname").addEventListener("input", (event) => rememberName(event.target.value));
    get("open-create").addEventListener("click", () => openDialog("create"));
    get("open-join").addEventListener("click", () => openDialog("join"));
    get("create-form").addEventListener("submit", (event) => submit("create", event));
    get("join-form").addEventListener("submit", (event) => submit("join", event));
    for (const kind of ["create", "join"]) {
      get(`${kind}-form`).elements.name.addEventListener("input", (event) => {
        event.target.setCustomValidity("");
        rememberName(event.target.value);
      });
      const dialog = get(`${kind}-dialog`);
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      });
    }
    get("join-form").elements.code.addEventListener("input", (event) => {
      event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      updateJoinDetail();
    });
    root.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => get(button.dataset.close).close()));
    root.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
      filter = button.dataset.filter;
      root.querySelectorAll("[data-filter]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.filter === filter)));
      renderRooms();
    }));
    get("search").addEventListener("input", (event) => { query = event.target.value.trim(); renderRooms(); });
    get("rooms").addEventListener("click", (event) => {
      const join = event.target.closest("[data-room-code]");
      if (join && !join.disabled) openDialog("join", join.dataset.roomCode);
      if (event.target.closest("[data-empty-create]")) openDialog("create");
      if (event.target.closest("[data-clear-filter]")) {
        query = "";
        get("search").value = "";
        root.querySelector('[data-filter="all"]').click();
      }
    });
    get("refresh").addEventListener("click", async () => {
      if (!connected || refreshing) return;
      refreshing = true;
      syncControls();
      try {
        await onRefresh();
      } catch {
        get("status").textContent = "房间列表暂时无法刷新";
      } finally {
        refreshing = false;
        syncControls();
      }
    });

    renderRooms();
    return {
      updateRooms(next) {
        rooms = Array.isArray(next) ? next : [];
        loading = false;
        renderRooms();
        updateJoinDetail();
      },
      setConnection(value) {
        if (connected === Boolean(value)) return;
        connected = Boolean(value);
        root.classList.toggle("is-connected", connected);
        get("connection").textContent = connected ? "已连接" : "正在重新连接";
        renderRooms();
      },
      setBusy(value) { pending = Boolean(value); syncControls(); },
      showInvite(code) { openDialog("join", code); },
      reset() {
        for (const kind of ["create", "join"]) {
          get(`${kind}-dialog`).close();
          get(`${kind}-error`).hidden = true;
        }
        pending = false;
        submitting = false;
        query = "";
        get("search").value = "";
        filter = "all";
        root.querySelectorAll("[data-filter]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.filter === filter)));
        renderRooms();
      },
    };
  };
})();
