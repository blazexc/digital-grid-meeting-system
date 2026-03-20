const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dataDir = path.join(process.cwd(), "data");
const configPath = path.join(dataDir, "rooms.json");
const examplePath = path.join(dataDir, "rooms.example.json");

// 统一由 data 目录保存运行配置，方便在 Docker 挂载卷后长期保留房间信息。
function ensureDirectory() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultConfig() {
  const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  example.dailyPassword = "123456";
  example.updatedAt = new Date().toISOString();
  return example;
}

function ensureConfigFile() {
  ensureDirectory();

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(createDefaultConfig(), null, 2));
  }
}

// 这里集中补齐默认字段，确保无论是后台新增还是 JSON 导入都能收敛成统一结构。
function normalizeConfig(rawConfig) {
  const config = clone(rawConfig);
  config.siteName = config.siteName || process.env.SITE_NAME || "数字化网格管理会议系统";
  config.dailyPassword = String(config.dailyPassword || "123456");
  config.updatedAt = config.updatedAt || new Date().toISOString();
  config.wall = config.wall || {};
  config.wall.defaultSecondsPerTab = Number(config.wall.defaultSecondsPerTab || 20);
  config.groups = Array.isArray(config.groups) ? config.groups : [];
  config.rooms = Array.isArray(config.rooms) ? config.rooms : [];

  config.groups = config.groups
    .map((group, index) => ({
      slug: String(group.slug || `group-${index + 1}`),
      name: String(group.name || `第${index + 1}组`),
      order: Number(group.order || index + 1),
      wallSize: Number(group.wallSize || 4),
      description: String(group.description || "")
    }))
    .sort((left, right) => left.order - right.order);

  config.rooms = config.rooms
    .map((room, index) => ({
      slug: String(room.slug || `room-${index + 1}`),
      name: String(room.name || `第${index + 1}分会场`),
      meetingId: String(room.meetingId || room.slug || `room-${index + 1}`),
      groupSlug: String(room.groupSlug || config.groups[0]?.slug || ""),
      order: Number(room.order || index + 1),
      attendeePassword: String(room.attendeePassword || `attendee-${index + 1}`),
      moderatorPassword: String(room.moderatorPassword || `moderator-${index + 1}`),
      record: room.record !== false,
      muteOnStart: room.muteOnStart !== false,
      welcomeMessage: String(room.welcomeMessage || ""),
      dialNumber: String(room.dialNumber || "")
    }))
    .sort((left, right) => left.order - right.order);

  return config;
}

function loadConfig() {
  ensureConfigFile();
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return normalizeConfig(rawConfig);
}

// 每次保存都重新标准化并打时间戳，避免页面和磁盘状态不一致。
function saveConfig(nextConfig) {
  ensureConfigFile();
  const normalized = normalizeConfig({
    ...nextConfig,
    updatedAt: new Date().toISOString()
  });

  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

// 分组数量不写死，所以管理员可以通过后台持续追加新的分组。
function addGroup(groupInput) {
  const config = loadConfig();
  const group = {
    slug: String(groupInput.slug || slugify(groupInput.name || `group-${config.groups.length + 1}`)),
    name: String(groupInput.name || `第${config.groups.length + 1}组`),
    order: Number(groupInput.order || config.groups.length + 1),
    wallSize: Number(groupInput.wallSize || 4),
    description: String(groupInput.description || "")
  };

  config.groups.push(group);
  return saveConfig(config);
}

// 每个分会场都有独立的固定会议 ID、主持密码和分会场密码。
function addRoom(roomInput) {
  const config = loadConfig();
  const index = config.rooms.length + 1;
  const room = {
    slug: String(roomInput.slug || slugify(roomInput.name || `room-${index}`)),
    name: String(roomInput.name || `第${index}分会场`),
    meetingId: String(roomInput.meetingId || roomInput.slug || slugify(roomInput.name || `room-${index}`)),
    groupSlug: String(roomInput.groupSlug || config.groups[0]?.slug || ""),
    order: Number(roomInput.order || index),
    attendeePassword: String(roomInput.attendeePassword || randomPassword("att")),
    moderatorPassword: String(roomInput.moderatorPassword || randomPassword("mod")),
    record: roomInput.record !== false,
    muteOnStart: roomInput.muteOnStart !== false,
    welcomeMessage: String(roomInput.welcomeMessage || ""),
    dialNumber: String(roomInput.dialNumber || "")
  };

  config.rooms.push(room);
  return saveConfig(config);
}

function updateDailyPassword(dailyPassword) {
  const config = loadConfig();
  config.dailyPassword = String(dailyPassword || "");
  return saveConfig(config);
}

// 后台允许输入中文名称，这里会尽量转成适合放在 URL 里的 slug。
function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[\u4e00-\u9fa5]/g, "");
}

// 默认随机生成 BBB 房间口令，减少手工初始化工作量。
function randomPassword(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

module.exports = {
  addGroup,
  addRoom,
  ensureConfigFile,
  loadConfig,
  saveConfig,
  updateDailyPassword
};
