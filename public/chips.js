(() => {
  "use strict";
  const denominations = [
    { value: 500, color: "gold" },
    { value: 100, color: "ink" },
    { value: 25, color: "teal" },
    { value: 5, color: "ruby" },
    { value: 1, color: "ivory" },
  ];
  const format = value => Math.round(value).toLocaleString("zh-CN");

  function chipTypes(amount) {
    let rest = Math.max(0, Math.floor(amount));
    const groups = denominations.map(type => {
      const count = Math.floor(rest / type.value);
      rest %= type.value;
      return { ...type, count };
    });
    // Break one large chip for a legible, mixed stack without scaling the DOM to the balance.
    for (let i = 0; i < groups.length - 1; i++) {
      if (groups[i].count && groups.filter(group => group.count).length < 3) {
        groups[i].count--;
        groups[i + 1].count += groups[i].value / groups[i + 1].value;
      }
    }
    return groups.filter(group => group.count);
  }

  function chipMarkup(type, column = 0, index = 0) {
    return `<i class="poker-chip chip-${type.color}" style="--chip-column:${column};--chip-index:${index}"><b class="chip-face">${type.value}</b></i>`;
  }

  window.chipPileMarkup = function (amount, kind) {
    const groups = chipTypes(amount).slice(0, 3);
    const chips = groups.map((type, column) => {
      const count = Math.min(kind === "pot" ? 6 : 4, type.count);
      return Array.from({ length: count }, (_, index) => chipMarkup(type, column, index)).join("");
    }).join("");
    return `<span class="chip-pile pile-${kind}" aria-hidden="true">${chips}</span>`;
  };

  window.createChipEffects = function (stage) {
    const layer = document.createElement("div");
    layer.className = "chips-layer";
    layer.setAttribute("aria-hidden", "true");
    stage.append(layer);
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const timers = new Set();
    const numbers = new Map();
    let handKey = "";
    let queueEnd = 0;
    let frame = 0;

    function later(callback, delay) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
    }

    function capture() {
      const rect = stage.getBoundingClientRect();
      return new Map([...stage.querySelectorAll("[data-chip-anchor]")].map(node => {
        const box = node.getBoundingClientRect();
        return [node.dataset.chipAnchor, {
          x: (box.left + box.width / 2 - rect.left) / rect.width,
          y: (box.top + box.height / 2 - rect.top) / rect.height,
        }];
      }));
    }

    function position(anchor, fallback) {
      const point = capture().get(anchor) || fallback;
      return point ? { x: point.x * stage.clientWidth, y: point.y * stage.clientHeight } : null;
    }

    function seat(id) {
      return [...stage.querySelectorAll("[data-player-id]")].find(node => node.dataset.playerId === id);
    }

    function accent(id, name) {
      seat(id)?.classList.add(name);
      later(() => seat(id)?.classList.remove(name), 1500);
    }

    function impact(point) {
      const node = document.createElement("i");
      node.className = "chip-impact";
      Object.assign(node.style, { left: `${point.x}px`, top: `${point.y}px` });
      layer.append(node);
      later(() => node.remove(), 450);
    }

    function fly(from, to, amount, oldPositions, payout = false) {
      const source = position(from, oldPositions.get(from));
      const target = position(to, oldPositions.get(to));
      if (!source || !target) return;
      const types = chipTypes(amount);
      const count = Math.min(9, Math.max(2, Math.ceil(Math.log2(amount + 1))));
      const duration = payout ? 620 : 410;
      for (let i = 0; i < count; i++) {
        const type = types[i % types.length];
        if (!type) continue;
        const node = document.createElement("span");
        node.className = "chip-flight";
        node.dataset.chipFlow = payout ? "payout" : to === "pot" ? "collect" : "bet";
        node.innerHTML = chipMarkup(type);
        const spread = (i % 3 - 1) * 7;
        Object.assign(node.style, { left: `${source.x - 11 + spread}px`, top: `${source.y - 11 - i * 1.4}px` });
        layer.append(node);
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        node.animate([
          { transform: "translate(0, 0) rotate(-12deg) scale(.8)", opacity: 0 },
          { transform: "translate(0, 0) rotate(-12deg) scale(.9)", opacity: 1, offset: .06 },
          { transform: `translate(${dx * .62}px, ${dy * .62 - 22}px) rotate(${i % 2 ? 70 : -65}deg) scale(1.12)`, opacity: 1, offset: .6 },
          { transform: `translate(${dx}px, ${dy}px) rotate(${i * 17}deg) scale(.9)`, opacity: 1, offset: .9 },
          { transform: `translate(${dx}px, ${dy}px) scale(.82)`, opacity: 0 },
        ], { duration, delay: i * 24, fill: "both", easing: "cubic-bezier(.2,.65,.3,1)" });
        later(() => node.remove(), duration + i * 24 + 20);
      }
      later(() => impact(target), duration);
    }

    function gain(id, amount) {
      const target = position(`bank:${id}`);
      if (!target) return;
      const node = document.createElement("span");
      node.className = "chip-gain";
      node.textContent = `+${format(amount)}`;
      Object.assign(node.style, { left: `${target.x}px`, top: `${target.y - 30}px` });
      layer.append(node);
      accent(id, "payout-active");
      later(() => node.remove(), 1500);
    }

    function numberValue(entry, now) {
      const progress = Math.min(1, Math.max(0, (now - entry.start) / 480));
      return entry.from + (entry.to - entry.from) * (1 - Math.pow(1 - progress, 3));
    }

    function tickNumbers() {
      frame = 0;
      const now = performance.now();
      const targets = new Map([...stage.querySelectorAll("[data-money-key]")].map(node => [node.dataset.moneyKey, node]));
      for (const [key, entry] of numbers) {
        const node = targets.get(key);
        if (!node) { numbers.delete(key); continue; }
        node.textContent = format(numberValue(entry, now));
        node.classList.toggle("changed", now >= entry.start);
        if (now >= entry.start + 480) {
          node.textContent = format(entry.to);
          node.classList.remove("changed");
          numbers.delete(node.dataset.moneyKey);
        }
      }
      if (numbers.size) frame = requestAnimationFrame(tickNumbers);
    }

    function roll(key, from, to, delay = 0) {
      if (from === to) return;
      const now = performance.now();
      const running = numbers.get(key);
      numbers.set(key, { from: running ? numberValue(running, now) : from, to, start: now + delay });
    }

    function cancel() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      layer.replaceChildren();
      cancelAnimationFrame(frame);
      frame = 0;
      for (const node of stage.querySelectorAll("[data-money-key]")) {
        const entry = numbers.get(node.dataset.moneyKey);
        if (entry) node.textContent = format(entry.to);
        node.classList.remove("changed");
      }
      numbers.clear();
      stage.querySelectorAll(".payout-active, .all-in-active").forEach(node => node.classList.remove("payout-active", "all-in-active"));
      queueEnd = 0;
    }

    function update(previous, next, oldPositions, animate = true, dealDelay = 0) {
      const key = next ? `${next.code}:${next.handNumber}` : "";
      const changedHand = key !== handKey;
      if (changedHand) { cancel(); handKey = key; }
      if (!next || !animate || reducedMotion.matches || document.hidden) { cancel(); return; }
      const plan = window.planChipEffects(previous, next);
      const now = performance.now();
      // Keep rapid actions close to live play so payouts finish before the next hand.
      const start = Math.max(0, Math.min(650, queueEnd - now));
      const collectDelay = start + (plan.bets.length ? 600 : 0);
      const payoutDelay = Math.max(collectDelay + (plan.collections.length ? 620 : 0), dealDelay + 100);
      for (const bet of plan.bets) later(() => {
        fly(`bank:${bet.id}`, `bet:${bet.id}`, bet.amount, oldPositions);
        if (bet.allIn) accent(bet.id, "all-in-active");
      }, start);
      for (const collection of plan.collections) later(() => {
        fly(`bet:${collection.id}`, "pot", collection.amount, oldPositions);
      }, collectDelay);
      for (const payout of plan.payouts) later(() => {
        fly("pot", `bank:${payout.id}`, payout.amount, oldPositions, true);
        later(() => gain(payout.id, payout.amount), 620);
      }, payoutDelay);
      if (plan.bets.length || plan.collections.length || plan.payouts.length)
        queueEnd = now + (plan.payouts.length ? payoutDelay + 850 : plan.collections.length ? collectDelay + 620 : start + 580);
      if (previous?.code === next.code) {
        roll("pot", changedHand ? 0 : previous.pot, next.pot, start);
        for (const player of next.players) {
          const old = previous.players.find(p => p.id === player.id);
          if (!old) continue;
          const award = plan.payouts.find(p => p.id === player.id);
          roll(`stack:${player.id}`, old.stack, player.stack, award ? payoutDelay + 480 : start);
          roll(`bet:${player.id}`, changedHand ? 0 : old.bet, player.bet);
        }
      }
      // Active numeric transitions bind to replacement nodes after every snapshot.
      if (frame) cancelAnimationFrame(frame);
      tickNumbers();
    }

    window.addEventListener("resize", cancel);
    reducedMotion.addEventListener("change", cancel);
    document.addEventListener("visibilitychange", cancel);
    return { capture, update, cancel };
  };
})();
