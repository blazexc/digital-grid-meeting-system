const crypto = require("crypto");

// BigBlueButton 的接口校验依赖 action + query + secret 的 SHA1 签名。
function buildApiUrl(action, params) {
  const endpoint = process.env.BBB_BASE_URL;
  const secret = process.env.BBB_SECRET;

  if (!endpoint || !secret) {
    throw new Error("缺少 BBB_BASE_URL 或 BBB_SECRET 环境变量。");
  }

  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    search.append(key, String(value));
  });

  const query = search.toString();
  const checksum = crypto
    .createHash("sha1")
    .update(`${action}${query}${secret}`)
    .digest("hex");

  return `${endpoint.replace(/\/$/, "")}/${action}?${query}&checksum=${checksum}`;
}

async function callApi(action, params) {
  const response = await fetch(buildApiUrl(action, params));
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`BBB API 请求失败: ${response.status}`);
  }

  return text;
}

// 这里用最轻量的方式从 XML 中提取字段，够覆盖当前门户需要的状态判断。
function xmlTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? match[1] : "";
}

// 门户不维护会议生命周期，而是在用户真正进入时幂等调用 create。
async function ensureMeeting(room) {
  return callApi("create", {
    name: room.name,
    meetingID: room.meetingId,
    attendeePW: room.attendeePassword,
    moderatorPW: room.moderatorPassword,
    record: room.record ? "true" : "false",
    muteOnStart: room.muteOnStart ? "true" : "false",
    welcome: room.welcomeMessage,
    dialNumber: room.dialNumber,
    autoStartRecording: room.record ? "true" : "false",
    allowStartStopRecording: "true"
  });
}

// 根据角色切换主持密码或分会场密码，并生成可直接跳转的 join URL。
async function createJoinUrl(room, fullName, role) {
  await ensureMeeting(room);
  const password = role === "moderator" ? room.moderatorPassword : room.attendeePassword;
  return buildApiUrl("join", {
    fullName,
    meetingID: room.meetingId,
    password,
    redirect: "true"
  });
}

// 当前版本只需要会议是否进行中，用 isMeetingRunning 足够轻量。
async function getMeetingStatus(room) {
  try {
    const xml = await callApi("isMeetingRunning", {
      meetingID: room.meetingId
    });

    return {
      running: xmlTag(xml, "running") === "true",
      raw: xml
    };
  } catch (error) {
    return {
      running: false,
      raw: error.message,
      error: true
    };
  }
}

module.exports = {
  createJoinUrl,
  ensureMeeting,
  getMeetingStatus
};
