# web-terminal

浏览器里的终端：单账号登录，标签页对应服务器上的常驻 shell。服务端是 Node（Hono + ws + node-pty），客户端是不带框架的 TypeScript + xterm.js。用户是作者本人和朋友，会推荐给别人自己部署，所以默认体验要开箱即好。

## 命令

- `npm run check` 类型检查（服务端 + 客户端）
- `npm test` 服务端单元测试
- `npm run build` 打包客户端到 `client/dist`
- `npm start` 启动，只监听 127.0.0.1

Node 直接跑 `.ts`（类型擦除），服务端代码只能用可擦除的语法，导入要带 `.ts` 后缀。

## 结构

- `server/terminal.ts` shell 会话。每个会话有一份无头 xterm 镜像，浏览器接入时发一帧 JSON 快照（屏幕、回滚、光标、模式），之后才是二进制实时输出。不要退回成原始字节回放：那会从转义序列中间开始、丢掉备用屏和鼠标模式，还会让旧的查询序列被重复应答。
- `server/app.ts` 登录、终端列表、静态资源。`server/auth.ts` scrypt 密码和签名 cookie。
- `client/shell.ts` 一个标签页：xterm、WebGL 渲染、键盘处理、重连。标签切到后台时不销毁，也不参与尺寸计算。
- `client/touch-scroll.ts` 单指拖动和惯性滚动。普通 shell 滚动本地历史，全屏程序沿用 xterm 的滚轮处理，保留鼠标编码和方向键模式。
- `client/themes.ts` 主题。调色板必须如实：黑是深色、白是浅色，浅色主题也一样。可读性靠 `minimumContrastRatio`，不靠把颜色对调。
- `client/settings.ts` 设置的存取和原生 dialog 面板。`client/i18n.ts` 中英文案。
- `client/dom.ts` 节点协调和点击期间的更新延迟。标签和主题控件保留原节点，避免后台更新打断点击、双击和焦点。
- `client/fonts/` 两个回退字体由 `tools/subset-fonts.py` 生成，不手改。

## 约定

- 协议：客户端到服务端，二进制帧是按键，文本帧是 JSON 控制消息（`resize`）；服务端到客户端，文本帧是 JSON（`snapshot`、`title`），二进制帧是输出。
- 字符宽度两端都用 Unicode 11，改一端必须改另一端，否则回放时宽字符错位。
- 页面没有自己的配色，全部取自当前终端主题（`main.ts` 的 `paintChrome`）。
- 安全策略是 `font-src 'self'`，所以 Vite 不内联任何资源（`assetsInlineLimit: 0`）。
- 界面文案不加标点，中英文都要补。
- 选中标签的底板是标签栏里单独的一个节点（`.tab-ink`），位置由 `main.ts` 的 `placeInk` 按选中标签量出来：重绘标签时滑过去，标签只是变宽时直接跟上。动效只回应用户操作，`prefers-reduced-motion` 下全部关闭。
- 控件不画描边方框：凹槽用 `--field`，里面抬起的那一块用 `--raised`。深浅主题的差异写在 `:root.dark` 里（`paintChrome` 打标），不用 `light-dark()`：带 `var()` 的声明在旧浏览器里没有回退，会整条失效。
- 控件不要随状态更新整块重建。重命名失焦保存不得抢走下一次点击的焦点。按键栏修饰键只处理用户输入，不处理终端的查询应答。
- 只改了客户端：`npm run build` 后 reload 服务即可，不会断开已有 shell。改了服务端要 restart，会结束所有 shell。

## 验证

渲染类改动（字体、符号、主题、布局）类型检查看不出来，需要真浏览器截图看一次：在 daumhost 上用 `common/node` 跑无头 Chrome 打开站点，打印一屏测试字符后截图。只跑一个场景一次。
