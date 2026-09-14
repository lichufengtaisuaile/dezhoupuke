(() => {
  "use strict";
  window.tongzhuoAvatars = window.TONGZHUO_AVATARS;

  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  window.playerAvatarMarkup = function (player, own = false) {
    const source = window.tongzhuoAvatars.source(player.name, player.avatar);
    if (own) return `<span class="seat-avatar is-self" title="${esc(player.name)}"><img src="${source}" width="64" height="64" alt="" draggable="false" /></span>`;
    const title = `送花给 ${player.name}`;
    return `<button type="button" class="seat-avatar" data-interact-player="${esc(player.id)}" title="${esc(title)}" aria-label="${esc(title)}" aria-haspopup="dialog" aria-expanded="false"><img src="${source}" width="64" height="64" alt="" draggable="false" /></button>`;
  };
})();
