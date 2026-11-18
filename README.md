# dsh-think-summary

模型思考时间较长时，输入框上方会逐段显示摘要。回复结束后，可以展开回复末尾的「思考总结」，也可以在会话顶部的同名选项卡里回看。插件读取 `reasoning-delta`，主模型的请求、提示词、工具和对话历史都保持原样。摘要只供阅读。

## 安装

仓库里的插件版本是 `0.2.0`，对应 DSH `0.2.2-rc.3`。Web 和 Desktop 各用自己的 profile，两个客户端都用就分别安装。先用 Node.js 24.9.0 或更高版本打包一次，生成的文件可供两端安装。

```sh
git clone https://github.com/GentleKingson/dsh-think-summary.git
cd dsh-think-summary
npm ci
npm pack
```

`npm pack` 会自动构建插件，并在当前目录生成 `dsh-think-summary-0.2.0.tgz`。

### DSH Web

在运行 Web 服务的机器上打开终端。用 `dsh --version` 确认宿主版本；使用 npm 安装的 DSH CLI 时，终端还需要能运行 `pnpm`。在安装包所在目录执行：

```sh
dsh plugin --profile web add ./dsh-think-summary-0.2.0.tgz
```

运行 `dsh web` 启动服务。如果服务已经在运行，重启后刷新聊天页面。要卸载插件，运行 `dsh plugin --profile web remove dsh-think-summary`。本版支持在本机访问 Web。

### DSH Desktop

1. 打开 Desktop，在侧栏选择「插件」，点「添加插件」。
2. 输入刚生成的 `dsh-think-summary-0.2.0.tgz` 的完整路径。点「安装」，核对包名和版本。
3. 安装完成后点「立即启用」。如果界面提示重启，完全退出并重新打开 Desktop。插件详情页也可以停用或卸载它。

如果更习惯命令行，在 Desktop 的应用菜单中打开「管理 dsh 命令…」，安装桌面版提供的命令。首次启动会创建桌面 profile。完全退出应用，再打开新终端，在安装包所在目录执行：

```sh
dsh --version
dsh plugin --profile desktop add ./dsh-think-summary-0.2.0.tgz
```

重新打开 Desktop 即可。命令行卸载时同样先退出应用，再执行 `dsh plugin --profile desktop remove dsh-think-summary`。桌面 profile 由 Desktop 自带的命令管理。[Desktop 官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/apps/desktop/README.zh.md#bundled-command-runtime)

### 确认安装

打开会话，查看顶部是否出现「思考总结」选项卡。让支持推理的模型回答一个需要多步推导的问题。默认思考量达到约 2000 token 后，输入框上方才会开始显示分段摘要。想用短问题验证，可在插件配置里临时调低 `thinkThresholdTokens` 和 `segmentMinTokens`，再发一条消息。

![输入框上方的分段摘要](assets/screenshots/输入框上方实时思考总结卡片.webp)

Desktop rc.3 已验证宿主加载、客户端文件和官方请求转发。原生窗口的界面仍待实机验收。仅加载 Cordis 宿主端时可以记录摘要。[兼容性说明](docs/compatibility-rc3.md)

## 设置

使用 rc.3 原生插件配置表单（插件条目 `think-summary`），字段为 volatile，修改后即时读取，无需自建设置桥。分段参数在下一条流生效；关闭精炼或插件会取消待处理精炼。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 开关；关闭后隐藏摘要界面 |
| `thinkThresholdTokens` | `2000` | 长思考阈值 |
| `segmentMinTokens` / `segmentMaxTokens` | `1500` / `3000` | 语义分段窗口；运行时上限至少等于下限 |
| `refineEnabled` | `true` | 另发一次模型请求，把提取的摘要精炼成中文。精炼失败时保留原文语言的摘要 |
| `refineModel` | `auto` | 留空或填 `auto` 跟随会话；可填写同一 provider 的其他模型 ID。已排队的片段使用入队时确定的模型 |
| `refineMaxInputTokens` | `1500` | 精炼输入头尾裁剪预算 |
| `refineOutputTokens` | `1024` | 模型完成预算，可能包含推理消耗 |
| `refineConcurrency` | `2` | 并发数，范围 1–4；等待队列固定最多 64 段 |
| `refineTimeout` | `60` | 单任务超时秒数，范围 1–120 |
| `codeBlockMode` / `tableMode` | `ignore` | 忽略；`keep-skip` 保留结构摘要；`keep-refine` 保留并精炼 |
| `persistEnabled` | `true` | 读写历史文件 |

标题栏的暂停按钮停止新摘要并取消精炼，已有历史仍可查看；暂停是当前进程的运行状态。

`auto` 不代表更便宜的模型。若需降低调用成本，请指定同 provider 的便宜模型，或关闭精炼，仅使用本地提取摘要。输入/输出 token 为估算值，不包含系统提示词、隐藏推理和提供方计费开销。

## 稳定性与资源控制

- 精炼调用标记 `purpose: 'think-summary'`，独立 `AbortSignal`，不携带主会话工具或历史。超时、暂停、关闭、主请求取消、插件卸载均停止对应任务；迟到结果不回写。提供方必须遵守取消信号才能实际终止网络/算力消耗。
- 实时与兜底共用分段器。兜底读取 rc.3 终态 assistant 消息，无第二份流式原文缓存。未完成行最多保留 65,536 字符，段缓冲最多 200,000 字符；极端大代码/表格保留前部，超限内容只计 token；兜底最多处理 200,000 字符。只有原消息同时标明服务商和模型时才允许精炼。64 token 以下尾段不生成摘要。
- 同会话的实时面板、历史视图和全部回复条共享一个轮询：活跃/待精炼 1.5 秒，空闲 5 秒；隐藏页面停止请求，卸载取消在途请求。回复条持续接收精炼结果。
- 历史位于 `$DSH_HOME/dsh-think-summary.json`（缺省 `~/.dsh/`），兼容旧版 version 1 文件。250ms 合并、异步串行、独立临时文件原子替换，正常卸载等待写完。强制杀进程可能丢失最近尚未写入的变更。
- 历史不会因空闲一小时被删除。仍需按实际使用量管理历史文件；内存历史和单文件存储规模随已记录历史增长。

## HTTP 边界

仅保留两个本机接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/think-summary/state?sessionId=...` | 明确会话的状态，无最近会话回退 |
| POST | `/api/think-summary/pause` | JSON `{ "paused": true }` |

所有接口使用宿主 Connection 验证身份。受限身份读取摘要需要目标会话的 `think-summary/state` 授权，暂停操作仅限所有者。所有接口校验方法、loopback socket、Host、Origin 和 Fetch Metadata；写接口要求 JSON、16KiB 以内正文和 5 秒读取期限。响应禁用缓存。设置交由宿主原生配置接口处理。Desktop rc.3 使用 `dsh-app://app` 经官方 `forwardWebRequest` 转发至本机 Web Host，已验证 GET、POST 和客户端 bundle 均可通行，无需放宽 Origin 校验。远程 Web 和其他反向代理不在本版支持范围内。

## 从 0.1.2 迁移

历史文件直接兼容。原 `selfSummary` 提示词注入、`filterNonAgentLoop`、`refineTrim`、`refinePrompt` 和归档清理设置已移除；旁路过滤、头尾裁剪与中文提示词成为固定策略。`refineModel=auto` 改为沿用当前模型，移除了按上下文窗口猜测“最小模型”的目录扫描。原始配置中的其余同名字段可放入 rc.3 插件行的 `config`；旧 `settings.yaml` 的迁移由宿主负责，请在原生表单确认有效值。

旧设置桥、模型目录和清理接口已移除。输入框面板不再扫描页面标签文字，随宿主 composer 展示。旧版设计/探测记录只作历史参考，以本 README 与兼容性说明为准。

## 开发与验证

在仓库根目录运行 `npm run build`，然后用 `dsh plugin --profile web add link:.` 链接当前目录。每个 profile 只装一个实例。开发时运行 `npm run watch:all` 自动构建；改客户端后刷新页面，改宿主端后重启 DSH。单独检查类型可运行 `npm run typecheck`。


`npm test` 运行真实 rc.3 LLM/Cordis/Loader/Settings 契约测试、队列取消与超时、主流与工具 chunk 透传、持久化恢复、HTTP 防护、共享轮询和分段回归。GitHub Actions 使用 Node 24 与锁定依赖运行同一流程。常规测试使用脚本模型，不消耗真实模型 API 额度。另已使用真实 `deepseek-flash` 验证推理分段、中文精炼、工具往返及持久化，见 [实测记录](docs/validation-rc3.md)。

显式实测命令（后两项会调用真实模型；不会随 CI 自动运行）：

```bash
# 官方源码须为文档指定的 rc.3 commit
DSH_OFFICIAL_SOURCE=/path/to/deepseek-harness npm run test:desktop
# 默认从 api_key 环境变量读取已有凭据，不写入配置或输出
npm run test:live
npm run test:live-cancel
```

可通过 `DSH_LIVE_KEY_ENV` 指定凭据变量名，`DSH_LIVE_MODEL` 指定模型，`DSH_LIVE_BASE_URL` 指定自有端点，`DSH_LIVE_REPORT` 指定 JSON 报告路径。需要 HTTP 代理的环境可使用 Node 的 `NODE_USE_ENV_PROXY=1`；请勿把密钥写进脚本。

[MIT](LICENSE)
