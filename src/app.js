const express = require("express");
const path = require("path");
const session = require("express-session");
const QRCode = require("qrcode");

const { createJoinUrl, getMeetingStatus } = require("./bbb-api");
const {
  addGroup,
  addRoom,
  ensureConfigFile,
  loadConfig,
  saveConfig,
  updateDailyPassword
} = require("./config-store");

ensureConfigFile();

const app = express();
const port = Number(process.env.PORT || 18080);

// 门户只处理固定房间入口、角色跳转和后台配置，不承载媒体流。
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "grid-meeting-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax"
    }
  })
);
app.use("/assets", express.static(path.join(process.cwd(), "src", "public")));

// 每个请求都读取最新配置，这样管理员调整房间后无需重启服务。
app.use((request, response, next) => {
  response.locals.config = loadConfig();
  response.locals.siteName = response.locals.config.siteName;
  response.locals.baseUrl = process.env.PORTAL_BASE_URL || `http://127.0.0.1:${port}`;
  next();
});

app.get("/healthz", (request, response) => {
  response.json({ ok: true, time: new Date().toISOString() });
});

// 首页聚合系统所有主要入口，方便主会场快速进入对应控制页。
app.get("/", async (request, response) => {
  const config = response.locals.config;
  const roomCount = config.rooms.length;
  const groupCount = config.groups.length;

  response.send(
    renderPage({
      title: "系统首页",
      body: `
        <section class="hero">
          <div>
            <div class="eyebrow">BigBlueButton 固定房间总控门户</div>
            <h1>${escapeHtml(config.siteName)}</h1>
            <p>当前系统已接入 ${roomCount} 个分会场、${groupCount} 个分组。支持固定房间、统一每日密码、分组主持入口、总主持人入口，以及适配 Edge + Revolver Tabs 的轮播监看模式。</p>
            <div class="button-row">
              <a class="button primary" href="/master">总主持人入口</a>
              <a class="button" href="/admin">系统管理</a>
            </div>
          </div>
          <div class="panel">
            <h2>分组主持入口</h2>
            <div class="grid cards">
              ${config.groups
                .map(
                  (group) => `
                    <a class="card" href="/group/${encodeURIComponent(group.slug)}">
                      <strong>${escapeHtml(group.name)}</strong>
                      <span>${escapeHtml(group.description || "进入本组分会场监看与主持入口")}</span>
                    </a>
                  `
                )
                .join("")}
            </div>
          </div>
        </section>
        <section class="panel">
          <h2>快速入会入口</h2>
          <div class="grid cards">
            ${config.rooms
              .map(
                (room) => `
                  <a class="card" href="/join/${encodeURIComponent(room.slug)}">
                    <strong>${escapeHtml(room.name)}</strong>
                    <span>分组：${escapeHtml(findGroupName(config, room.groupSlug))}</span>
                  </a>
                `
              )
              .join("")}
          </div>
        </section>
      `
    })
  );
});

app.get("/join/:slug", (request, response) => {
  const room = findRoomOr404(response.locals.config, request.params.slug, response);

  if (!room) {
    return;
  }

  response.send(renderJoinPage(response.locals, room, "attendee", null));
});

app.post("/join/:slug", async (request, response) => {
  const room = findRoomOr404(response.locals.config, request.params.slug, response);

  if (!room) {
    return;
  }

  const validation = validateJoinForm(response.locals.config, request.body);

  if (validation.error) {
    response.send(renderJoinPage(response.locals, room, "attendee", validation.error));
    return;
  }

  const joinUrl = await createJoinUrl(room, validation.fullName, "attendee");
  response.redirect(joinUrl);
});

app.get("/moderator/:slug", (request, response) => {
  const room = findRoomOr404(response.locals.config, request.params.slug, response);

  if (!room) {
    return;
  }

  response.send(renderJoinPage(response.locals, room, "moderator", null));
});

app.post("/moderator/:slug", async (request, response) => {
  const room = findRoomOr404(response.locals.config, request.params.slug, response);

  if (!room) {
    return;
  }

  const validation = validateJoinForm(response.locals.config, request.body);

  if (validation.error) {
    response.send(renderJoinPage(response.locals, room, "moderator", validation.error));
    return;
  }

  const joinUrl = await createJoinUrl(room, validation.fullName, "moderator");
  response.redirect(joinUrl);
});

app.get("/group/:slug", async (request, response) => {
  const group = findGroupOr404(response.locals.config, request.params.slug, response);

  if (!group) {
    return;
  }

  const authorized = request.session.groupAccess?.[group.slug];

  if (!authorized) {
    response.send(renderGroupLoginPage(response.locals, group, null));
    return;
  }

  const rooms = response.locals.config.rooms.filter((room) => room.groupSlug === group.slug);
  const statuses = await Promise.all(
    rooms.map(async (room) => ({
      room,
      status: await getMeetingStatus(room)
    }))
  );

  response.send(renderGroupConsolePage(response.locals, group, rooms, statuses));
});

app.post("/group/:slug/login", (request, response) => {
  const group = findGroupOr404(response.locals.config, request.params.slug, response);

  if (!group) {
    return;
  }

  const validation = validateControllerLogin(response.locals.config, request.body);

  if (validation.error) {
    response.send(renderGroupLoginPage(response.locals, group, validation.error));
    return;
  }

  request.session.groupAccess = request.session.groupAccess || {};
  request.session.groupAccess[group.slug] = {
    displayName: validation.fullName,
    at: new Date().toISOString()
  };
  response.redirect(`/group/${encodeURIComponent(group.slug)}`);
});

app.get("/master", async (request, response) => {
  if (!request.session.masterAccess) {
    response.send(renderMasterLoginPage(response.locals, null));
    return;
  }

  const config = response.locals.config;
  const groupedRooms = config.groups.map((group) => ({
    group,
    rooms: config.rooms.filter((room) => room.groupSlug === group.slug)
  }));

  response.send(renderMasterConsolePage(response.locals, groupedRooms));
});

app.post("/master/login", (request, response) => {
  const validation = validateControllerLogin(response.locals.config, request.body);

  if (validation.error) {
    response.send(renderMasterLoginPage(response.locals, validation.error));
    return;
  }

  request.session.masterAccess = {
    displayName: validation.fullName,
    at: new Date().toISOString()
  };
  response.redirect("/master");
});

app.get("/admin", (request, response) => {
  if (!request.session.adminAccess) {
    response.send(renderAdminLoginPage(response.locals, null));
    return;
  }

  response.send(renderAdminPage(response.locals, null));
});

app.post("/admin/login", (request, response) => {
  const password = String(request.body.adminPassword || "");

  if (password !== String(process.env.ADMIN_PASSWORD || "admin123456")) {
    response.send(renderAdminLoginPage(response.locals, "管理口令不正确。"));
    return;
  }

  request.session.adminAccess = true;
  response.redirect("/admin");
});

app.post("/admin/daily-password", (request, response) => {
  if (!ensureAdminSession(request, response)) {
    return;
  }
  const nextPassword = String(request.body.dailyPassword || "").trim();

  if (!nextPassword) {
    response.send(renderAdminPage(response.locals, "每日统一密码不能为空。"));
    return;
  }

  updateDailyPassword(nextPassword);
  response.redirect("/admin");
});

app.post("/admin/groups", (request, response) => {
  if (!ensureAdminSession(request, response)) {
    return;
  }

  addGroup({
    name: request.body.name,
    slug: request.body.slug,
    order: request.body.order,
    wallSize: request.body.wallSize,
    description: request.body.description
  });

  response.redirect("/admin");
});

app.post("/admin/rooms", (request, response) => {
  if (!ensureAdminSession(request, response)) {
    return;
  }

  addRoom({
    name: request.body.name,
    slug: request.body.slug,
    meetingId: request.body.meetingId,
    groupSlug: request.body.groupSlug,
    order: request.body.order,
    attendeePassword: request.body.attendeePassword,
    moderatorPassword: request.body.moderatorPassword,
    welcomeMessage: request.body.welcomeMessage,
    record: request.body.record === "on",
    muteOnStart: request.body.muteOnStart === "on"
  });

  response.redirect("/admin");
});

app.get("/admin/export", (request, response) => {
  if (!ensureAdminSession(request, response)) {
    return;
  }
  response.type("application/json").send(JSON.stringify(loadConfig(), null, 2));
});

app.post("/admin/import", (request, response) => {
  if (!ensureAdminSession(request, response)) {
    return;
  }

  try {
    const nextConfig = JSON.parse(String(request.body.rawConfig || "{}"));
    saveConfig(nextConfig);
    response.redirect("/admin");
  } catch (error) {
    response.send(renderAdminPage(response.locals, `配置导入失败：${escapeHtml(error.message)}`));
  }
});

app.get("/admin/qrcodes", async (request, response) => {
  if (!ensureAdminSession(request, response)) {
    return;
  }
  const config = loadConfig();
  const baseUrl = response.locals.baseUrl;

  const items = await Promise.all(
    config.rooms.map(async (room) => ({
      room,
      attendeeCode: await QRCode.toDataURL(`${baseUrl}/join/${room.slug}`),
      moderatorCode: await QRCode.toDataURL(`${baseUrl}/moderator/${room.slug}`)
    }))
  );

  response.send(renderQrPage(response.locals, items));
});

app.use((error, request, response, next) => {
  console.error(error);
  response.status(500).send(
    renderPage({
      title: "系统错误",
      body: `
        <section class="panel">
          <h1>系统执行失败</h1>
          <p>${escapeHtml(error.message || "未知错误")}</p>
        </section>
      `
    })
  );
});

app.listen(port, () => {
  console.log(`grid-meeting-portal listening on ${port}`);
});

function ensureAdminSession(request, response) {
  if (!request.session.adminAccess) {
    response.redirect("/admin");
    return false;
  }

  return true;
}

function validateJoinForm(config, body) {
  const fullName = String(body.fullName || "").trim();
  const dailyPassword = String(body.dailyPassword || "").trim();

  if (!fullName) {
    return { error: "请输入姓名或会场名称。" };
  }

  if (dailyPassword !== config.dailyPassword) {
    return { error: "统一入会密码不正确。" };
  }

  return { fullName };
}

function validateControllerLogin(config, body) {
  const fullName = String(body.fullName || "").trim();
  const dailyPassword = String(body.dailyPassword || "").trim();

  if (!fullName) {
    return { error: "请输入主持人显示名称。" };
  }

  if (dailyPassword !== config.dailyPassword) {
    return { error: "统一入会密码不正确。" };
  }

  return { fullName };
}

function findRoomOr404(config, slug, response) {
  const room = config.rooms.find((item) => item.slug === slug);

  if (!room) {
    response.status(404).send(
      renderPage({
        title: "分会场不存在",
        body: `<section class="panel"><h1>未找到分会场</h1><p>请检查链接是否正确。</p></section>`
      })
    );
    return null;
  }

  return room;
}

function findGroupOr404(config, slug, response) {
  const group = config.groups.find((item) => item.slug === slug);

  if (!group) {
    response.status(404).send(
      renderPage({
        title: "分组不存在",
        body: `<section class="panel"><h1>未找到分组</h1><p>请检查链接是否正确。</p></section>`
      })
    );
    return null;
  }

  return group;
}

function renderJoinPage(locals, room, role, errorText) {
  const roleName = role === "moderator" ? "主持人入口" : "分会场入口";

  return renderPage({
    title: `${room.name} - ${roleName}`,
    body: `
      <section class="panel narrow">
        <div class="eyebrow">${escapeHtml(findGroupName(locals.config, room.groupSlug))}</div>
        <h1>${escapeHtml(room.name)} ${roleName}</h1>
        <p>通过固定链接进入本房间。请输入姓名和当天统一密码，系统会自动创建或唤起对应的 BigBlueButton 会议室。</p>
        ${renderError(errorText)}
        <form method="post" class="form">
          <label>姓名或会场名称<input name="fullName" placeholder="例如：第一分会场" required /></label>
          <label>统一入会密码<input name="dailyPassword" type="password" placeholder="请输入当天密码" required /></label>
          <button class="button primary" type="submit">进入 ${roleName}</button>
        </form>
      </section>
    `
  });
}

function renderGroupLoginPage(locals, group, errorText) {
  return renderPage({
    title: `${group.name} 主持入口`,
    body: `
      <section class="panel narrow">
        <div class="eyebrow">分组主持入口</div>
        <h1>${escapeHtml(group.name)}</h1>
        <p>登录后可查看本组分会场状态、打开多个主持标签页，并使用 Edge + Revolver Tabs 做轮播监看。</p>
        ${renderError(errorText)}
        <form method="post" action="/group/${encodeURIComponent(group.slug)}/login" class="form">
          <label>主持人名称<input name="fullName" placeholder="例如：第一组主持人" required /></label>
          <label>统一入会密码<input name="dailyPassword" type="password" required /></label>
          <button class="button primary" type="submit">进入本组控制台</button>
        </form>
      </section>
    `
  });
}

function renderMasterLoginPage(locals, errorText) {
  return renderPage({
    title: "总主持人入口",
    body: `
      <section class="panel narrow">
        <div class="eyebrow">总主持人总控台</div>
        <h1>总主持人入口</h1>
        <p>登录后可查看全部分组与全部分会场，并快速进入任意主持入口。</p>
        ${renderError(errorText)}
        <form method="post" action="/master/login" class="form">
          <label>总主持人名称<input name="fullName" placeholder="例如：总主持人" required /></label>
          <label>统一入会密码<input name="dailyPassword" type="password" required /></label>
          <button class="button primary" type="submit">进入总控台</button>
        </form>
      </section>
    `
  });
}

function renderGroupConsolePage(locals, group, rooms, statuses) {
  const launchLinks = rooms.map((room) => `${locals.baseUrl}/moderator/${room.slug}`);

  return renderPage({
    title: `${group.name} 控制台`,
    body: `
      <section class="panel">
        <div class="eyebrow">${escapeHtml(locals.config.siteName)}</div>
        <h1>${escapeHtml(group.name)} 控制台</h1>
        <p>本组建议同时监看 ${group.wallSize} 个分会场。下面的入口会始终指向固定房间，方便主持人用 Edge 打开多个标签页，再交给 Revolver Tabs 自动轮播。</p>
        <div class="button-row">
          <button class="button primary" type="button" onclick="openBatch(${escapeAttribute(JSON.stringify(launchLinks))})">一键打开本组主持标签页</button>
          <a class="button" href="/">返回首页</a>
        </div>
      </section>
      <section class="panel">
        <h2>轮播建议</h2>
        <ul class="list">
          <li>浏览器固定使用 Edge。</li>
          <li>安装 Revolver Tabs 插件后，将切页间隔设置为 ${locals.config.wall.defaultSecondsPerTab} 秒。</li>
          <li>如果当前大屏同时显示 2 至 8 个窗口，可只打开需要监看的分会场标签页。</li>
        </ul>
      </section>
      <section class="grid cards">
        ${statuses
          .map(
            ({ room, status }) => `
              <article class="card card-room">
                <div class="room-top">
                  <strong>${escapeHtml(room.name)}</strong>
                  <span class="status ${status.running ? "online" : "offline"}">${status.running ? "会议进行中" : "尚未开始"}</span>
                </div>
                <span>固定会议 ID：${escapeHtml(room.meetingId)}</span>
                <span>默认录制：${room.record ? "开启" : "关闭"}</span>
                <div class="button-row">
                  <a class="button primary" href="/moderator/${encodeURIComponent(room.slug)}" target="_blank" rel="noreferrer">主持进入</a>
                  <a class="button" href="/join/${encodeURIComponent(room.slug)}" target="_blank" rel="noreferrer">分会场入口</a>
                </div>
              </article>
            `
          )
          .join("")}
      </section>
    `
  });
}

function renderMasterConsolePage(locals, groupedRooms) {
  const launchLinks = groupedRooms.flatMap((item) => item.rooms.map((room) => `${locals.baseUrl}/moderator/${room.slug}`));

  return renderPage({
    title: "总主持人总控台",
    body: `
      <section class="panel">
        <div class="eyebrow">总主持人总控台</div>
        <h1>全部分会场</h1>
        <p>这里按分组展示所有固定房间。总主持人可从此页面快速进入任意分会场主持入口，也可批量打开标签页并交由 Edge + Revolver Tabs 做轮播。</p>
        <div class="button-row">
          <button class="button primary" type="button" onclick="openBatch(${escapeAttribute(JSON.stringify(launchLinks))})">打开全部主持标签页</button>
          <a class="button" href="/">返回首页</a>
        </div>
      </section>
      ${groupedRooms
        .map(
          ({ group, rooms }) => `
            <section class="panel">
              <h2>${escapeHtml(group.name)}</h2>
              <p>${escapeHtml(group.description || "本组暂无附加说明。")}</p>
              <div class="grid cards">
                ${rooms
                  .map(
                    (room) => `
                      <article class="card">
                        <strong>${escapeHtml(room.name)}</strong>
                        <span>会议 ID：${escapeHtml(room.meetingId)}</span>
                        <div class="button-row">
                          <a class="button primary" href="/moderator/${encodeURIComponent(room.slug)}" target="_blank" rel="noreferrer">主持进入</a>
                          <a class="button" href="/join/${encodeURIComponent(room.slug)}" target="_blank" rel="noreferrer">分会场入口</a>
                        </div>
                      </article>
                    `
                  )
                  .join("")}
              </div>
            </section>
          `
        )
        .join("")}
    `
  });
}

function renderAdminLoginPage(locals, errorText) {
  return renderPage({
    title: "系统管理登录",
    body: `
      <section class="panel narrow">
        <div class="eyebrow">系统管理</div>
        <h1>管理员登录</h1>
        <p>此入口用于维护每日统一密码、分组配置、房间配置和二维码导出。</p>
        ${renderError(errorText)}
        <form method="post" action="/admin/login" class="form">
          <label>管理员口令<input name="adminPassword" type="password" required /></label>
          <button class="button primary" type="submit">进入管理台</button>
        </form>
      </section>
    `
  });
}

function renderAdminPage(locals, errorText) {
  const config = loadConfig();

  return renderPage({
    title: "系统管理",
    body: `
      <section class="panel">
        <div class="eyebrow">系统管理</div>
        <h1>房间与分组配置</h1>
        <p>当前共有 ${config.groups.length} 个分组、${config.rooms.length} 个分会场。房间数量不写死，可持续增加。</p>
        ${renderError(errorText)}
        <div class="button-row">
          <a class="button" href="/admin/export" target="_blank" rel="noreferrer">导出 JSON 配置</a>
          <a class="button" href="/admin/qrcodes" target="_blank" rel="noreferrer">查看二维码页</a>
        </div>
      </section>
      <section class="grid admin-grid">
        <form method="post" action="/admin/daily-password" class="panel form">
          <h2>每日统一密码</h2>
          <label>当前密码<input name="dailyPassword" value="${escapeAttribute(config.dailyPassword)}" required /></label>
          <button class="button primary" type="submit">保存密码</button>
        </form>
        <form method="post" action="/admin/groups" class="panel form">
          <h2>新增分组</h2>
          <label>分组名称<input name="name" placeholder="例如：第二组" required /></label>
          <label>分组标识<input name="slug" placeholder="例如：group-b" /></label>
          <label>排序<input name="order" type="number" value="${config.groups.length + 1}" /></label>
          <label>建议墙数<input name="wallSize" type="number" min="2" max="8" value="4" /></label>
          <label>说明<input name="description" placeholder="例如：东区分组" /></label>
          <button class="button primary" type="submit">新增分组</button>
        </form>
        <form method="post" action="/admin/rooms" class="panel form">
          <h2>新增分会场</h2>
          <label>房间名称<input name="name" placeholder="例如：第三分会场" required /></label>
          <label>房间标识<input name="slug" placeholder="例如：fenhuichang-03" /></label>
          <label>会议 ID<input name="meetingId" placeholder="例如：fenhuichang-03" /></label>
          <label>所属分组
            <select name="groupSlug">
              ${config.groups.map((group) => `<option value="${escapeAttribute(group.slug)}">${escapeHtml(group.name)}</option>`).join("")}
            </select>
          </label>
          <label>排序<input name="order" type="number" value="${config.rooms.length + 1}" /></label>
          <label>欢迎语<input name="welcomeMessage" placeholder="欢迎进入本分会场" /></label>
          <label class="checkbox"><input name="record" type="checkbox" checked />默认开启录制</label>
          <label class="checkbox"><input name="muteOnStart" type="checkbox" checked />默认入会静音</label>
          <button class="button primary" type="submit">新增分会场</button>
        </form>
      </section>
      <section class="panel">
        <h2>高级配置导入</h2>
        <form method="post" action="/admin/import" class="form">
          <label>完整 JSON 配置<textarea name="rawConfig" rows="20">${escapeHtml(JSON.stringify(config, null, 2))}</textarea></label>
          <button class="button primary" type="submit">覆盖导入配置</button>
        </form>
      </section>
    `
  });
}

function renderQrPage(locals, items) {
  return renderPage({
    title: "二维码导出",
    body: `
      <section class="panel">
        <h1>房间二维码</h1>
        <p>可将下列二维码分别发给分会场和主持人。二维码只包含固定入口地址，真正入会仍需填写每日统一密码。</p>
      </section>
      <section class="grid qr-grid">
        ${items
          .map(
            ({ room, attendeeCode, moderatorCode }) => `
              <article class="panel qr-card">
                <h2>${escapeHtml(room.name)}</h2>
                <div class="qr-pair">
                  <div>
                    <img src="${attendeeCode}" alt="${escapeAttribute(room.name)} 分会场二维码" />
                    <p>分会场入口</p>
                  </div>
                  <div>
                    <img src="${moderatorCode}" alt="${escapeAttribute(room.name)} 主持二维码" />
                    <p>主持人入口</p>
                  </div>
                </div>
              </article>
            `
          )
          .join("")}
      </section>
    `
  });
}

function findGroupName(config, groupSlug) {
  return config.groups.find((group) => group.slug === groupSlug)?.name || "未分组";
}

function renderError(errorText) {
  if (!errorText) {
    return "";
  }

  return `<div class="error">${escapeHtml(errorText)}</div>`;
}

function renderPage({ title, body }) {
  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)}</title>
        <link rel="stylesheet" href="/assets/style.css" />
      </head>
      <body>
        <main class="shell">
          ${body}
        </main>
        <script>
          function openBatch(urls) {
            urls.forEach((url, index) => {
              window.open(url, "_blank", index === 0 ? "noopener" : "noopener");
            });
          }
        </script>
      </body>
    </html>
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
