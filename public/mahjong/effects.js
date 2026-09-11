(() => {
  "use strict";
  const TILE = /^(?:[mps][1-9]|z0)$/;
  const seatNumber = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) < 4 ? Number(value) : -1;
  const roundId = (state) => state?.round?.id || state?.round?.roundId || null;
  const allPlayers = (state) => (state?.players || []).map((player) => ({ ...state.round?.players?.find((item) => Number(item.seat) === Number(player.seat)), ...player }));
  const ownSeat = (state) => seatNumber(allPlayers(state).find((player) => player.id === state?.selfId || player.accountId === state?.selfId)?.seat ?? state?.selfSeat ?? -1);
  const count = (player) => Number.isFinite(player?.handCount) ? player.handCount : player?.hand?.length || 0;

  // Only transitions between live snapshots produce effects; a restored snapshot is a baseline.
  function planMahjongEffects(previous, next) {
    if (!previous || !next || previous.code !== next.code || previous.selfId !== next.selfId) return [];
    const before = previous.round;
    const after = next.round;
    if (!after) return [];
    if (roundId(previous) !== roundId(next)) {
      return previous.phase !== "playing" && next.phase === "playing" && Number(after.turnId) === 1 ? [{ kind: "deal" }] : [];
    }
    if (!before || previous.phase !== "playing" || Number(after.turnId) <= Number(before.turnId)) return [];
    // If many turns arrived together, displaying the current table is clearer than replaying history.
    if (Number(after.turnId) - Number(before.turnId) > 8) return [];
    const result = [];
    const mine = ownSeat(next);
    const oldPlayers = allPlayers(previous);
    const newPlayers = allPlayers(next);
    const discard = after.lastDiscard;
    if (discard && discard.kind !== "robKong" && discard.id !== before.lastDiscard?.id && TILE.test(discard.tile) && seatNumber(discard.seat ?? discard.sourceSeat) >= 0) {
      result.push({ kind: "discard", seat: seatNumber(discard.seat ?? discard.sourceSeat), tile: discard.tile });
    }
    for (const player of newPlayers) {
      const old = oldPlayers.find((item) => Number(item.seat) === Number(player.seat));
      for (const meld of (player.melds || []).slice(old?.melds?.length || 0)) {
        if ((meld.kind || meld.type) === "peng") result.push({ kind: "callout", seat: seatNumber(player.seat), label: "碰", detail: "", particles: 0 });
      }
    }
    const seenEvents = new Set((before.events || []).map((event) => event.id));
    const events = (after.events || []).filter((event) => !seenEvents.has(event.id));
    if (events.length > 3) return [];
    const changes = new Map();
    for (const event of events) {
      if (event.kind === "hu") {
        const winners = (event.winners || []).filter((winner) => seatNumber(winner.seat) >= 0);
        const strongest = Math.max(1, ...winners.map((winner) => Number(winner.hand?.multiplier || winner.multiplier || 1)));
        const budget = strongest >= 16 ? 24 : strongest >= 8 ? 20 : 12;
        for (const winner of winners) {
          const multiplier = Math.min(16, Math.max(1, Number(winner.hand?.multiplier || winner.multiplier || 1)));
          result.push({ kind: "callout", seat: seatNumber(winner.seat), label: event.selfDraw ? "自摸" : "胡", detail: `${multiplier} 倍`, multiplier, particles: Math.floor(budget / Math.max(1, winners.length)) });
        }
      } else if (event.kind === "gang") {
        result.push({ kind: "callout", seat: seatNumber(event.seat), label: "杠", detail: event.gangKind === "concealedGang" ? "暗杠" : event.gangKind === "addedGang" ? "补杠" : "明杠", particles: 0 });
      }
      for (const change of event.changes || []) {
        const seat = seatNumber(change.seat);
        const delta = Number(change.delta);
        if (seat >= 0 && Number.isFinite(delta) && delta) changes.set(seat, (changes.get(seat) || 0) + delta);
      }
    }
    for (const [seat, delta] of changes) if (delta) result.push({ kind: "chips", seat, delta });
    const wallBefore = Number(before.wallCount ?? before.remainingTiles);
    const wallAfter = Number(after.wallCount ?? after.remainingTiles);
    const drawnSeat = seatNumber(after.turnSeat);
    if (next.phase === "playing" && wallAfter < wallBefore && drawnSeat >= 0) {
      const player = newPlayers.find((item) => Number(item.seat) === drawnSeat);
      if (count(player)) result.push({ kind: "draw", seat: drawnSeat, tile: drawnSeat === mine && TILE.test(after.drawnTile) ? after.drawnTile : null, delay: result.some((item) => item.kind === "discard") ? 160 : 0 });
    }
    if (next.phase === "finished" && previous.phase !== "finished") result.push({ kind: "result" });
    return result;
  }

  function createMahjongEffects({ root, table, hand, tileMarkup }) {
    const doc = root?.ownerDocument || (typeof document === "object" ? document : null);
    const win = doc?.defaultView || (typeof window === "object" ? window : null);
    let previous = null;
    let destroyed = false;
    let layer = null;
    const active = new Set();
    const observedRounds = new Set();
    const media = win?.matchMedia?.("(prefers-reduced-motion: reduce)");
    const permitted = () => !destroyed && doc && !doc.hidden && media && !media.matches && typeof root?.animate === "function";
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box && box.width > 0 && box.height > 0 ? { x: box.left, y: box.top, width: box.width, height: box.height, cx: box.left + box.width / 2, cy: box.top + box.height / 2 } : null;
    };
    const seatNode = (seat) => root.querySelector(`[data-player-seat="${seat}"]`);
    const center = () => rect(table);
    function capture() {
      if (!permitted()) return null;
      const seats = {};
      for (let seat = 0; seat < 4; seat++) {
        const node = seatNode(seat);
        seats[seat] = rect(node?.querySelector(".mj-hidden-hand")) || rect(node?.querySelector(".mj-player-avatar")) || rect(node);
      }
      return { seats, hand: Array.from(hand?.querySelectorAll("[data-hand-index]") || [], (node) => ({ tile: node.dataset.tile, selected: node.classList.contains("is-selected"), rect: rect(node) })) };
    }
    function overlay() {
      if (!layer) {
        layer = doc.createElement("div");
        layer.className = "mj-fx-layer";
        layer.setAttribute("aria-hidden", "true");
        layer.setAttribute("inert", "");
        doc.body.appendChild(layer);
      }
      return layer;
    }
    function transient(className) {
      const node = doc.createElement("div");
      node.className = className;
      overlay().appendChild(node);
      return node;
    }
    function play(node, keyframes, options, temporary = false) {
      if (!node || !permitted() || typeof node.animate !== "function") { if (temporary) node?.remove(); return; }
      let animation;
      try { animation = node.animate(keyframes, { easing: "cubic-bezier(.2,.75,.25,1)", fill: "backwards", ...options }); }
      catch { if (temporary) node.remove(); return; }
      const entry = { animation, node, temporary, timer: null };
      const clean = () => {
        if (!active.delete(entry)) return;
        win.clearTimeout(entry.timer);
        if (temporary) node.remove();
      };
      active.add(entry);
      animation.onfinish = clean;
      animation.oncancel = clean;
      entry.timer = win.setTimeout(() => { animation.cancel(); clean(); }, Number(options.duration || 0) + Number(options.delay || 0) + 150);
    }
    function clearMotion() {
      for (const entry of [...active]) {
        win.clearTimeout(entry.timer);
        entry.animation.cancel();
        if (entry.temporary) entry.node.remove();
        active.delete(entry);
      }
      layer?.replaceChildren();
    }
    function reset() { clearMotion(); previous = null; observedRounds.clear(); }
    function locationForSeat(seat) {
      const bounds = center();
      const node = seatNode(seat);
      const anchor = rect(node?.querySelector(".mj-player-avatar")) || rect(node);
      if (!bounds || !anchor) return null;
      const mine = seat === ownSeat(previous);
      const dx = bounds.cx - anchor.cx;
      const dy = bounds.cy - anchor.cy;
      const distance = Math.max(1, Math.hypot(dx, dy));
      return {
        x: Math.min(bounds.x + bounds.width - 34, Math.max(bounds.x + 34, anchor.cx + dx / distance * 43)),
        y: mine ? bounds.y + bounds.height - 36 : Math.min(bounds.y + bounds.height - 34, Math.max(bounds.y + 36, anchor.cy + dy / distance * 40))
      };
    }
    function deal() {
      const tiles = Array.from(hand.querySelectorAll("[data-hand-index]"));
      tiles.forEach((node, index) => play(node, [
        { opacity: 0, transform: `translate(${(tiles.length / 2 - index) * 9}px, -28px) rotate(${(index - tiles.length / 2) * .8}deg) scale(.88)` },
        { opacity: 1, transform: "translate(0, 0) rotate(0) scale(1)" }
      ], { duration: 360, delay: index * 23 }));
      root.querySelectorAll(".mj-hidden-hand").forEach((row, rowIndex) => Array.from(row.children).forEach((node, index) => play(node, [
        { opacity: 0, transform: "translateY(-12px) scale(.8)" }, { opacity: 1, transform: "translateY(0) scale(1)" }
      ], { duration: 260, delay: 60 + rowIndex * 25 + index * 15 })));
    }
    function draw(command) {
      const mine = command.seat === ownSeat(previous);
      const node = mine ? hand.querySelector(".is-drawn") || Array.from(hand.querySelectorAll("[data-tile]")).findLast((tile) => tile.dataset.tile === command.tile) : seatNode(command.seat)?.querySelector(".mj-hidden-hand .mj-tile-back:last-child");
      play(node, [
        { opacity: .12, transform: `translate(${mine ? 24 : 8}px, ${mine ? -13 : -9}px) rotate(4deg) scale(.92)` },
        { opacity: 1, transform: "translate(0, 0) rotate(0) scale(1)" }
      ], { duration: 240, delay: command.delay });
    }
    function discard(command, captured) {
      const river = root.querySelector(`[data-river-seat="${command.seat}"]`);
      const target = Array.from(river?.querySelectorAll("[data-tile]") || []).findLast((node) => node.dataset.tile === command.tile) || root.querySelector("#mj-last-discard .mj-tile");
      const to = rect(target);
      const mine = command.seat === ownSeat(previous);
      const matching = mine ? captured?.hand?.filter((item) => item.tile === command.tile && item.rect) : [];
      const from = matching?.find((item) => item.selected)?.rect || matching?.at(-1)?.rect || captured?.seats?.[command.seat];
      if (!from || !to || !TILE.test(command.tile)) return;
      const ghost = transient("mj-fx-tile-flight");
      ghost.innerHTML = tileMarkup(command.tile);
      const width = 44;
      const height = 60;
      const startScale = mine ? Math.min(1.15, from.width / width) : .7;
      const finishScale = to.width / width;
      const x = from.cx - width * startScale / 2;
      const y = from.cy - height * startScale / 2;
      play(ghost, [
        { opacity: .92, transform: `translate(${x}px, ${y}px) rotate(${mine ? -5 : 7}deg) scale(${startScale})`, offset: 0 },
        { opacity: 1, transform: `translate(${(x + to.x) / 2}px, ${(y + to.y) / 2 - 18}px) rotate(0deg) scale(${(startScale + finishScale) / 2})`, offset: .52 },
        { opacity: .95, transform: `translate(${to.x}px, ${to.y}px) rotate(0deg) scale(${finishScale})`, offset: .92 },
        { opacity: 0, transform: `translate(${to.x}px, ${to.y}px) rotate(0deg) scale(${finishScale})`, offset: 1 }
      ], { duration: 300 }, true);
      play(target, [{ filter: "brightness(1.4)" }, { filter: "brightness(1)" }], { duration: 220, delay: 260 });
    }
    function callout(command) {
      const point = locationForSeat(command.seat);
      if (!point) return;
      const winner = command.particles > 0;
      const strong = command.multiplier >= 8;
      const node = transient(`mj-fx-callout${winner ? " is-hu" : ""}${strong ? " is-grand" : ""}`);
      node.style.left = `${point.x}px`;
      node.style.top = `${point.y}px`;
      const glyph = doc.createElement("strong");
      glyph.textContent = command.label;
      node.appendChild(glyph);
      if (command.detail) {
        const detail = doc.createElement("small");
        detail.textContent = command.detail;
        node.appendChild(detail);
      }
      play(node, [
        { opacity: 0, transform: "translate(-50%, -42%) scale(.64)", offset: 0 },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1.06)", offset: .18 },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: .68 },
        { opacity: 0, transform: "translate(-50%, -66%) scale(.96)", offset: 1 }
      ], { duration: winner ? 1250 : 850 }, true);
      if (!winner) return;
      const ring = transient(`mj-fx-ring${strong ? " is-grand" : ""}`);
      ring.style.left = `${point.x}px`;
      ring.style.top = `${point.y}px`;
      play(ring, [
        { opacity: .9, transform: "translate(-50%, -50%) scale(.35)" },
        { opacity: 0, transform: `translate(-50%, -50%) scale(${strong ? 1.8 : 1.3})` }
      ], { duration: strong ? 1050 : 850 }, true);
      for (let index = 0; index < command.particles; index++) {
        const angle = Math.PI * 2 * index / command.particles - .2;
        const radius = (strong ? 64 : 43) + (index % 3) * 10;
        const particle = transient(`mj-fx-spark${index % 3 === 0 ? " is-dot" : ""}`);
        particle.style.left = `${point.x}px`;
        particle.style.top = `${point.y}px`;
        play(particle, [
          { opacity: 0, transform: "translate(0, 0) rotate(45deg) scale(.3)", offset: 0 },
          { opacity: 1, offset: .16 },
          { opacity: 0, transform: `translate(${Math.cos(angle) * radius}px, ${Math.sin(angle) * radius + 15}px) rotate(160deg) scale(.25)`, offset: 1 }
        ], { duration: 650 + (index % 4) * 55, delay: 55 }, true);
      }
    }
    function chips(command) {
      const target = root.querySelector(`[data-chip-seat="${command.seat}"]`);
      const box = rect(target);
      if (!box) return;
      const node = transient(`mj-fx-chips${command.delta < 0 ? " is-loss" : ""}`);
      node.textContent = `${command.delta > 0 ? "+" : "−"}${Math.abs(command.delta).toLocaleString("zh-CN")}`;
      node.style.left = `${box.cx}px`;
      node.style.top = `${box.y - 4}px`;
      play(node, [
        { opacity: 0, transform: "translate(-50%, 0) scale(.85)", offset: 0 },
        { opacity: 1, transform: "translate(-50%, -10px) scale(1)", offset: .16 },
        { opacity: 1, transform: "translate(-50%, -17px) scale(1)", offset: .65 },
        { opacity: 0, transform: "translate(-50%, -33px) scale(.97)", offset: 1 }
      ], { duration: 1100, delay: 100 }, true);
      play(target, [{ color: command.delta > 0 ? "#fff2ad" : "#ffb7a4", textShadow: "0 0 13px currentColor" }, { textShadow: "0 0 0 transparent" }], { duration: 700 });
    }
    function update(next, captured) {
      if (previous?.code === next?.code && previous?.selfId === next?.selfId) {
        if (roundId(previous) === roundId(next) && Number(next?.round?.turnId) < Number(previous?.round?.turnId)) return;
        if (roundId(previous) !== roundId(next) && observedRounds.has(roundId(next))) return;
      }
      const commands = planMahjongEffects(previous, next);
      const changedRound = roundId(previous) !== roundId(next);
      previous = next;
      if (roundId(next)) observedRounds.add(roundId(next));
      if (observedRounds.size > 24) observedRounds.delete(observedRounds.values().next().value);
      if (changedRound) clearMotion();
      if (!permitted() || !captured || root.hidden) return;
      for (const command of commands) {
        if (command.kind === "deal") deal();
        else if (command.kind === "discard") discard(command, captured);
        else if (command.kind === "draw") draw(command);
        else if (command.kind === "callout") callout(command);
        else if (command.kind === "chips") chips(command);
        else if (command.kind === "result") play(root.querySelector("#mj-round-result"), [{ opacity: 0, marginTop: "12px" }, { opacity: 1, marginTop: "0px" }], { duration: 300 });
      }
    }
    function destroy() {
      reset();
      destroyed = true;
      doc?.removeEventListener("visibilitychange", reset);
      win?.removeEventListener("resize", reset);
      win?.removeEventListener("pagehide", reset);
      if (media?.removeEventListener) media.removeEventListener("change", reset);
      else media?.removeListener?.(reset);
      layer?.remove();
      layer = null;
    }
    doc?.addEventListener("visibilitychange", reset);
    win?.addEventListener("resize", reset);
    win?.addEventListener("pagehide", reset);
    if (media?.addEventListener) media.addEventListener("change", reset);
    else media?.addListener?.(reset);
    return { capture, update, reset, destroy };
  }

  if (typeof window === "object") window.createMahjongEffects = createMahjongEffects;
  if (typeof module === "object" && module.exports) module.exports = { createMahjongEffects, planMahjongEffects };
})();
