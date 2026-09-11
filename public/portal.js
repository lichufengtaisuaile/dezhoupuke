(() => {
  "use strict";

  // 门户游戏目录：新增游戏只需在这里加一条配置。
  const GAMES = [
    {
      id: "holdem",
      name: "德州扑克",
      icon: "spade",
      description: "2–6 人私人牌桌，无限注对战，支持练习模式",
      available: true,
    },
    {
      id: "slots",
      name: "老虎机",
      icon: "cherry",
      description: "红金复古街机拉霸，共享钱包筹码，服务端开奖",
      available: true,
    },
    {
      id: "mahjong",
      name: "血流红中",
      icon: "dices",
      description: "四人四川麻将，红中赖子、胡后继续，支持电脑陪练",
      available: true,
    },
    {
      id: "kawuxing",
      name: "卡五星",
      icon: "grid-3x3",
      description: "湖北卡五星，赖子百搭",
      available: false,
    },
  ];

  window.createPortal = function ({ root, onEnterGame, onReturnToTable }) {
    let online = null;
    let tables = [];

    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
    const number = (value) => Number(value || 0).toLocaleString("zh-CN");
    const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
    const icons = () => window.lucide?.createIcons();
    const get = (name) => root.querySelector(`[data-portal="${name}"]`);

    root.classList.add("portal-view");
    root.innerHTML = `
      <section class="portal-hero">
        <span class="home-overline">同桌 · 多游戏平台</span>
        <h1>选一个游戏，开局</h1>
        <p>和朋友同桌对战：私人房间、钱包筹码、每日补助、战绩排行。</p>
        <p class="portal-guest-hint" data-portal="guest-hint" hidden><i data-lucide="circle-alert"></i>登录后可创建房间、记录战绩</p>
      </section>
      <section aria-label="游戏列表">
        <div class="portal-games" data-portal="games"></div>
      </section>
      <section class="portal-tables" data-portal="tables" hidden aria-label="我的进行中牌桌">
        <div class="section-label"><span>我的进行中</span><span data-portal="tables-count"></span></div>
        <div class="portal-table-list" data-portal="table-list"></div>
      </section>`;

    function renderGames() {
      get("games").innerHTML = GAMES.map((game) => {
        if (!game.available) {
          return `<article class="portal-game is-disabled" aria-label="${esc(game.name)}，即将上线">
            <div class="portal-game-icon">${icon(game.icon)}</div>
            <div class="portal-game-info"><h2>${esc(game.name)}</h2><p>${esc(game.description)}</p></div>
            <span class="portal-game-badge">即将上线</span>
          </article>`;
        }
        return `<button type="button" class="portal-game" data-game="${esc(game.id)}" aria-label="进入${esc(game.name)}">
          <div class="portal-game-icon">${icon(game.icon)}</div>
          <div class="portal-game-info"><h2>${esc(game.name)}</h2><p>${esc(game.description)}</p>
            ${game.id === "holdem" ? `<span class="portal-game-online" data-portal="holdem-online" ${online === null ? "hidden" : ""}></span>` : ""}
          </div>
          <span class="portal-game-go">${icon("chevron-right")}</span>
        </button>`;
      }).join("");
      renderOnline();
      icons();
    }

    function renderOnline() {
      const el = root.querySelector("[data-portal='holdem-online']");
      if (!el || online === null) return;
      el.hidden = false;
      el.innerHTML = `${icon("wifi")}${online} 个房间在线`;
      icons();
    }

    function renderTables() {
      const section = get("tables");
      section.hidden = tables.length === 0;
      if (!tables.length) {
        get("table-list").innerHTML = "";
        return;
      }
      get("tables-count").textContent = `${tables.length} 桌`;
      get("table-list").innerHTML = tables.map((table) => `
        <button type="button" class="portal-table" data-table-code="${esc(table.code)}" data-table-game="${esc(table.game || 'holdem')}">
          <span class="portal-table-main">
            <strong>#${esc(table.code)}</strong>
            <span class="portal-table-meta">${table.game === 'mahjong' ? `血流红中 · 底分 ${number(table.base)}` : `德州 · 盲注 ${number(table.smallBlind)} / ${number(table.bigBlind)}`}${table.practice ? ' · <b class="portal-table-practice">练习桌</b>' : ""}</span>
          </span>
          <span class="portal-table-state${table.playing ? " is-playing" : ""}">${table.playing ? "对局中" : "等待中"}</span>
          <span class="portal-table-stack">${icon("coins")}桌上 ${number(table.myStack)}</span>
          ${icon("chevron-right")}
        </button>`).join("");
      icons();
    }

    get("games").addEventListener("click", (event) => {
      const card = event.target.closest("[data-game]");
      if (card && onEnterGame) onEnterGame(card.dataset.game);
    });
    get("table-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-table-code]");
      if (item && onReturnToTable) onReturnToTable(item.dataset.tableCode, item.dataset.tableGame);
    });

    renderGames();
    return {
      setHoldemOnline(count) {
        if (online === Number(count)) return;
        online = Number(count);
        renderOnline();
      },
      setTables(next) {
        tables = Array.isArray(next) ? next : [];
        renderTables();
      },
      setLoggedIn(loggedIn) {
        const hint = get("guest-hint");
        if (hint) hint.hidden = Boolean(loggedIn);
      },
    };
  };
})();
