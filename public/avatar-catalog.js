(() => {
  "use strict";
  const definitions = [
    ["01-corgi", "柯基"], ["02-lop-rabbit", "垂耳兔"], ["03-penguin", "企鹅"],
    ["04-elephant", "小象"], ["05-chipmunk", "松鼠"], ["06-red-panda", "小熊猫"],
    ["07-polar-bear", "北极熊"], ["08-koala", "考拉"], ["09-seal", "海豹"],
    ["10-orange-cat", "橘猫"], ["11-frog", "青蛙"], ["12-otter", "水獭"],
    ["13-piglet", "小猪"], ["14-owl", "猫头鹰"], ["15-hamster", "仓鼠"],
  ];
  const items = Object.freeze(definitions.map(([id, name]) => Object.freeze({
    id, name, src: `/avatars/animals/${id}.png`,
  })));
  const byId = new Map(items.map(item => [item.id, item]));
  function index(name) {
    const seed = String(name || "player");
    const hash = [...seed].reduce((value, character) => (Math.imul(value, 31) + character.codePointAt(0)) >>> 0, 0);
    return hash % items.length;
  }
  function source(name, avatar) {
    return (byId.get(avatar) || items[index(name)]).src;
  }
  globalThis.TONGZHUO_AVATARS = Object.freeze({
    items, index, source, isValid: avatar => avatar === null || byId.has(avatar),
  });
})();
