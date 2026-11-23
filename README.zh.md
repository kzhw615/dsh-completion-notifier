# dsh-completion-notifier

会话结束一轮时弹出一条桌面通知，Harness 窗口放在后台也不会错过长任务的结尾。

## 安装

DeepSeek Harness → **插件** → **添加插件**，填入这个仓库地址：

```
https://github.com/kzhw615/dsh-completion-notifier
```

需要 `dsh >= 0.2.2-rc.2`。插件只注册一个 Host 条目和一个 Web 客户端模块，没有构建步骤、没有依赖、不访问网络。

## 行为

- 页面本来就在跟踪每个会话的运行状态（`uiSession`）。插件只认 `running: true → false` 这一个边沿，然后为该会话弹出浏览器原生通知。
- 通知标题是会话名；正文区分「本轮已完成」和「有操作等待你确认」。
- 点击通知会聚焦 Harness 页面并打开该会话。
- 不打扰正在阅读的人：当前窗口中正在主视图查看的会话不弹；子 agent 会话不弹；同一会话 4 秒内不会重复弹。

想验证时，请切到别的 App 或另一个会话，再让一轮任务结束——你正在盯着的那个会话按设计不会弹。

## 限制

- 通知由打开的页面发出。关闭窗口（或退出 App）就没有通知；Host 半边不注册服务，只在有客户端连接时工作。
- Desktop 已经给应用窗口授了通知权限。在普通浏览器里页面会请求一次，浏览器只接受真实点击或按键触发的请求；授权前不会弹。
- 是否显示由系统决定：专注模式、勿扰模式、应用通知设置都可能压掉横幅。

## 开发

```sh
npm test    # node --test test/client.test.mjs
npm run check
```

浏览器半边是由客户端模块表加载的普通 JavaScript（`window.__ModuleLoader__`）：读取 `ctx.sessions.list` 与 `ctx.uiSession.sessionStatus`，点击时调用 `ctx.uiWorkspace.openSession`。
