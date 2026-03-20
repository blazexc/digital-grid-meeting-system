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
  response.locals.basePath = normalizeBasePath(process.env.APP_BASE_PATH || "");
  next();
});

app.get("/healthz", (request, response) => {
  response.json({ ok: true, time: new Date().toISOString() });
});

app.get("/help", (request, response) => {
  response.send(renderHelpPage(response.locals));
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
            <div class="eyebrow">数字化网格管理会议系统</div>
            <h1>${escapeHtml(config.siteName)}</h1>
            <p>当前已纳管 ${roomCount} 个分会场、${groupCount} 个分组。系统支持固定会场接入、统一每日口令、分组主持入口、总主持人统一调度，以及配合 Edge 和 Revolver Tabs 的轮巡查看模式。</p>
            <div class="button-row">
              <a class="button primary" href="${routePath(response.locals, "/master")}">总主持人入口</a>
              <a class="button" href="${routePath(response.locals, "/help")}">使用说明</a>
              <a class="button" href="${routePath(response.locals, "/admin")}">系统管理</a>
            </div>
          </div>
          <div class="panel">
            <h2>分组主持工作台</h2>
            <div class="grid cards">
              ${config.groups
                .map(
                  (group) => `
                    <a class="card" href="${routePath(response.locals, `/group/${encodeURIComponent(group.slug)}`)}">
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
          <h2>固定会场入口</h2>
          <div class="grid cards">
            ${config.rooms
              .map(
                (room) => `
                  <a class="card" href="${routePath(response.locals, `/join/${encodeURIComponent(room.slug)}`)}">
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
  response.redirect(routePath(response.locals, `/group/${encodeURIComponent(group.slug)}`));
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
  response.redirect(routePath(response.locals, "/master"));
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
  response.redirect(routePath(response.locals, "/admin"));
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
  response.redirect(routePath(response.locals, "/admin"));
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

  response.redirect(routePath(response.locals, "/admin"));
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

  response.redirect(routePath(response.locals, "/admin"));
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
    response.redirect(routePath(response.locals, "/admin"));
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
    response.redirect(routePath({ basePath: normalizeBasePath(process.env.APP_BASE_PATH || "") }, "/admin"));
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
        <p>请通过固定链接进入本会场，填写姓名和当日统一口令后，系统将自动拉起对应会议室。</p>
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
        <p>登录后可查看本组分会场状态，批量打开主持页面，并配合 Edge 与 Revolver Tabs 执行轮巡查看。</p>
        ${renderError(errorText)}
        <form method="post" action="${routePath(locals, `/group/${encodeURIComponent(group.slug)}/login`)}" class="form">
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
        <p>登录后可统一查看全部分组和全部分会场，并快速进入任意主持入口开展调度。</p>
        ${renderError(errorText)}
        <form method="post" action="${routePath(locals, "/master/login")}" class="form">
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
        <p>本组建议同时查看 ${group.wallSize} 个分会场。以下入口均指向固定房间，便于主持人在 Edge 中打开多个标签页，再交由 Revolver Tabs 自动轮巡。</p>
        <div class="button-row">
          <button class="button primary" type="button" onclick="openBatch(${escapeAttribute(JSON.stringify(launchLinks))})">一键打开本组主持标签页</button>
          <a class="button" href="${routePath(locals, "/")}">返回首页</a>
        </div>
      </section>
      <section class="panel">
        <h2>轮巡查看建议</h2>
        <ul class="list">
          <li>建议固定使用 Edge 浏览器作为值守终端。</li>
          <li>安装 Revolver Tabs 插件后，可将切页间隔设置为 ${locals.config.wall.defaultSecondsPerTab} 秒。</li>
          <li>如当前大屏同时显示 2 至 8 个窗口，可只打开需要重点查看的分会场标签页。</li>
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
                  <a class="button primary" href="${routePath(locals, `/moderator/${encodeURIComponent(room.slug)}`)}" target="_blank" rel="noreferrer">主持进入</a>
                  <a class="button" href="${routePath(locals, `/join/${encodeURIComponent(room.slug)}`)}" target="_blank" rel="noreferrer">分会场入口</a>
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
        <p>本页按分组展示全部固定房间。总主持人可快速进入任意分会场主持入口，也可批量打开标签页并交由 Edge 与 Revolver Tabs 执行轮巡。</p>
        <div class="button-row">
          <button class="button primary" type="button" onclick="openBatch(${escapeAttribute(JSON.stringify(launchLinks))})">打开全部主持标签页</button>
          <a class="button" href="${routePath(locals, "/")}">返回首页</a>
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
                          <a class="button primary" href="${routePath(locals, `/moderator/${encodeURIComponent(room.slug)}`)}" target="_blank" rel="noreferrer">主持进入</a>
                          <a class="button" href="${routePath(locals, `/join/${encodeURIComponent(room.slug)}`)}" target="_blank" rel="noreferrer">分会场入口</a>
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
        <p>此入口用于维护每日统一口令、分组配置、会场配置和二维码导出。</p>
        ${renderError(errorText)}
        <form method="post" action="${routePath(locals, "/admin/login")}" class="form">
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
        <p>当前共有 ${config.groups.length} 个分组、${config.rooms.length} 个分会场。会场数量采用配置化管理，可按需持续增加。</p>
        ${renderError(errorText)}
        <div class="button-row">
          <a class="button" href="${routePath(locals, "/admin/export")}" target="_blank" rel="noreferrer">导出配置文件</a>
          <a class="button" href="${routePath(locals, "/admin/qrcodes")}" target="_blank" rel="noreferrer">查看二维码页</a>
        </div>
      </section>
      <section class="grid admin-grid">
        <form method="post" action="${routePath(locals, "/admin/daily-password")}" class="panel form">
          <h2>每日统一口令</h2>
          <label>当前密码<input name="dailyPassword" value="${escapeAttribute(config.dailyPassword)}" required /></label>
          <button class="button primary" type="submit">保存密码</button>
        </form>
        <form method="post" action="${routePath(locals, "/admin/groups")}" class="panel form">
          <h2>新增分组</h2>
          <label>分组名称<input name="name" placeholder="例如：第二组" required /></label>
          <label>分组标识<input name="slug" placeholder="例如：group-b" /></label>
          <label>排序<input name="order" type="number" value="${config.groups.length + 1}" /></label>
          <label>建议墙数<input name="wallSize" type="number" min="2" max="8" value="4" /></label>
          <label>说明<input name="description" placeholder="例如：东区分组" /></label>
          <button class="button primary" type="submit">新增分组</button>
        </form>
        <form method="post" action="${routePath(locals, "/admin/rooms")}" class="panel form">
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
        <form method="post" action="${routePath(locals, "/admin/import")}" class="form">
          <label>完整配置内容<textarea name="rawConfig" rows="20">${escapeHtml(JSON.stringify(config, null, 2))}</textarea></label>
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
        <p>可将下列二维码分别发给分会场和主持人。二维码仅包含固定入口地址，正式入会仍需填写每日统一口令。</p>
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

function renderHelpPage(locals) {
  return renderPage({
    title: "使用说明",
    body: `
      <section class="panel">
        <div class="eyebrow">使用说明</div>
        <h1>进入逻辑与密码逻辑说明</h1>
        <p>这套系统是在 BigBlueButton 会议内核之外，加了一层中文业务门户。门户负责固定入口、统一口令、分组入口和总控入口，真正的会议仍在 BigBlueButton 中进行。</p>
      </section>
      <section class="panel">
        <h2>一、四类入口</h2>
        <div class="grid cards">
          <article class="card">
            <strong>分会场入口</strong>
            <span>链接格式：<code>/join/分会场标识</code></span>
            <span>使用对象：每个分会场终端。</span>
            <span>进入后是普通参会权限。</span>
          </article>
          <article class="card">
            <strong>房间主持入口</strong>
            <span>链接格式：<code>/moderator/分会场标识</code></span>
            <span>使用对象：负责该会场的主持人。</span>
            <span>进入后是该房间主持权限。</span>
          </article>
          <article class="card">
            <strong>分组主持入口</strong>
            <span>链接格式：<code>/group/分组标识</code></span>
            <span>使用对象：9 个分组主持人。</span>
            <span>登录后可查看本组全部分会场，并批量打开主持页面。</span>
          </article>
          <article class="card">
            <strong>总主持人入口</strong>
            <span>链接格式：<code>/master</code></span>
            <span>使用对象：总主持人。</span>
            <span>登录后可查看全部分组和全部分会场。</span>
          </article>
        </div>
      </section>
      <section class="panel">
        <h2>二、三层密码逻辑</h2>
        <div class="grid cards">
          <article class="card">
            <strong>每日统一口令</strong>
            <span>这是会前统一通知给所有人的口令。</span>
            <span>分会场、分组主持、总主持人，进入门户时都要填写这一层口令。</span>
            <span>管理员可以在“系统管理”页面按天修改。</span>
          </article>
          <article class="card">
            <strong>房间内部参会密码</strong>
            <span>这是系统自动调用 BigBlueButton 时使用的房间级密码。</span>
            <span>分会场用户不会直接看到这个密码，门户会代为跳转。</span>
          </article>
          <article class="card">
            <strong>后台管理员密码</strong>
            <span>这是进入“系统管理”页面的独立口令。</span>
            <span>它和每日统一口令不是同一个用途。</span>
          </article>
        </div>
      </section>
      <section class="panel">
        <h2>三、典型使用流程</h2>
        <ul class="list">
          <li>管理员会前进入“系统管理”，修改每日统一口令。</li>
          <li>管理员把各分会场固定链接或二维码发给对应会场，把分组主持入口发给分组主持人。</li>
          <li>分会场用户打开自己的固定链接，填写会场名称和当日统一口令后入会。</li>
          <li>分组主持人进入本组工作台，查看本组分会场状态，并按需打开多个主持页面。</li>
          <li>总主持人进入总控台，统一查看全部分组和全部固定会场。</li>
        </ul>
      </section>
      <section class="panel">
        <h2>四、当前默认信息</h2>
        <ul class="list">
          <li>已预置 10 个分组、20 个分会场，可继续在后台增加。</li>
          <li>当前每日统一口令：<code>123456</code></li>
          <li>当前后台管理员密码：<code>grid-admin-20260320</code></li>
          <li>二维码导出入口：<code>/admin/qrcodes</code></li>
        </ul>
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
        <link rel="stylesheet" href="${routePath({ basePath: normalizeBasePath(process.env.APP_BASE_PATH || "") }, "/assets/style.css")}" />
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

function normalizeBasePath(value) {
  const normalized = String(value || "").trim();

  if (!normalized || normalized === "/") {
    return "";
  }

  return normalized.startsWith("/") ? normalized.replace(/\/$/, "") : `/${normalized.replace(/\/$/, "")}`;
}

function routePath(locals, pathname) {
  return `${locals.basePath || ""}${pathname}`;
}
