# 数字化网格管理会议系统

本项目是一个基于 `BigBlueButton` 的中文总控门户，用来补齐固定房间、多分组主持、统一密码入会、总主持人入口、二维码分发，以及适配 `Edge + Revolver Tabs` 的视频轮播监看能力。

## 项目定位

这不是替代 `BigBlueButton` 的会议内核，而是叠加在现有 `BBB` 之上的业务控制层，重点解决下列场景：

- 固定房间长期使用，不依赖临时创建会议链接
- 分会场和主持人通过不同入口地址进入同一房间
- 所有人仍需填写当天统一密码
- 9 个分组主持人只看自己负责的分组
- 1 个总主持人可以进入全部分会场
- 房间数量不写死，通过配置动态增减
- 支持二维码导出与固定链接分发
- 支持 `Edge + Revolver Tabs` 轮播监看

## 当前能力

- 中文首页、分组入口、总主持人入口、管理员入口
- 固定分会场入口 `/join/:slug`
- 固定主持入口 `/moderator/:slug`
- 分组主持控制台 `/group/:slug`
- 总主持人控制台 `/master`
- 管理员后台 `/admin`
- 每日统一密码维护
- 动态新增分组与房间
- JSON 配置导入导出
- 分会场与主持二维码导出
- 直连 `BBB API` 自动创建会议并生成入会跳转链接

## 本地开发

```bash
npm install
copy data\\rooms.example.json data\\rooms.json
set PORT=18080
set PORTAL_BASE_URL=http://127.0.0.1:18080
set BBB_BASE_URL=https://room.shukunnet.com:16443/bigbluebutton/api
set BBB_SECRET=请替换为真实密钥
set ADMIN_PASSWORD=请设置后台口令
set SESSION_SECRET=请设置会话密钥
npm start
```

## Docker 部署

```bash
docker compose up -d --build
```

默认对外暴露 `18080` 端口，建议通过反向代理映射到 `https://room.shukunnet.com:16443/portal/` 或独立二级路径。

## 目录结构

- `src/app.js`：门户主程序与全部页面路由
- `src/bbb-api.js`：`BBB API` 签名与调用逻辑
- `src/config-store.js`：房间和分组配置管理
- `src/public/style.css`：门户样式
- `data/rooms.example.json`：示例配置
- `docs/deploy.md`：详细部署文档

## 设计说明

首版视频轮播不强行做复杂的单页九宫格解码聚合，而是优先走低开发量、低风险的路径：

- 由门户批量打开固定房间主持标签页
- 主会场监看电脑固定使用 `Edge`
- 安装 `Revolver Tabs` 插件自动轮播标签页
- 每个分组主持人根据自己组的 `wallSize` 同时打开 2 到 8 个分会场

后续若要升级成真正单页九宫格聚合监看，可在本项目上继续增加监看服务。
