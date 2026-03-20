# 部署文档

## 1. 部署目标

将本项目作为独立门户部署到现有 `BigBlueButton Docker` 环境旁边，不侵入原有 `BBB` 容器。

## 2. 环境变量

必须配置以下环境变量：

- `PORT`：门户监听端口，建议 `18080`
- `APP_BASE_PATH`：可选。如果反代到同域名子路径，例如 `/portal`，请设为 `/portal`
- `PORTAL_BASE_URL`：门户对外基础地址，例如 `https://room.shukunnet.com:16443/portal`
- `BBB_BASE_URL`：`BBB API` 地址，例如 `https://room.shukunnet.com:16443/bigbluebutton/api`
- `BBB_SECRET`：`BBB` 共享密钥
- `ADMIN_PASSWORD`：门户后台管理密码
- `SESSION_SECRET`：门户会话密钥
- `SITE_NAME`：系统中文名称，建议设为“数字化网格管理会议系统”

## 3. 推荐反向代理方式

建议反代到以下 HTTP 端口：

- `18080`

推荐路径：

- `/portal/` 映射到门户服务
- 原站点 `/` 继续保留给现有 `BBB / Greenlight`

## 4. 首次启动

```bash
docker compose up -d --build
```

首次启动后会自动生成：

- `data/rooms.json`

你可以直接登录后台新增分组和房间，也可以手工编辑该文件后重启容器。

## 5. 管理入口

- 首页：`/`
- 总主持人入口：`/master`
- 分组主持入口：`/group/<group-slug>`
- 分会场入口：`/join/<room-slug>`
- 房间主持入口：`/moderator/<room-slug>`
- 管理后台：`/admin`
- 二维码页：`/admin/qrcodes`

## 6. 与 BigBlueButton 的关系

门户本身不存储音视频流，也不替代 `BBB` 的会议内核。它只做以下工作：

- 验证每日统一密码
- 根据固定房间配置调用 `BBB create`
- 生成 `BBB join` 跳转地址
- 为主持人和分会场提供不同入口
- 聚合分组和总控视图

## 7. 房间模型建议

每个分会场对应一个固定 `meetingId`，长期不变。

建议字段：

- `slug`：门户路由标识
- `name`：中文房间名
- `meetingId`：`BBB` 固定会议 ID
- `groupSlug`：所属分组
- `attendeePassword`：分会场入会密码
- `moderatorPassword`：主持密码
- `record`：是否默认录制

## 8. 视频轮播建议

首版采用 `Edge + Revolver Tabs`，避免额外开发复杂的视频墙合成服务。

建议做法：

1. 分组主持人在门户打开本组若干主持标签页。
2. 总主持人在门户打开全部或指定分组的主持标签页。
3. `Revolver Tabs` 按固定秒数轮播。
4. 大屏需要同时看多个房间时，采用窗口平铺或多显示器方式。

## 9. 录制说明

现有远程 `BBB Docker` 环境里，录制链路目前未完全启用，且 `webrtc-sfu` 日志里存在 `bbb-webrtc-recorder` 心跳超时告警。上线前应优先修复 `BBB` 原生录制链路，再把门户里的房间录制开关长期启用。

## 10. 未来扩展

后续可继续追加：

- 单页九宫格聚合视频墙
- 被点名发言状态同步
- 自动字幕接口
- 房间录制索引页
- 与组织账户体系联动
