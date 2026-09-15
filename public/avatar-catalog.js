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
    ["prize-001", "阿狸", "01-ahri", "幻想"],
    ["prize-002", "红狼", "01-d-wolf", "战术"],
    ["prize-003", "捷风", "01-jett", "未来"],
    ["prize-004", "反恐精英干员", "01-urban-counter-terrorist", "战术"],
    ["prize-005", "露娜", "02-luna", "战术"],
    ["prize-006", "贤者", "02-sage", "未来"],
    ["prize-007", "SAS防毒面具干员", "02-sas-gas-mask", "战术"],
    ["prize-008", "希尔瓦娜斯", "02-sylvanas-windrunner", "幻想"],
    ["prize-009", "亚索", "02-yasuo", "幻想"],
    ["prize-010", "GIGN干员", "03-gign-operator", "战术"],
    ["prize-011", "伊利丹", "03-illidan-stormrage", "幻想"],
    ["prize-012", "金克丝", "03-jinx", "未来"],
    ["prize-013", "不死鸟", "03-phoenix", "未来"],
    ["prize-014", "蜂医", "03-stinger", "战术"],
    ["prize-015", "FBI特警干员", "04-fbi-swat", "战术"],
    ["prize-016", "骇爪", "04-hackclaw", "战术"],
    ["prize-017", "拉克丝", "04-lux", "幻想"],
    ["prize-018", "芮娜", "04-reyna", "未来"],
    ["prize-019", "幽影", "05-omen", "未来"],
    ["prize-020", "凤凰连接干员", "05-phoenix-connex", "战术"],
    ["prize-021", "牧羊人", "05-shepherd", "战术"],
    ["prize-022", "猎空", "05-tracer", "未来"],
    ["prize-023", "劫", "05-zed", "幻想"],
    ["prize-024", "巴尔干老兵", "06-balkan-veteran", "战术"],
    ["prize-025", "零", "06-cypher", "未来"],
    ["prize-026", "源氏", "06-genji", "未来"],
    ["prize-027", "李青", "06-lee-sin", "幻想"],
    ["prize-028", "乌鲁鲁", "06-uluru", "战术"],
    ["prize-029", "无政府街头战士", "07-anarchist-street-fighter", "战术"],
    ["prize-030", "厄运小姐", "07-miss-fortune", "幻想"],
    ["prize-031", "深蓝", "07-sineva", "战术"],
    ["prize-032", "蝰蛇", "07-viper", "未来"],
    ["prize-033", "精英特工", "08-elite-crew", "战术"],
    ["prize-034", "刀锋女王凯瑞甘", "08-kerrigan-queen-of-blades", "幻想"],
    ["prize-035", "奇乐", "08-killjoy", "未来"],
    ["prize-036", "提莫", "08-teemo", "幻想"],
    ["prize-037", "蛊", "08-toxik", "战术"],
    ["prize-038", "白猫筹码项圈", "A1-chip-collar-left", "萌猫"],
    ["prize-039", "黑猫筹码项圈", "A2-chip-collar-right", "萌猫"],
    ["prize-040", "白猫手牌", "B1-hole-cards-left", "萌猫"],
    ["prize-041", "黑猫手牌", "B2-hole-cards-right", "萌猫"],
    ["prize-042", "白猫庄家领结", "C1-dealer-bow-left", "萌猫"],
    ["prize-043", "金猫庄家领结", "C2-dealer-bow-right", "萌猫"],
    ["prize-044", "钟离", "genshin-01-zhongli", "幻想大陆"],
    ["prize-045", "雷电将军", "genshin-02-raiden-shogun", "幻想大陆"],
    ["prize-046", "纳西妲", "genshin-03-nahida", "幻想大陆"],
    ["prize-047", "芙宁娜", "genshin-04-furina", "幻想大陆"],
    ["prize-048", "胡桃", "genshin-05-hu-tao", "幻想大陆"],
    ["prize-049", "那维莱特", "genshin-06-neuvillette", "幻想大陆"],
    ["prize-050", "阿蕾奇诺", "genshin-07-arlecchino", "幻想大陆"],
    ["prize-051", "魈", "genshin-08-xiao", "幻想大陆"],
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
