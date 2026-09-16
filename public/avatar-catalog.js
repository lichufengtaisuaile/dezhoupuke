(() => {
  "use strict";
  const freeDefinitions = [
    ["01-corgi", "柯基"], ["02-lop-rabbit", "垂耳兔"], ["03-penguin", "企鹅"],
    ["04-elephant", "小象"], ["05-chipmunk", "松鼠"], ["06-red-panda", "小熊猫"],
    ["07-polar-bear", "北极熊"], ["08-koala", "考拉"], ["09-seal", "海豹"],
    ["10-orange-cat", "橘猫"], ["11-frog", "青蛙"], ["12-otter", "水獭"],
    ["13-piglet", "小猪"], ["14-owl", "猫头鹰"], ["15-hamster", "仓鼠"],
  ];
  const prizeDefinitions = [
    ["prize-001", "阿狸", "01-ahri", "英雄联盟"],
    ["prize-002", "红狼", "01-d-wolf", "三角洲行动"],
    ["prize-003", "捷风", "01-jett", "无畏契约"],
    ["prize-004", "反恐精英干员", "01-urban-counter-terrorist", "CSGO"],
    ["prize-005", "露娜", "02-luna", "三角洲行动"],
    ["prize-006", "贤者", "02-sage", "无畏契约"],
    ["prize-007", "SAS防毒面具干员", "02-sas-gas-mask", "CSGO"],
    ["prize-008", "希尔瓦娜斯", "02-sylvanas-windrunner", "魔兽世界"],
    ["prize-009", "亚索", "02-yasuo", "英雄联盟"],
    ["prize-010", "GIGN干员", "03-gign-operator", "CSGO"],
    ["prize-011", "伊利丹", "03-illidan-stormrage", "魔兽世界"],
    ["prize-012", "金克丝", "03-jinx", "英雄联盟"],
    ["prize-013", "不死鸟", "03-phoenix", "无畏契约"],
    ["prize-014", "蜂医", "03-stinger", "三角洲行动"],
    ["prize-015", "FBI特警干员", "04-fbi-swat", "CSGO"],
    ["prize-016", "骇爪", "04-hackclaw", "三角洲行动"],
    ["prize-017", "拉克丝", "04-lux", "英雄联盟"],
    ["prize-018", "芮娜", "04-reyna", "无畏契约"],
    ["prize-019", "幽影", "05-omen", "无畏契约"],
    ["prize-020", "凤凰连接干员", "05-phoenix-connex", "CSGO"],
    ["prize-021", "牧羊人", "05-shepherd", "三角洲行动"],
    ["prize-022", "猎空", "05-tracer", "守望先锋"],
    ["prize-023", "劫", "05-zed", "英雄联盟"],
    ["prize-024", "巴尔干老兵", "06-balkan-veteran", "CSGO"],
    ["prize-025", "零", "06-cypher", "无畏契约"],
    ["prize-026", "源氏", "06-genji", "守望先锋"],
    ["prize-027", "李青", "06-lee-sin", "英雄联盟"],
    ["prize-028", "乌鲁鲁", "06-uluru", "三角洲行动"],
    ["prize-029", "无政府街头战士", "07-anarchist-street-fighter", "CSGO"],
    ["prize-030", "厄运小姐", "07-miss-fortune", "英雄联盟"],
    ["prize-031", "深蓝", "07-sineva", "三角洲行动"],
    ["prize-032", "蝰蛇", "07-viper", "无畏契约"],
    ["prize-033", "精英特工", "08-elite-crew", "CSGO"],
    ["prize-034", "刀锋女王凯瑞甘", "08-kerrigan-queen-of-blades", "星际争霸"],
    ["prize-035", "奇乐", "08-killjoy", "无畏契约"],
    ["prize-036", "提莫", "08-teemo", "英雄联盟"],
    ["prize-037", "蛊", "08-toxik", "三角洲行动"],
    ["prize-038", "白猫筹码项圈", "A1-chip-collar-left", "同桌原创"],
    ["prize-039", "黑猫筹码项圈", "A2-chip-collar-right", "同桌原创"],
    ["prize-040", "白猫手牌", "B1-hole-cards-left", "同桌原创"],
    ["prize-041", "黑猫手牌", "B2-hole-cards-right", "同桌原创"],
    ["prize-042", "白猫庄家领结", "C1-dealer-bow-left", "同桌原创"],
    ["prize-043", "金猫庄家领结", "C2-dealer-bow-right", "同桌原创"],
    ["prize-044", "钟离", "genshin-01-zhongli", "原神"],
    ["prize-045", "雷电将军", "genshin-02-raiden-shogun", "原神"],
    ["prize-046", "纳西妲", "genshin-03-nahida", "原神"],
    ["prize-047", "芙宁娜", "genshin-04-furina", "原神"],
    ["prize-048", "胡桃", "genshin-05-hu-tao", "原神"],
    ["prize-049", "那维莱特", "genshin-06-neuvillette", "原神"],
    ["prize-050", "阿蕾奇诺", "genshin-07-arlecchino", "原神"],
    ["prize-051", "魈", "genshin-08-xiao", "原神"],
  ];
  const freeItems = Object.freeze(freeDefinitions.map(([id, name]) => Object.freeze({
    id, name, src: `/avatars/animals/${id}.png`, kind: "free",
  })));
  const prizeItems = Object.freeze(prizeDefinitions.map(([id, name, file, series]) => Object.freeze({
    id, name, series, src: `/avatars/prizes/${file}.webp`, kind: "prize",
  })));
  const items = Object.freeze([...freeItems, ...prizeItems]);
  const byId = new Map(items.map(item => [item.id, item]));
  function index(name) {
    const seed = String(name || "player");
    const hash = [...seed].reduce((value, character) => (Math.imul(value, 31) + character.codePointAt(0)) >>> 0, 0);
    return hash % freeItems.length;
  }
  function source(name, avatar) {
    return (byId.get(avatar) || freeItems[index(name)]).src;
  }
  globalThis.TONGZHUO_AVATARS = Object.freeze({
    items, freeItems, prizeItems, index, source,
    isValid: avatar => avatar === null || byId.has(avatar),
    isFree: avatar => avatar === null || freeItems.some(item => item.id === avatar),
    isPrize: avatar => prizeItems.some(item => item.id === avatar),
    get: avatar => byId.get(avatar) ?? null,
  });
})();
