"use strict";

// 同桌老虎机：红金复古街机风格沿用原型（D:/slot-machine），开奖改为服务端权威。
// 流程：按下开奖/拉杆 → 立即禁用按钮防连点 → 生成 spinId → POST /api/slot/spin
// → 用返回的三个符号驱动转轴动画（先知道结果再滚动到位）→ 刷新顶栏余额与历史。

const SYMBOLS = [
  { id: "seven", label: "幸运 7", image: "assets/seven.svg", weight: 6 },
  { id: "diamond", label: "钻石", image: "assets/diamond.svg", weight: 8 },
  { id: "bell", label: "金铃", image: "assets/bell.svg", weight: 12 },
  { id: "bar", label: "BAR", image: "assets/bar.svg", weight: 14 },
  { id: "cherry", label: "樱桃", image: "assets/cherry.svg", weight: 20 },
  { id: "lemon", label: "柠檬", image: "assets/lemon.svg", weight: 20 },
  { id: "clover", label: "四叶草", image: "assets/clover.svg", weight: 20 },
];
const VALID_BETS = [50, 100, 200, 500];
const MIN_CUSTOM_BET = 10;
const MAX_BET = 100000;
const STORAGE_KEY = "tongzhuo-slot-v1";
const HISTORY_LIMIT = 20;
const TOTAL_WEIGHT = SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);

const elements = {
  cabinet: document.querySelector("#machineCabinet"),
  reels: [...document.querySelectorAll(".reel-window")],
  statusKicker: document.querySelector("#statusKicker"),
  statusTitle: document.querySelector("#statusTitle"),
  statusDetail: document.querySelector("#statusDetail"),
  spinButton: document.querySelector("#spinButton"),
  spinButtonLabel: document.querySelector("#spinButtonLabel"),
  lever: document.querySelector("#lever"),
  soundToggle: document.querySelector("#soundToggle"),
  brokeHint: document.querySelector("#brokeHint"),
  historyList: document.querySelector("#historyList"),
  betButtons: [...document.querySelectorAll("[data-bet]")],
  customBet: document.querySelector("#customBet"),
  customBetApply: document.querySelector("#customBetApply"),
  liveRegion: document.querySelector("#liveRegion"),
  toast: document.querySelector("#toast"),
};

const auth = window.tongzhuoAuth;
let game = loadState();
let history = [];
let phase = "IDLE";
let audioContext = null;
let leverDrag = null;
let suppressLeverClick = false;
let toastTimer = null;

const topbar = window.createTopbar({
  mount: document.querySelector("#topbar-identity"),
  onRequireAuth: () => requireAuth(),
});

init();

async function init() {
  renderStaticReels(game.lastSymbols);
  renderBet();
  renderSoundToggle();
  renderHistory();
  bindEvents();
  topbar.setAccount(auth.get());
  if (auth.get()) await afterLogin();
}

async function requireAuth() {
  if (auth.get()) return true;
  const ok = await auth.openAuthModal();
  if (ok) await afterLogin();
  return ok;
}

// 登录后的统一入口：刷新余额（顶栏）+ 拉取"最近开奖"。
async function afterLogin() {
  try {
    const account = await auth.refreshBalance();
    if (account) topbar.setAccount(account);
    updateBrokeHint();
    await loadHistory();
  } catch { /* 顶栏保持现有快照，历史面板留空即可 */ }
}

function bindEvents() {
  elements.spinButton.addEventListener("click", () => startSpin("button"));

  elements.betButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (phase !== "IDLE") return;
      game.bet = Number(button.dataset.bet);
      saveState();
      renderBet();
      setStatus("下注已选", `${game.bet} 筹码 / 本局`, "下注");
      playTone(440, 0.045, "square", 0.025);
    });
  });

  elements.customBetApply.addEventListener("click", applyCustomBet);
  elements.customBet.addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyCustomBet();
  });

  elements.soundToggle.addEventListener("click", () => {
    game.soundEnabled = !game.soundEnabled;
    saveState();
    renderSoundToggle();
    if (game.soundEnabled) playTone(660, 0.07, "sine", 0.04);
  });

  elements.lever.addEventListener("pointerdown", beginLeverDrag);
  elements.lever.addEventListener("pointermove", moveLever);
  elements.lever.addEventListener("pointerup", endLeverDrag);
  elements.lever.addEventListener("pointercancel", cancelLeverDrag);
  elements.lever.addEventListener("lostpointercapture", cancelLeverDrag);
  elements.lever.addEventListener("click", () => {
    if (suppressLeverClick) {
      suppressLeverClick = false;
      return;
    }
    startSpin("lever");
  });

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || isInteractiveTarget(event.target)) return;
    event.preventDefault();
    startSpin("keyboard");
  });

  window.addEventListener("tongzhuo:logout", () => {
    topbar.setAccount(null);
    history = [];
    renderHistory();
    updateBrokeHint();
    setStatus("准备好了", "登录后即可开奖", "本局");
  });
  window.addEventListener("tongzhuo:balance", updateBrokeHint);
}

function beginLeverDrag(event) {
  if (phase !== "IDLE" || elements.lever.disabled) return;
  leverDrag = {
    pointerId: event.pointerId,
    startY: event.clientY,
    progress: 0,
    moved: false,
  };
  elements.lever.setPointerCapture(event.pointerId);
  elements.lever.classList.add("is-dragging");
}

function moveLever(event) {
  if (!leverDrag || event.pointerId !== leverDrag.pointerId) return;
  const distance = Math.max(0, event.clientY - leverDrag.startY);
  const travel = Math.max(70, elements.lever.clientHeight * 0.3);
  leverDrag.progress = clamp(distance / travel, 0, 1);
  leverDrag.moved ||= distance > 6;
  setLeverProgress(leverDrag.progress);
}

function endLeverDrag(event) {
  if (!leverDrag || event.pointerId !== leverDrag.pointerId) return;
  const { progress, moved } = leverDrag;
  suppressLeverClick = moved;
  if (moved) {
    setTimeout(() => {
      suppressLeverClick = false;
    }, 0);
  }
  releaseLeverCapture(event.pointerId);
  leverDrag = null;
  elements.lever.classList.remove("is-dragging");
  setLeverProgress(0);

  if (progress >= 0.72) {
    startSpin("drag");
  } else if (moved) {
    playTone(180, 0.05, "sine", 0.02);
  }
}

function cancelLeverDrag(event) {
  if (!leverDrag || (event.pointerId !== undefined && event.pointerId !== leverDrag.pointerId)) return;
  const pointerId = leverDrag.pointerId;
  leverDrag = null;
  elements.lever.classList.remove("is-dragging");
  setLeverProgress(0);
  releaseLeverCapture(pointerId);
}

function releaseLeverCapture(pointerId) {
  if (elements.lever.hasPointerCapture(pointerId)) {
    elements.lever.releasePointerCapture(pointerId);
  }
}

function setLeverProgress(progress) {
  const angle = -18 + progress * 68;
  elements.lever.style.setProperty("--lever-angle", `${angle}deg`);
}

async function startSpin(source) {
  if (phase !== "IDLE") return;
  if (!(await requireAuth())) return;
  // 本地快照只做友好预检，权威校验在服务端（余额以服务端为准）。
  const snapshot = auth.get();
  if (snapshot && Number(snapshot.balance || 0) < game.bet) {
    showBrokeHint();
    setStatus("筹码不足", "回门户领取每日补助", "余额");
    announce(`余额不足，当前余额 ${snapshot.balance}，下注额 ${game.bet}`);
    playTone(130, 0.16, "sawtooth", 0.035);
    return;
  }

  if (source !== "drag") animateLever();

  phase = "SPINNING";
  setBusy(true);
  setStatus("转轴旋转中", `已下注 ${game.bet} 筹码`, "开奖");
  announce("转轴开始旋转");
  playSpinStart();

  try {
    const result = await spinOnServer();
    // 拿到服务端结果后再开始滚动，逐轴停在返回的符号上。
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const durations = reducedMotion ? [100, 140, 180] : [1450, 1850, 2250];
    const reelJobs = elements.reels.map((reel, index) => {
      const finalSymbol = getSymbol(result.reels[index]) || SYMBOLS[0];
      spinReel(reel, finalSymbol, durations[index], index);
      return delay(durations[index]).then(() => playReelStop(index));
    });
    await Promise.all(reelJobs);
    phase = "SETTLING";
    settleSpin(result);
  } catch (error) {
    phase = "IDLE";
    setBusy(false);
    const message = error?.error || "开奖失败，请稍后重试";
    toast(message, true);
    if (/余额不足/.test(message)) showBrokeHint();
    setStatus("开奖失败", message, "错误");
    announce(message);
    playTone(130, 0.16, "sawtooth", 0.035);
  }
}

// spinId 每次按下生成：断网重试/重复点击同一局时服务端凭它幂等回放，不会重复扣钱。
// 注意不能用 crypto.randomUUID——它在非安全上下文（http + IP 访问）里不存在，
// 这里用 getRandomValues（所有上下文都可用）拼 UUID。
function newSpinId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function spinOnServer() {
  const spinId = newSpinId();
  return auth.api("/api/slot/spin", {
    method: "POST",
    body: JSON.stringify({ bet: game.bet, spinId }),
  });
}

function spinReel(reel, finalSymbol, duration, reelIndex) {
  const strip = reel.querySelector(".reel-strip");
  const height = reel.getBoundingClientRect().height;
  const totalCells = 20 + reelIndex * 4;
  const cells = [];
  strip.setAttribute("aria-hidden", "true");

  for (let index = 0; index < totalCells - 1; index += 1) {
    cells.push(createSymbolCell(drawSymbol(), height));
  }
  cells.push(createSymbolCell(finalSymbol, height));

  strip.style.transition = "none";
  strip.style.transform = "translate3d(0, 0, 0)";
  strip.replaceChildren(...cells);
  void strip.offsetHeight;
  strip.style.transition = `transform ${duration}ms cubic-bezier(0.12, 0.72, 0.16, 1)`;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      strip.style.transform = `translate3d(0, -${(totalCells - 1) * height}px, 0)`;
    });
  });
}

// 结算展示完全采用服务端返回值（reels/payout/net/outcome），客户端不做赔付判定。
function settleSpin(result) {
  renderStaticReels(result.reels);
  history.unshift({
    symbols: result.reels,
    payout: result.payout,
    bet: result.bet,
  });
  history = history.slice(0, HISTORY_LIMIT);
  renderHistory();

  const outcome = result.outcome || { multiplier: 0, title: "未中奖" };
  if (result.payout > 0) {
    elements.cabinet.classList.add("is-win");
    setTimeout(() => elements.cabinet.classList.remove("is-win"), 1900);
    setStatus(outcome.title, `获得 ${result.payout} 筹码 · ${outcome.multiplier} 倍`, "中奖");
    announce(`${result.reels.map((id) => getSymbol(id)?.label ?? id).join("、")}，${outcome.title}，获得 ${result.payout} 筹码`);
    playWinSound(outcome.multiplier);
  } else {
    setStatus("差一点", "本局未中奖，再试一次", "结果");
    announce(`${result.reels.map((id) => getSymbol(id)?.label ?? id).join("、")}，本局未中奖`);
    playTone(220, 0.13, "triangle", 0.035);
  }

  // 顶栏余额与总资产以服务端快照为准（payout 入账后刷新）。
  refreshAccount().finally(() => {
    phase = "RESULT";
    setTimeout(() => {
      phase = "IDLE";
      setBusy(false);
    }, 320);
  });
}

async function refreshAccount() {
  try {
    const account = await auth.refreshBalance();
    if (account) topbar.setAccount(account);
    window.dispatchEvent(new CustomEvent("tongzhuo:balance"));
  } catch { /* 余额展示稍后随下次操作恢复 */ }
  updateBrokeHint();
}

async function loadHistory() {
  try {
    const data = await auth.api(`/api/me/spins?limit=${HISTORY_LIMIT}`);
    history = (data.spins || []).map((spin) => ({
      symbols: spin.reels,
      payout: spin.payout,
      bet: spin.bet,
    }));
  } catch {
    history = [];
  }
  renderHistory();
}

function drawSymbol() {
  let cursor = secureRandomUnit() * TOTAL_WEIGHT;
  for (const symbol of SYMBOLS) {
    cursor -= symbol.weight;
    if (cursor < 0) return symbol;
  }
  return SYMBOLS[SYMBOLS.length - 1];
}

function secureRandomUnit() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 4294967296;
}

function renderStaticReels(ids) {
  const fallback = ["cherry", "seven", "lemon"];
  elements.reels.forEach((reel, index) => {
    const symbol = getSymbol(ids[index]) || getSymbol(fallback[index]);
    const strip = reel.querySelector(".reel-strip");
    const height = reel.getBoundingClientRect().height || 150;
    strip.style.transition = "none";
    strip.style.transform = "translate3d(0, 0, 0)";
    strip.replaceChildren(createSymbolCell(symbol, height));
    strip.removeAttribute("aria-hidden");
  });
}

function createSymbolCell(symbol, height) {
  const cell = document.createElement("div");
  const image = document.createElement("img");
  cell.className = "reel-cell";
  cell.style.height = `${height}px`;
  cell.setAttribute("role", "img");
  cell.setAttribute("aria-label", symbol.label);
  image.src = symbol.image;
  image.alt = "";
  image.draggable = false;
  cell.append(image);
  return cell;
}

function applyCustomBet() {
  if (phase !== "IDLE") return;
  const value = Number(elements.customBet.value);
  if (!Number.isSafeInteger(value) || value < MIN_CUSTOM_BET || value > MAX_BET) {
    toast(`自定义下注需在 ${MIN_CUSTOM_BET} - ${MAX_BET} 之间`, true);
    return;
  }
  game.bet = value;
  saveState();
  renderBet();
  setStatus("自定义下注", `${game.bet} 筹码 / 本局`, "下注");
  playTone(440, 0.045, "square", 0.025);
}

function renderBet() {
  elements.betButtons.forEach((button) => {
    const isActive = Number(button.dataset.bet) === game.bet;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  // 自定义金额不是档位时：输入框回填当前金额并高亮，档位按钮全部不选中。
  const isPreset = VALID_BETS.includes(game.bet);
  elements.customBet.value = isPreset ? "" : String(game.bet);
  elements.customBet.classList.toggle("is-active", !isPreset);
}

function renderSoundToggle() {
  elements.soundToggle.setAttribute("aria-pressed", String(game.soundEnabled));
  elements.soundToggle.setAttribute("aria-label", game.soundEnabled ? "关闭音效" : "开启音效");
}

function renderHistory() {
  if (!auth.get()) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "登录后开始记录";
    elements.historyList.replaceChildren(empty);
    return;
  }
  if (history.length === 0) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "等待第一局";
    elements.historyList.replaceChildren(empty);
    return;
  }

  const rows = history.map((item, index) => {
    const row = document.createElement("li");
    const number = document.createElement("span");
    const symbols = document.createElement("span");
    const result = document.createElement("span");
    row.className = "history-item";
    number.className = "history-number";
    number.textContent = String(index + 1).padStart(2, "0");
    symbols.className = "history-symbols";
    item.symbols.forEach((id) => {
      const symbol = getSymbol(id);
      if (!symbol) return;
      const image = document.createElement("img");
      image.src = symbol.image;
      image.alt = symbol.label;
      symbols.append(image);
    });
    result.className = `history-result${item.payout > 0 ? " is-positive" : ""}`;
    result.textContent = item.payout > 0 ? `+${item.payout}` : `-${item.bet}`;
    row.append(number, symbols, result);
    return row;
  });
  elements.historyList.replaceChildren(...rows);
}

function setBusy(isBusy) {
  elements.cabinet.classList.toggle("is-spinning", isBusy);
  elements.spinButton.disabled = isBusy;
  elements.lever.disabled = isBusy;
  elements.betButtons.forEach((button) => {
    button.disabled = isBusy;
  });
  elements.spinButtonLabel.textContent = isBusy ? "开奖中" : "开奖";
}

function setStatus(title, detail, kicker) {
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.statusKicker.textContent = kicker;
}

function showBrokeHint() {
  elements.brokeHint.hidden = false;
}

function updateBrokeHint() {
  const account = auth.get();
  elements.brokeHint.hidden = !(account && Number(account.balance || 0) < Math.min(...VALID_BETS));
}

function animateLever() {
  elements.lever.classList.remove("is-auto-pull");
  void elements.lever.offsetWidth;
  elements.lever.classList.add("is-auto-pull");
  setTimeout(() => elements.lever.classList.remove("is-auto-pull"), 600);
}

function toast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

function playTone(frequency, duration, type = "sine", volume = 0.03, startDelay = 0) {
  if (!game.soundEnabled) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const start = audioContext.currentTime + startDelay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  } catch {
    game.soundEnabled = false;
    renderSoundToggle();
  }
}

function playSpinStart() {
  playTone(170, 0.08, "square", 0.025);
  playTone(250, 0.08, "square", 0.025, 0.08);
  playTone(340, 0.1, "square", 0.025, 0.16);
}

function playReelStop(index) {
  playTone(360 + index * 90, 0.07, "triangle", 0.035);
}

function playWinSound(multiplier) {
  const notes = multiplier >= 15 ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 1047];
  notes.forEach((frequency, index) => {
    playTone(frequency, 0.16, "square", 0.025, index * 0.11);
  });
}

function loadState() {
  const fallback = { bet: 100, soundEnabled: true, lastSymbols: ["cherry", "seven", "lemon"] };
  const isValidBet = (value) =>
    VALID_BETS.includes(value) || (Number.isSafeInteger(value) && value >= MIN_CUSTOM_BET && value <= MAX_BET);
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored || typeof stored !== "object") return { ...fallback };
    const lastSymbols = Array.isArray(stored.lastSymbols) && stored.lastSymbols.length === 3
      ? stored.lastSymbols.filter((id) => Boolean(getSymbol(id)))
      : fallback.lastSymbols;
    const storedBet = Number(stored.bet);
    return {
      bet: isValidBet(storedBet) ? storedBet : fallback.bet,
      soundEnabled: typeof stored.soundEnabled === "boolean" ? stored.soundEnabled : true,
      lastSymbols: lastSymbols.length === 3 ? lastSymbols : fallback.lastSymbols,
    };
  } catch {
    return { ...fallback };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
  } catch {
    // The game remains playable when storage is disabled.
  }
}

function getSymbol(id) {
  return SYMBOLS.find((symbol) => symbol.id === id);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function announce(message) {
  elements.liveRegion.textContent = "";
  requestAnimationFrame(() => {
    elements.liveRegion.textContent = message;
  });
}

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest("button, input, select, textarea, a"));
}
