# web-terminal

浏览器里的终端：多账号登录与会话隔离，可绑定对应系统用户启动常驻 shell。服务端是 Node（Hono + ws + node-pty），客户端是不带框架的 TypeScript + xterm.js。用户是作者本人和朋友，会推荐给别人自己部署，所以默认体验要开箱即好。

## 命令

- `npm run check` 类型检查（服务端 + 客户端）
- `npm test` 服务端单元测试
- `npm run build` 打包客户端到 `client/dist`
- `npm start` 启动，只监听 127.0.0.1

Node 直接跑 `.ts`（类型擦除），服务端代码只能用可擦除的语法，导入要带 `.ts` 后缀。

## 结构

- `server/host.ts` shell 宿主，单独的进程和 systemd 单元（`web-terminal-host`），持有全部 shell。网页服务经数据目录里的 Unix 套接字（`var/host.sock`）调它：HTTP 管列表、新建、改名、关闭，每个浏览器连接对应一条到宿主的 WebSocket，`server/host-client.ts` 原样转发帧。网页服务重启不会结束 shell，浏览器重连后拿到新快照。
- `server/terminal.ts` shell 会话，跑在宿主里。每个会话有一份无头 xterm 镜像，浏览器接入时发一帧 JSON 快照（屏幕、回滚、光标、模式），之后才是二进制实时输出。不要退回成原始字节回放：那会从转义序列中间开始、丢掉备用屏和鼠标模式，还会让旧的查询序列被重复应答。
- `server/app.ts` 登录、终端列表、静态资源。`server/auth.ts` scrypt 密码和签名 cookie。
- `client/shell.ts` 一个标签页：xterm、WebGL 渲染、键盘处理、重连。页面打开时所有标签都连上（后台标签才能报状态），切到后台时不销毁，也不参与尺寸计算。
- `client/activity.ts` 后台标签的状态：运行中（转圈）、完成（强调色点）、等你确认（会呼吸的红点）。依据是 OSC 9;4 进度、通知（OSC 9/777/99、响铃）和输出节奏：持续输出算运行，停下 3 秒算结束，单次重绘（tmux 时钟）不算；结束后看屏幕末尾有没有各家 agent 的确认提示，来区分完成和等你。只在客户端做，不碰宿主。
- `client/ime.ts` 输入法、语音输入、手机键盘这类经 textarea 进来的文字。xterm 自带的几条路径（组字结束、insertText、keydown 229 后的差分）在部分输入法下会把同一段话各发一次，所以全部拦下，只按 textarea 相对上次发送的增删发一次。例外是空格、大写字母、死键：xterm 在 keypress 里已经发出，浏览器随后写进 textarea 的同一个字只记下不再发；不要改成拦下 keypress 交给 textarea 发。组字预览也在这里，会换行。
- `client/touch-scroll.ts` 单指拖动和惯性滚动。普通 shell 滚动本地历史，全屏程序沿用 xterm 的滚轮处理，保留鼠标编码和方向键模式。
- `client/themes.ts` 主题。调色板必须如实：黑是深色、白是浅色，浅色主题也一样。可读性靠 `minimumContrastRatio`，不靠把颜色对调。
- `client/settings.ts` 设置的存取和原生 dialog 面板。`client/i18n.ts` 中英文案。
- `client/dom.ts` 节点协调和点击期间的更新延迟。标签和主题控件保留原节点，避免后台更新打断点击、双击和焦点。
- `client/fonts/` 两个回退字体由 `tools/subset-fonts.py` 生成，不手改。

## 约定

- 协议：客户端到服务端，二进制帧是按键，文本帧是 JSON 控制消息（`resize`）；服务端到客户端，文本帧是 JSON（`snapshot`、`title`），二进制帧是输出。
- 账号：cookie 里每个已登录账号一个令牌（`~` 分隔），各用自己账号的密钥签名，改某个账号的密码只让它掉线。一个浏览器可以同时登录多个账号（设置面板里登录其他账号，只输一次密码），终端归属账号，标签栏是这些账号终端的合集，`+` 跟随当前标签的账号。不要做按配置免密切换到别的账号。
- 字符宽度两端都用 Unicode 11，改一端必须改另一端，否则回放时宽字符错位。
- 页面没有自己的配色，全部取自当前终端主题（`main.ts` 的 `paintChrome`）。
- 安全策略是 `font-src 'self'`，所以 Vite 不内联任何资源（`assetsInlineLimit: 0`）。
- 界面文案不加标点，中英文都要补。
- 选中标签的底板是标签栏里单独的一个节点（`.tab-ink`），位置由 `main.ts` 的 `placeInk` 按选中标签量出来：重绘标签时滑过去，标签只是变宽时直接跟上。动效只回应用户操作，`prefers-reduced-motion` 下全部关闭。
- 控件不画描边方框：凹槽用 `--field`，里面抬起的那一块用 `--raised`。深浅主题的差异写在 `:root.dark` 里（`paintChrome` 打标），不用 `light-dark()`：带 `var()` 的声明在旧浏览器里没有回退，会整条失效。
- 控件不要随状态更新整块重建。重命名失焦保存不得抢走下一次点击的焦点。按键栏修饰键只处理用户输入，不处理终端的查询应答。
- 发布：只改了客户端，`npm run build` 后 reload 网页服务，连接都不断。改了网页服务端（`app.ts`、`auth.ts`、`main.ts`、`host-client.ts` 等），restart 网页服务，shell 不受影响。只有改了 `terminal.ts` 或 `host.ts` 才要重启宿主，那会结束所有 shell，先问用户。宿主的接口尽量别动，能放在网页服务里做的就不要放进宿主。
- 不要另起一个实例换端口再切反代来"无中断上线"：标签只存在各自宿主的内存里，切过去旧标签全看不见。

## 验证

渲染类改动（字体、符号、主题、布局）类型检查看不出来，需要真浏览器截图看一次：在 daumhost 上用 `common/node` 跑无头 Chrome 打开站点，打印一屏测试字符后截图。只跑一个场景一次。
