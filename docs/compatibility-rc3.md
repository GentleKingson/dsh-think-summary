# DSH 0.2.2-rc.3 兼容性记录

核对官方 tag `dsh-v0.2.2-rc.3`，commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`。测试依赖使用发布的 rc.3 包，源码副本不随插件发布。

| 契约 | 官方源码（tag 内路径） | 本插件适配 |
|---|---|---|
| 模型流 | `packages/llm/llm/src/index.ts`、`types.ts` | `llm/stream(options,next)`；原始 chunk 透传；`purpose` 隔离；`signal` 取消；错误为 `finish.reason.kind` |
| 一次性摘要 | `packages/llm/llm/src/types.ts` | 顶层 system + identity-free user content blocks；不传工具/主会话历史 |
| 设置 | `packages/settings/settings/src/index.ts`、`schema.ts` | Config 的 volatile 字段；移除不存在的 installSettingsSection/settingsNamespace |
| 热更新 | `vendor/loader/src/config/entry.ts`（发布包 `cordis-plugin-loader`） | `.get()` 读取即时配置；监听 loader/volatile-update 取消已关闭队列 |
| 生命周期 | Cordis `fiber` effect 契约 | `ctx.effect(() => disposer)`；真实 fiber.dispose 测试确认 HTTP 路由被清除 |
| 客户端槽位 | `packages/client/ui-chat/src/client/contract/slots.ts`、`ui-conversation/.../slots.ts` | list 注册必填 id；turnTail 直接接收 owner.turn；不再使用 select/matched |
| 客户端打包 | `packages/client/modules` | 裸包名 + lazy-CJS factory；React ^18.2.0；注入 conversation/chat 包 |
| Web 服务 | `packages/host/webserver/src/index.ts` | exact route + IncomingMessage/ServerResponse；自行保存 register 返回的清理器 |
| 数据路径 | `packages/util/home-paths/src/index.ts` | resolveDshHome()，尊重 DSH_HOME |

官方设置实践文档提及 `.check()`，但此 tag 的 schemastery 3.19.0 源码/发布包没有该方法。本插件使用 schema 单字段边界验证，并将实际 segmentMaxTokens 归一到不小于 segmentMinTokens。

## 回归重点

- 配置名称统一使用 refineEnabled/refineModel/refineMaxInputTokens/refineOutputTokens，不再把整份插件配置误当另一套短名称选项。
- 取消必须同时清队列、abort transport、释放 worker、阻止迟到回写；无响应的提供方不会卡住队列。底层忽略 signal 时仍可能继续消耗提供方资源。
- 异常精炼和不可用服务仅记录通用状态，不将含潜在敏感信息的 provider error 写入摘要历史。
- 主流、工具 chunk 对象和上游错误保留原样；观察器抛错不能终止主流。
- 精炼成功/失败、turn/step 标记都通知存储；重新加载时未完成精炼标记为已中断，不无限显示待精炼。
- 不再把非活跃会话解释为已归档，也不隐式清除有摘要的历史。
- 客户端测试用隔离 VM 验证 bundle/轮询；另用官方 Desktop 转发代码和真实 rc.3 WebServer 验证桌面通信链路，并完成真实 DeepSeek 模型测试，见 validation-rc3.md。未启动 Electron 原生窗口，截图仍为旧版参考。

## 精简与行为变化

设置由 19 项减为 13 项；删除自建设置卡、设置桥、模型目录扫描、prompt 注入模式和不可靠的归档清理。三处 UI 共用轮询；静态/实时分段共用算法；兜底不再逐 chunk 复制整份原文。

原有列表边界测试的尾段小于 64 token，曾依赖静态分段器不执行尾段下限。统一算法后扩充该用例的列表说明，使其继续检验列表边界；原“小尾巴不生成摘要”的测试保持不变。

## Desktop 结论修正

此前仅按 HTTP/IPC 分类把 Desktop 排除在外不准确。rc.3 `apps/desktop/src/main.ts` 在 `dsh-app://app` 下将插件/API 请求交给 `web-document.ts` 的 `forwardWebRequest`；该函数拒绝其他 Origin，然后移除 Host/Origin/Cookie/Fetch Metadata 并附加壳层持有的 Host cookie。`apps/desktop-host/src/index.ts` 使用 Web profile 启动 `127.0.0.1` 随机端口。客户端 `platform: web` 在 Desktop 内同样适用。

因此当前插件无需修改通信实现即可通过 Desktop Host/转发集成测试。此结论不等同于 macOS/Windows 原生窗口、安装器、登录或自动升级的实机验收。

## 历史存储与回归更新

当前历史改为按会话 version 2 文件，按需恢复并只写脏会话；旧 version 1 单文件迁移后保留 `.v1.bak`。内存空闲缓存与非哈希 ETag 的边界见 README。保留旧历史中 `kind: self` 的显示兼容，但不再生成该类型。删除有碰撞风险的段文本哈希去重，重复终态消息仍按 turn/step 幂等处理。

新增 Chromium 真实 React/bundle 行为测试，CI 的构建和 Node 回归覆盖 Linux、Windows、macOS。浏览器和官方 Desktop 转发检查仅在 Linux 运行；不等同于原生 Electron 实机验收。
