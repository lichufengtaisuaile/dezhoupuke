(() => {
  "use strict";

  const styles = new Map([
    ["\u987a\u5b50", { level: 1, colors: ["#eed68b", "#83dbc2", "#fff3c6"] }],
    ["\u540c\u82b1", { level: 2, colors: ["#ff9bae", "#f4d08b", "#ffe4df"] }],
    ["\u846b\u82a6", { level: 3, colors: ["#edbc63", "#ef879c", "#89dccb"] }],
    ["\u56db\u6761", { level: 4, label: "\u56db\u6761\u00b7\u70b8\u5f39", colors: ["#ff8490", "#f4cb70", "#fff3d3"] }],
    ["\u540c\u82b1\u987a", { level: 5, colors: ["#80e6ce", "#f4cf78", "#fff6e0", "#ff91a7"] }],
    ["\u7687\u5bb6\u540c\u82b1\u987a", { level: 6, colors: ["#ffe19a", "#fff9e5", "#f998b7", "#88e5c9"] }],
  ]);
  const handKey = state => state?.code && state.handNumber ? `${state.code}:${state.handNumber}` : "";

  function publicWinner(state) {
    if (state?.phase !== "finished") return null;
    let best = null;
    for (const winner of state.result || []) {
      const style = styles.get(winner.hand?.name);
      if (winner.revealed !== true || !winner.hand?.complete || !style) continue;
      if (!best || style.level > best.style.level) best = { winner, style };
    }
    return best;
  }

  window.createHandCelebration = function (stage) {
    const layer = document.createElement("div");
    layer.className = "hand-celebration";
    layer.setAttribute("aria-hidden", "true");
    stage.append(layer);
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const shown = new Set();
    const animations = new Set();
    let currentKey = "";
    let startTimer = 0;
    let endTimer = 0;

    function cancel() {
      clearTimeout(startTimer);
      clearTimeout(endTimer);
      startTimer = endTimer = 0;
      for (const animation of animations) animation.cancel();
      animations.clear();
      layer.replaceChildren();
      layer.removeAttribute("data-celebration");
    }

    function animate(node, frames, options) {
      if (typeof node.animate === "function") animations.add(node.animate(frames, options));
    }

    function play({ winner, style }) {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (!width || !height) return;
      layer.dataset.celebration = winner.hand.name;
      layer.style.setProperty("--celebration-accent", style.colors[0]);
      const banner = document.createElement("strong");
      banner.className = "celebration-banner";
      banner.textContent = style.label || winner.hand.name;
      if (height >= 290) layer.append(banner);
      animate(banner, [
        { opacity: 0, transform: "translateY(-4px)" },
        { opacity: 1, transform: "translateY(0)", offset: .12 },
        { opacity: 1, transform: "translateY(0)", offset: .82 },
        { opacity: 0, transform: "translateY(-2px)" },
      ], { duration: 2600, fill: "both", easing: "ease-out" });

      const compact = width < 700;
      const count = compact ? 16 + style.level * 4 : 24 + style.level * 10;
      const reach = Math.min(compact ? 30 : 66, width * (compact ? .045 : .055));
      const rise = Math.min(compact ? 98 : 156, height * .28);
      // Keep the two showers inside the outer strips, away from the board and hole cards.
      for (let i = 0; i < count; i++) {
        const side = i % 2;
        const direction = side ? -1 : 1;
        const wave = i % 4 < 2 ? 0 : 1;
        const node = document.createElement("i");
        node.className = `celebration-particle${i % 5 === 0 ? " celebration-star" : ""}`;
        const x = width * (side ? .975 : .025);
        const y = height * (wave ? .85 : .58);
        const dx = direction * reach * (.24 + Math.random() * .76);
        const dy = rise * (.48 + Math.random() * .52);
        const rotation = Math.round(Math.random() * 160 - 80);
        Object.assign(node.style, {
          left: `${x}px`, top: `${y}px`,
          backgroundColor: style.colors[i % style.colors.length],
        });
        layer.append(node);
        animate(node, [
          { opacity: 0, transform: `translate(0, 0) rotate(${rotation}deg) scale(.5)` },
          { opacity: .9, transform: `translate(${dx * .32}px, ${-dy * .48}px) rotate(${rotation + 50}deg) scale(1)`, offset: .18 },
          { opacity: .85, transform: `translate(${dx * .8}px, ${-dy}px) rotate(${rotation + 130}deg) scale(1)`, offset: .58 },
          { opacity: 0, transform: `translate(${dx}px, ${-dy * .4}px) rotate(${rotation + 225}deg) scale(.7)` },
        ], {
          duration: 1750 + Math.random() * 340,
          delay: wave * 290 + Math.random() * 160,
          fill: "both", easing: "cubic-bezier(.2,.6,.3,1)",
        });
      }
      endTimer = setTimeout(cancel, 2700);
    }

    function update(previous, next, shouldAnimate = true, delay = 0) {
      const key = handKey(next);
      if (key !== currentKey) {
        cancel();
        currentKey = key;
      }
      if (!key || next.phase !== "finished") { cancel(); return; }
      const candidate = publicWinner(next);
      const silent = !shouldAnimate || !previous || handKey(previous) !== key || document.hidden || reducedMotion.matches;
      if (silent) {
        cancel();
        if (candidate) shown.add(key);
        return;
      }
      if (!candidate || shown.has(key)) return;
      // Consume the event when queued so state broadcasts cannot repeat or postpone it.
      shown.add(key);
      if (publicWinner(previous)) return;
      startTimer = setTimeout(() => {
        startTimer = 0;
        if (currentKey === key && !document.hidden && !reducedMotion.matches) play(candidate);
      }, Math.max(0, Number.isFinite(delay) ? delay : 0));
    }

    document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
    reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) cancel(); });
    window.addEventListener("resize", cancel);
    return { update, cancel };
  };
})();
