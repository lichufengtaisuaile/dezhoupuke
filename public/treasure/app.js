"use strict";

const auth = window.tongzhuoAuth;
const catalog = window.tongzhuoAvatars.prizeItems;
const money = auth.money;
const esc = auth.esc;
const icons = () => window.lucide?.createIcons();
const BOX_PRICE = 5000;
const TEN_OPEN_COUNT = 10;
const TEN_OPEN_PRICE = BOX_PRICE * TEN_OPEN_COUNT;
const TARGET_INDEX = 38;
const REEL_LENGTH = 44;
const PENDING_OPEN_PREFIX = "tongzhuo-treasure-pending:";
const PENDING_TEN_PREFIX = "tongzhuo-treasure-pending-ten:";

const elements = {
  tabs: [...document.querySelectorAll("[data-tab]")],
  panels: [...document.querySelectorAll("[data-panel]")],
  reelMachine: document.querySelector("#reelMachine"),
  reelWindow: document.querySelector("#reelWindow"),
  reelTrack: document.querySelector("#reelTrack"),
  openingResult: document.querySelector("#openingResult"),
  openButton: document.querySelector("#openButton"),
  tenOpenButton: document.querySelector("#tenOpenButton"),
  skipButton: document.querySelector("#skipButton"),
  balance: document.querySelector("#balanceValue"),
  history: document.querySelector("#openHistory"),
  galleryGrid: document.querySelector("#galleryGrid"),
  gallerySeries: document.querySelector("#gallerySeries"),
  galleryProgress: document.querySelector("#galleryProgress"),
  showcaseStrip: document.querySelector("#showcaseStrip"),
  inventory: document.querySelector("#inventoryGrid"),
  market: document.querySelector("#marketGrid"),
  marketSummary: document.querySelector("#marketSummary"),
  marketSeries: document.querySelector("#marketSeries"),
  inventoryCount: document.querySelector("#inventoryCount"),
  listingCount: document.querySelector("#listingCount"),
  sellDialog: document.querySelector("#sellDialog"),
  sellItem: document.querySelector("#sellItem"),
  sellForm: document.querySelector("#sellForm"),
  sellPrice: document.querySelector("#sellPrice"),
  sellerReceives: document.querySelector("#sellerReceives"),
  sellError: document.querySelector("#sellError"),
  buyDialog: document.querySelector("#buyDialog"),
  buyItem: document.querySelector("#buyItem"),
  buyError: document.querySelector("#buyError"),
  confirmBuy: document.querySelector("#confirmBuy"),
  prizeDialog: document.querySelector("#prizeDialog"),
  prizeGallery: document.querySelector("#prizeGallery"),
  batchDialog: document.querySelector("#batchDialog"),
  batchSummary: document.querySelector("#batchSummary"),
  batchResultGrid: document.querySelector("#batchResultGrid"),
  toast: document.querySelector("#treasureToast"),
  live: document.querySelector("#treasureLive"),
};

const topbar = window.createTopbar({
  mount: document.querySelector("#topbarIdentity"),
  onRequireAuth: () => requireAuth(),
});

let phase = "IDLE";
let inventory = [];
let listings = [];
let gallery = [];
let galleryFilter = "all";
let sellTarget = null;
let buyTarget = null;
let toastTimer = null;
let animationTimer = null;
let settlePending = null;

function pendingOpenKey() {
  const accountId = auth.get()?.accountId;
  return accountId ? `${PENDING_OPEN_PREFIX}${accountId}` : "";
}

function pendingOpenId() {
  const key = pendingOpenKey();
  if (!key) return newRequestId();
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = newRequestId();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return newRequestId();
  }
}

function clearPendingOpen() {
  const key = pendingOpenKey();
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}

function pendingTenKey() {
  const accountId = auth.get()?.accountId;
  return accountId ? `${PENDING_TEN_PREFIX}${accountId}` : "";
}

function pendingTenId() {
  const key = pendingTenKey();
  if (!key) return newRequestId();
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = newRequestId();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return newRequestId();
  }
}

function clearPendingTen() {
  const key = pendingTenKey();
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}

init();

async function init() {
  renderIdleReel();
  renderPrizeGallery();
  populateSeries();
  populateGallerySeries();
  bindEvents();
  topbar.setAccount(auth.get());
  renderBalance();
  await Promise.allSettled([loadMarket(), auth.get() ? loadPrivateData() : Promise.resolve()]);
  icons();
}

function bindEvents() {
  elements.tabs.forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  elements.openButton.addEventListener("click", openBox);
  elements.tenOpenButton.addEventListener("click", openTen);
  elements.skipButton.addEventListener("click", finishReelNow);
  document.querySelector("#showAllPrizes").addEventListener("click", () => elements.prizeDialog.showModal());
  document.querySelector("#refreshHistory").addEventListener("click", loadHistory);
  document.querySelector("#refreshInventory").addEventListener("click", loadInventory);
  document.querySelector("#refreshMarket").addEventListener("click", loadMarket);
  document.querySelector("#refreshGallery")?.addEventListener("click", loadGallery);
  elements.marketSeries.addEventListener("change", renderMarket);
  elements.gallerySeries?.addEventListener("change", renderGallery);
  document.querySelectorAll("[data-gallery-filter]").forEach(button =>
    button.addEventListener("click", () => {
      galleryFilter = button.dataset.galleryFilter;
      document.querySelectorAll("[data-gallery-filter]").forEach(entry =>
        entry.setAttribute("aria-pressed", String(entry === button)));
      renderGallery();
    }));
  document.querySelectorAll("[data-close-dialog]").forEach(button =>
    button.addEventListener("click", () => button.closest("dialog")?.close()));
  elements.inventory.addEventListener("click", handleInventoryAction);
  elements.market.addEventListener("click", handleMarketAction);
  elements.sellPrice.addEventListener("input", renderSellerReceives);
  elements.sellForm.addEventListener("submit", submitListing);
  elements.confirmBuy.addEventListener("click", confirmPurchase);
  window.addEventListener("tongzhuo:profile", () => {
    topbar.setAccount(auth.get());
    renderBalance();
  });
  window.addEventListener("tongzhuo:balance", renderBalance);
  window.addEventListener("tongzhuo:logout", () => {
    topbar.setAccount(null);
    inventory = [];
    renderBalance();
    renderInventory();
    renderHistory([]);
  });
}

function switchTab(tab) {
  elements.tabs.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tab === tab)));
  elements.panels.forEach(panel => { panel.hidden = panel.dataset.panel !== tab; });
  if (tab === "gallery") loadGallery();
  if (tab === "inventory") loadInventory();
  if (tab === "market") loadMarket();
  icons();
}

async function requireAuth() {
  if (auth.get()) return true;
  const ok = await auth.openAuthModal();
  if (!ok) return false;
  topbar.setAccount(auth.get());
  await refreshAccount();
  await loadPrivateData();
  return true;
}

async function loadPrivateData() {
  await Promise.allSettled([loadInventory(), loadHistory()]);
}

function renderBalance() {
  const account = auth.get();
  elements.balance.textContent = account ? `${money(account.balance)} 筹码` : "登录后开启";
}

async function refreshAccount() {
  const account = await auth.refreshBalance();
  topbar.setAccount(account);
  renderBalance();
  return account;
}

async function openBox() {
  if (phase !== "IDLE" || !(await requireAuth())) return;
  const account = auth.get();
  if (Number(account?.balance || 0) < BOX_PRICE) {
    showToast("筹码余额不足，当前无法开启宝箱", true);
    announce("筹码余额不足");
    return;
  }
  phase = "REQUESTING";
  setBusy(true);
  showOpeningStatus("正在确认结果", "服务器正在完成扣款和开奖", "loader-circle");
  const openId = pendingOpenId();
  try {
    const result = await auth.api("/api/treasure/open", {
      method: "POST",
      body: JSON.stringify({ openId }),
    });
    clearPendingOpen();
    applyResultBalance(result.balance);
    startReel(result);
  } catch (error) {
    if (Number(error?.status) > 0) clearPendingOpen();
    phase = "IDLE";
    setBusy(false);
    const message = Number(error?.status) === 0
      ? "网络中断，点击开启会恢复同一次结果，不会重复扣款"
      : error?.error || "开启失败，请稍后重试";
    showOpeningStatus("没有完成开启", message, "circle-alert", "loss");
    showToast(message, true);
    announce(message);
  }
}

async function openTen() {
  if (phase !== "IDLE" || !(await requireAuth())) return;
  const account = auth.get();
  if (Number(account?.balance || 0) < TEN_OPEN_PRICE) {
    showToast(`十连开启需要 ${money(TEN_OPEN_PRICE)} 筹码`, true);
    announce("筹码余额不足，无法十连开启");
    return;
  }
  phase = "REQUESTING";
  setBusy(true);
  showOpeningStatus("正在确认十连结果", "服务器正在一次性完成十次扣款和开奖", "loader-circle");
  const batchId = pendingTenId();
  try {
    const result = await auth.api("/api/treasure/open-ten", {
      method: "POST",
      body: JSON.stringify({ batchId }),
    });
    clearPendingTen();
    applyResultBalance(result.balance);
    const wins = (result.draws || []).filter(draw => draw.won && draw.avatar);
    startReel({
      ...result,
      isBatch: true,
      won: wins.length > 0,
      avatar: wins[0]?.avatar ?? null,
    });
  } catch (error) {
    if (Number(error?.status) > 0) clearPendingTen();
    phase = "IDLE";
    setBusy(false);
    const message = Number(error?.status) === 0
      ? "网络中断，点击十连开启会恢复同一批结果，不会重复扣款"
      : error?.error || "十连开启失败，请稍后重试";
    showOpeningStatus("没有完成十连开启", message, "circle-alert", "loss");
    showToast(message, true);
    announce(message);
  }
}

function applyResultBalance(balance) {
  const current = auth.get();
  if (!current) return;
  localStorage.setItem("tongzhuo-auth", JSON.stringify({ ...current, balance }));
  window.dispatchEvent(new CustomEvent("tongzhuo:balance"));
  topbar.setAccount(auth.get());
}

function startReel(result) {
  phase = "SPINNING";
  settlePending = result;
  buildReel(result.avatar);
  const target = elements.reelTrack.children[TARGET_INDEX];
  const offset = target.offsetLeft + target.offsetWidth / 2 - elements.reelWindow.clientWidth / 2;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reduced ? 80 : 5200;
  elements.reelTrack.style.transition = "none";
  elements.reelTrack.style.transform = "translate3d(0,0,0)";
  void elements.reelTrack.offsetWidth;
  elements.reelTrack.style.transition = `transform ${duration}ms cubic-bezier(0.08, 0.68, 0.12, 1)`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      elements.reelTrack.style.transform = `translate3d(${-offset}px,0,0)`;
    });
  });
  elements.skipButton.hidden = reduced;
  showOpeningStatus(result.isBatch ? "十连开启中" : "宝箱开启中",
    result.isBatch ? "指针停下后展示全部十次结果" : "指针停下后揭晓本次结果", "scan-line");
  announce(result.isBatch ? "头像宝箱十连开启中" : "头像宝箱正在开启");
  clearTimeout(animationTimer);
  animationTimer = setTimeout(completeOpen, duration + 80);
}

function finishReelNow() {
  if (phase !== "SPINNING" || !settlePending) return;
  clearTimeout(animationTimer);
  const target = elements.reelTrack.children[TARGET_INDEX];
  const offset = target.offsetLeft + target.offsetWidth / 2 - elements.reelWindow.clientWidth / 2;
  elements.reelTrack.style.transition = "transform 140ms ease-out";
  elements.reelTrack.style.transform = `translate3d(${-offset}px,0,0)`;
  animationTimer = setTimeout(completeOpen, 170);
}

async function completeOpen() {
  const result = settlePending;
  if (!result) return;
  settlePending = null;
  phase = "RESULT";
  elements.skipButton.hidden = true;
  if (result.isBatch) {
    const wins = (result.draws || []).filter(draw => draw.won && draw.avatar);
    showOpeningStatus(`十连开启 · 获得 ${wins.length} 个头像`,
      wins.length ? "奖品均已进入库存" : "本次十个宝箱均为空箱",
      wins.length ? "party-popper" : "package-x", wins.length ? "win" : "loss");
    if (wins.length) {
      elements.reelMachine.classList.add("is-winner");
      setTimeout(() => elements.reelMachine.classList.remove("is-winner"), 1500);
      showToast(`十连开启获得 ${wins.length} 个头像`);
    }
    renderBatchResult(result.draws || []);
    if (!elements.batchDialog.open) elements.batchDialog.showModal();
    announce(`十连开启完成，获得${wins.length}个头像`);
  } else if (result.won && result.avatar) {
    showOpeningStatus(`获得头像 · ${result.avatar.name}`, "已进入库存，可以立即佩戴或上架交易", "party-popper", "win");
    elements.reelMachine.classList.add("is-winner");
    setTimeout(() => elements.reelMachine.classList.remove("is-winner"), 1500);
    announce(`恭喜获得头像${result.avatar.name}`);
    showToast(`获得头像：${result.avatar.name}`);
  } else {
    showOpeningStatus("本次未获得头像", "空箱结果已经记录，祝你下次好运", "package-x", "loss");
    announce("本次未获得头像");
  }
  await Promise.allSettled([loadInventory(), loadHistory()]);
  setTimeout(() => {
    phase = "IDLE";
    setBusy(false);
  }, 260);
}

function setBusy(busy) {
  elements.openButton.disabled = busy;
  elements.openButton.setAttribute("aria-busy", String(busy));
  elements.tenOpenButton.disabled = busy;
  elements.tenOpenButton.setAttribute("aria-busy", String(busy));
}

function showOpeningStatus(title, detail, icon, state = "") {
  elements.openingResult.className = `opening-result${state ? ` is-${state}` : ""}`;
  elements.openingResult.innerHTML = `<div class="result-icon"><i data-lucide="${icon}"></i></div><div><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`;
  icons();
}

function renderIdleReel() {
  const cells = Array.from({ length: 12 }, (_, index) =>
    index % 4 === 1 ? prizeCard(catalog[(index * 7) % catalog.length]) : emptyCard());
  elements.reelTrack.replaceChildren(...cells);
  elements.reelTrack.style.transform = "translate3d(-72px,0,0)";
  icons();
}

function buildReel(finalAvatar) {
  const cells = [];
  for (let index = 0; index < REEL_LENGTH; index += 1) {
    let cell;
    if (index === TARGET_INDEX) cell = finalAvatar ? prizeCard(finalAvatar, true) : emptyCard(true);
    else cell = Math.random() < 0.1 ? prizeCard(catalog[Math.floor(Math.random() * catalog.length)]) : emptyCard();
    cells.push(cell);
  }
  elements.reelTrack.replaceChildren(...cells);
  icons();
}

function prizeCard(item, target = false) {
  const card = document.createElement("div");
  card.className = `reel-card${target ? " is-target" : ""}`;
  card.innerHTML = `<img src="${item.src}" alt="" draggable="false"><span>${esc(item.name)}</span>`;
  return card;
}

function emptyCard(target = false) {
  const card = document.createElement("div");
  card.className = `reel-card is-empty${target ? " is-target" : ""}`;
  card.innerHTML = `<i data-lucide="circle-dashed" aria-hidden="true"></i><span>空箱</span>`;
  return card;
}

function renderBatchResult(draws) {
  const wins = draws.filter(draw => draw.won && draw.avatar);
  elements.batchSummary.textContent = wins.length
    ? `获得 ${wins.length} 个头像，全部已经放入库存`
    : "十次结果均为空箱，本批结果已经记录";
  elements.batchResultGrid.innerHTML = draws.map(draw => draw.won && draw.avatar
    ? `<article class="batch-result is-win"><div class="batch-result-media"><img src="${draw.avatar.src}" alt=""></div><strong>${esc(draw.avatar.name)}</strong></article>`
    : '<article class="batch-result"><div class="batch-result-media"><i data-lucide="circle-dashed"></i></div><strong>未获得头像</strong></article>')
    .join("");
  icons();
}

async function loadHistory() {
  if (!auth.get()) {
    renderHistory([]);
    return;
  }
  try {
    const data = await auth.api("/api/me/treasure-history?limit=12");
    renderHistory(data.opens || []);
  } catch (error) {
    elements.history.innerHTML = `<p class="treasure-empty">${esc(error?.error || "记录加载失败")}</p>`;
  }
}

function renderHistory(opens = []) {
  if (!auth.get()) {
    elements.history.innerHTML = '<p class="treasure-empty">登录后查看开箱记录</p>';
  } else if (!opens.length) {
    elements.history.innerHTML = '<p class="treasure-empty">还没有开过宝箱，第一条记录会出现在这里</p>';
  } else {
    elements.history.innerHTML = opens.map(open => open.avatar
      ? `<article class="history-open"><img src="${open.avatar.src}" alt=""><strong>${esc(open.avatar.name)}</strong><span>${formatTime(open.time)}</span></article>`
      : `<article class="history-open is-empty"><div class="history-empty-mark"><i data-lucide="circle-dashed"></i></div><strong>未获得头像</strong><span>${formatTime(open.time)}</span></article>`)
      .join("");
  }
  icons();
}

async function loadInventory() {
  if (!auth.get()) {
    inventory = [];
    renderInventory();
    return;
  }
  try {
    const [data, showcaseData] = await Promise.all([
      auth.api("/api/me/avatar-inventory"),
      auth.api("/api/me/showcase").catch(() => null),
    ]);
    inventory = data.items || [];
    showcase = showcaseData?.items ?? [];
    renderInventory();
  } catch (error) {
    elements.inventory.innerHTML = `<p class="treasure-empty">${esc(error?.error || "库存加载失败")}</p>`;
  }
}

let showcase = [];
let showcaseEditing = false;

function renderShowcase() {
  if (!elements.showcaseStrip) return;
  const account = auth.get();
  if (!account) { elements.showcaseStrip.hidden = true; return; }
  const ownedKinds = [...new Set(inventory.map(item => item.avatar.id))];
  elements.showcaseStrip.hidden = false;
  const slots = Array.from({ length: 3 }, (_, index) => showcase[index] ?? null);
  elements.showcaseStrip.innerHTML = `
    <div class="showcase-head"><strong>收藏展柜</strong><span>挑 3 个头像展示给其他玩家</span>
      <button type="button" class="showcase-toggle" data-showcase-toggle>${showcaseEditing ? "完成" : "编辑展柜"}</button>
    </div>
    <div class="showcase-slots">
      ${slots.map((avatar, index) => avatar
        ? `<figure class="showcase-slot is-filled">
            <img src="${avatar.src}" alt="${esc(avatar.name)}">
            <figcaption>${esc(avatar.name)}</figcaption>
            ${showcaseEditing ? `<button type="button" class="showcase-remove" data-showcase-remove="${index}" aria-label="移除">×</button>` : ""}
          </figure>`
        : `<figure class="showcase-slot is-empty"><i data-lucide="image-plus"></i><figcaption>空位</figcaption></figure>`).join("")}
    </div>
    ${showcaseEditing
      ? `<div class="showcase-pick">
          <p>${ownedKinds.length ? "点击加入展柜：" : "先获得宝箱头像，再回来布置展柜"}</p>
          <div class="showcase-pick-row">
            ${ownedKinds
              .filter(avatarId => !showcase.some(item => item.id === avatarId) && showcase.length < 3)
              .map(avatarId => {
                const item = catalog.find(entry => entry.id === avatarId);
                return item ? `<button type="button" class="showcase-pick-button" data-showcase-add="${esc(avatarId)}"><img src="${item.src}" alt="${esc(item.name)}"><span>${esc(item.name)}</span></button>` : "";
              }).join("")}
          </div>
        </div>`
      : ""}`;
  elements.showcaseStrip.querySelector("[data-showcase-toggle]")?.addEventListener("click", async () => {
    if (showcaseEditing) {
      showcaseEditing = false;
      try {
        await auth.api("/api/me/showcase", { method: "POST", body: JSON.stringify({ avatarIds: showcase.map(item => item.id) }) });
        showToast("展柜已保存");
      } catch (error) {
        showToast(error?.error || "展柜保存失败", true);
      }
    } else {
      showcaseEditing = true;
    }
    renderShowcase();
  });
  elements.showcaseStrip.querySelectorAll("[data-showcase-add]").forEach(button =>
    button.addEventListener("click", () => {
      if (showcase.length >= 3) return;
      const item = catalog.find(entry => entry.id === button.dataset.showcaseAdd);
      if (!item) return;
      showcase = [...showcase, item];
      renderShowcase();
    }));
  elements.showcaseStrip.querySelectorAll("[data-showcase-remove]").forEach(button =>
    button.addEventListener("click", () => {
      showcase = showcase.filter((_, index) => index !== Number(button.dataset.showcaseRemove));
      renderShowcase();
    }));
  icons();
}

function renderInventory() {
  const account = auth.get();
  renderShowcase();
  elements.inventoryCount.hidden = !inventory.length;
  elements.inventoryCount.textContent = inventory.length;
  if (!account) {
    elements.inventory.innerHTML = '<p class="treasure-empty">登录后查看你的头像库存</p>';
  } else if (!inventory.length) {
    elements.inventory.innerHTML = '<p class="treasure-empty">库存还是空的<br>开箱获得头像，或者去交易行购买一份</p>';
  } else {
    elements.inventory.innerHTML = inventory.map(item => {
      const equipped = account.avatar === item.avatar.id;
      return `<article class="inventory-card">
        <div class="inventory-card-image"><img src="${item.avatar.src}" alt="${esc(item.avatar.name)}" draggable="false">
          ${item.listing ? '<span class="item-state is-listed">出售中</span>' : equipped ? '<span class="item-state is-equipped">使用中</span>' : ""}
        </div>
        <div class="inventory-card-body"><h2>${esc(item.avatar.name)}</h2><span class="item-series">${esc(item.avatar.series)}</span><span class="item-serial">物品 ${esc(item.id.slice(0, 8).toUpperCase())}</span>
          <div class="inventory-actions">
            ${item.listing
              ? `<button type="button" class="is-cancel" data-cancel="${item.listing.id}">下架 · ${money(item.listing.price)}</button>`
              : `<button type="button" class="is-primary" data-equip="${item.id}" ${equipped ? "disabled" : ""}>${equipped ? "正在使用" : "立即佩戴"}</button><button type="button" data-sell="${item.id}">出售</button>`}
          </div>
        </div>
      </article>`;
    }).join("");
  }
  icons();
}

async function handleInventoryAction(event) {
  const equip = event.target.closest("[data-equip]");
  const sell = event.target.closest("[data-sell]");
  const cancel = event.target.closest("[data-cancel]");
  if (equip) {
    const item = inventory.find(entry => entry.id === equip.dataset.equip);
    if (!item) return;
    equip.disabled = true;
    try {
      const result = await auth.api("/api/me/avatar", { method: "POST", body: JSON.stringify({ avatar: item.avatar.id }) });
      auth.applyAvatar(result);
      topbar.setAccount(auth.get());
      renderInventory();
      showToast(`已佩戴 ${item.avatar.name}`);
    } catch (error) {
      equip.disabled = false;
      showToast(error?.error || "头像没有更换成功", true);
    }
  }
  if (sell) openSellDialog(sell.dataset.sell);
  if (cancel) {
    cancel.disabled = true;
    try {
      await auth.api(`/api/avatar-market/listings/${encodeURIComponent(cancel.dataset.cancel)}`, { method: "DELETE" });
      showToast("商品已经下架");
      await Promise.all([loadInventory(), loadMarket()]);
    } catch (error) {
      cancel.disabled = false;
      showToast(error?.error || "下架失败", true);
    }
  }
}

function openSellDialog(itemId) {
  sellTarget = inventory.find(item => item.id === itemId && !item.listing) ?? null;
  if (!sellTarget) return;
  elements.sellItem.innerHTML = itemMarkup(sellTarget.avatar, `物品 ${sellTarget.id.slice(0, 8).toUpperCase()}`);
  elements.sellPrice.value = "100000";
  elements.sellError.hidden = true;
  renderSellerReceives();
  elements.sellDialog.showModal();
  elements.sellPrice.focus();
  icons();
}

function renderSellerReceives() {
  const price = Math.max(0, Math.trunc(Number(elements.sellPrice.value) || 0));
  elements.sellerReceives.textContent = `上架费 ${money(Math.max(1, Math.floor(price * 0.01)))} · 成交后到账 ${money(price - Math.floor(price * 0.09))}`;
}

async function submitListing(event) {
  event.preventDefault();
  if (!sellTarget) return;
  const price = Number(elements.sellPrice.value);
  const submit = elements.sellForm.querySelector('[type="submit"]');
  submit.disabled = true;
  elements.sellError.hidden = true;
  try {
    await auth.api("/api/avatar-market/listings", {
      method: "POST",
      body: JSON.stringify({ itemId: sellTarget.id, price }),
    });
    elements.sellDialog.close();
    showToast("头像已经上架");
    await Promise.all([loadInventory(), loadMarket()]);
  } catch (error) {
    elements.sellError.textContent = error?.error || "上架失败";
    elements.sellError.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

async function loadMarket() {
  try {
    const response = await fetch("/api/avatar-market/listings?limit=200");
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error);
    listings = data.listings || [];
    renderMarket();
  } catch {
    elements.market.innerHTML = '<p class="treasure-empty">交易行暂时无法加载，请稍后刷新</p>';
  }
}

function populateSeries() {
  const series = [...new Set(catalog.map(item => item.series))];
  elements.marketSeries.insertAdjacentHTML("beforeend", series.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join(""));
}

function populateGallerySeries() {
  if (!elements.gallerySeries) return;
  const series = [...new Set(catalog.map(item => item.series))];
  elements.gallerySeries.insertAdjacentHTML("beforeend", series.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join(""));
}

async function loadGallery() {
  if (!elements.galleryGrid) return;
  if (!auth.get()) {
    gallery = [];
    renderGallery();
    return;
  }
  try {
    const data = await auth.api("/api/me/avatar-gallery");
    gallery = data.entries || [];
    renderGallery();
  } catch (error) {
    elements.galleryGrid.innerHTML = `<p class="treasure-empty">${esc(error?.error || "图鉴加载失败")}</p>`;
  }
}

function renderGallery() {
  if (!elements.galleryGrid) return;
  const owned = gallery.filter(entry => entry.owned).length;
  if (!auth.get()) {
    elements.galleryProgress.innerHTML = '<p class="treasure-empty">登录后点亮你的头像图鉴</p>';
    elements.galleryGrid.innerHTML = "";
    return;
  }
  elements.galleryProgress.innerHTML = `
    <div class="gallery-progress-bar"><span style="width:${gallery.length ? Math.round(owned / gallery.length * 100) : 0}%"></span></div>
    <p>已点亮 <strong>${owned}</strong> / ${gallery.length} 款头像</p>`;
  const selectedSeries = elements.gallerySeries?.value ?? "";
  const visible = gallery.filter(entry =>
    (!selectedSeries || entry.avatar.series === selectedSeries)
    && (galleryFilter === "all" || (galleryFilter === "owned") === entry.owned));
  if (!visible.length) {
    elements.galleryGrid.innerHTML = '<p class="treasure-empty">这个筛选条件下还没有头像</p>';
    return;
  }
  elements.galleryGrid.innerHTML = visible.map(entry => `
    <article class="gallery-card${entry.owned ? "" : " is-missing"}">
      <div class="gallery-card-image">
        <img src="${entry.avatar.src}" alt="${esc(entry.avatar.name)}" draggable="false" ${entry.owned ? "" : 'class="is-silhouette"'}>
        ${entry.owned && entry.count > 1 ? `<span class="item-state is-equipped">×${entry.count}</span>` : ""}
      </div>
      <div class="gallery-card-body">
        <h2>${entry.owned ? esc(entry.avatar.name) : "？？？"}</h2>
        <span class="item-series">${esc(entry.avatar.series)}</span>
        <dl class="gallery-market">
          <div><dt>市场参考价</dt><dd>${entry.referencePrice ? money(entry.referencePrice) : "暂无成交"}</dd></div>
          <div><dt>在售</dt><dd>${entry.activeListings ? `${entry.activeListings} 件 · 最低 ${money(entry.lowestPrice)}` : "无"}</dd></div>
        </dl>
      </div>
    </article>`).join("");
}

function renderMarket() {
  const selectedSeries = elements.marketSeries.value;
  const visible = listings.filter(listing => !selectedSeries || listing.avatar.series === selectedSeries);
  elements.listingCount.hidden = !listings.length;
  elements.listingCount.textContent = listings.length;
  elements.marketSummary.innerHTML = `<span>在售头像<strong>${visible.length}</strong></span><span>最低价格<strong>${visible.length ? money(Math.min(...visible.map(item => item.price))) : "—"}</strong></span><span>成交手续费<strong>9%</strong></span>`;
  if (!visible.length) {
    elements.market.innerHTML = '<p class="treasure-empty">当前分类还没有玩家出售头像</p>';
    return;
  }
  elements.market.innerHTML = visible.map(listing => {
    const own = auth.get()?.accountId === listing.seller.id;
    const overpriced = listing.referencePrice && listing.price > listing.referencePrice * 2;
    return `<article class="market-card">
      <div class="market-card-image"><img src="${listing.avatar.src}" alt="${esc(listing.avatar.name)}" draggable="false"></div>
      <div class="market-card-body"><h2>${esc(listing.avatar.name)}</h2><span class="item-series">${esc(listing.avatar.series)}</span>
        <div class="market-card-price"><strong>${money(listing.price)}</strong><span>筹码</span></div>
        <p class="market-seller">卖家：${esc(listing.seller.name)}</p>
        ${listing.referencePrice ? `<p class="market-ref">7 天参考价 ${money(listing.referencePrice)}${overpriced ? '<em class="market-overpriced">高于参考价 2 倍以上</em>' : ""}</p>` : ""}
        <button type="button" class="market-buy" data-buy="${listing.id}" ${own ? "disabled" : ""}>${own ? "我的商品" : "购买头像"}</button>
      </div>
    </article>`;
  }).join("");
}

async function handleMarketAction(event) {
  const button = event.target.closest("[data-buy]");
  if (!button || !(await requireAuth())) return;
  buyTarget = listings.find(listing => listing.id === button.dataset.buy) ?? null;
  if (!buyTarget) return;
  elements.buyItem.innerHTML = itemMarkup(buyTarget.avatar, `卖家 ${buyTarget.seller.name} · ${money(buyTarget.price)} 筹码`);
  const warning = elements.buyDialog.querySelector(".buy-warning");
  const overpriced = buyTarget.referencePrice && buyTarget.price > buyTarget.referencePrice * 2;
  warning.textContent = overpriced
    ? `注意：该价格超过近 7 天参考价（${money(buyTarget.referencePrice)}）的 2 倍，请确认后再购买。购买后头像立即进入库存，交易无法撤销。`
    : "购买后头像立即进入库存，交易无法撤销。";
  elements.buyError.hidden = true;
  elements.confirmBuy.textContent = `支付 ${money(buyTarget.price)} 筹码`;
  elements.buyDialog.showModal();
  elements.confirmBuy.focus();
  icons();
}

async function confirmPurchase() {
  if (!buyTarget) return;
  elements.confirmBuy.disabled = true;
  elements.buyError.hidden = true;
  try {
    const result = await auth.api(`/api/avatar-market/listings/${encodeURIComponent(buyTarget.id)}/buy`, { method: "POST" });
    elements.buyDialog.close();
    showToast(`已经买入 ${result.avatar.name}`);
    await refreshAccount();
    await Promise.all([loadInventory(), loadMarket()]);
  } catch (error) {
    elements.buyError.textContent = error?.error || "购买失败";
    elements.buyError.hidden = false;
  } finally {
    elements.confirmBuy.disabled = false;
  }
}

function renderPrizeGallery() {
  elements.prizeGallery.innerHTML = catalog.map(item =>
    `<figure><img src="${item.src}" alt="${esc(item.name)}" loading="lazy"><figcaption title="${esc(item.name)}">${esc(item.name)}</figcaption></figure>`).join("");
}

function itemMarkup(avatar, detail) {
  return `<img src="${avatar.src}" alt=""><div><strong>${esc(avatar.name)}</strong><span>${esc(avatar.series)} · ${esc(detail)}</span></div>`;
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast${error ? " is-error" : ""}`;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3000);
}

function announce(message) {
  elements.live.textContent = "";
  requestAnimationFrame(() => { elements.live.textContent = message; });
}

function formatTime(value) {
  const date = new Date(Number(value) || 0);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function newRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
