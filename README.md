# dsh-think-summary

DSH **0.2.2-rc.3** 独立思考摘要插件，版本 **0.2.0**。支持本机 Web profile；DSH Desktop rc.3 的 Host 与官方请求转发链路已通过集成验证，原生窗口 UI 尚未实机验收；纯 Host 装载可记录摘要。Node.js ≥ 24.9.0。

保留实时思考分段、中文精炼、输入框上方摘要、回复末尾折叠条、历史视图和折叠状态。只观察 `reasoning-delta`，不修改主模型请求、提示词、消息或工具，不将摘要写回会话上下文。精炼失败保留即时提取摘要；提取摘要沿用原文语言，中文输出由精炼提示词要求。

官方基准：[dsh-v0.2.2-rc.3](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.3)，提交 `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`。接口与验证细节见 [兼容性说明](docs/compatibility-rc3.md)。

## 安装与开发

```bash
npm ci
npm test
# 本地 Web profile
dsh plugin --profile web add link:/绝对路径/dsh-think-summary
```

插件通过 `cordis.patch.yml` 装载 Host 和 `./client` 浏览器模块。Host 代码变更需要重启宿主；仅客户端变更重新构建后刷新页面。单个 profile 只装载一个实例。

```bash
npm run typecheck
npm run build
npm run watch:all
npm pack
```

## 设置

使用 rc.3 原生插件配置表单（插件条目 `think-summary`），字段为 volatile，修改后即时读取，无需自建设置桥。分段参数在下一条流生效；关闭精炼或插件会取消待处理精炼。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 开关；关闭后隐藏摘要界面 |
| `thinkThresholdTokens` | `2000` | 长思考阈值 |
| `segmentMinTokens` / `segmentMaxTokens` | `1500` / `3000` | 语义分段窗口；运行时上限至少等于下限 |
| `refineEnabled` | `true` | 独立模型调用生成中文摘要 |
| `refineModel` | `auto` | 沿用该次会话的 provider/model；可填写同 provider 的明确模型 ID |
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
- 实时与兜底共用分段器。兜底读取 rc.3 终态 assistant 消息，无第二份流式原文缓存。未完成行最多保留 65,536 字符，段缓冲最多 200,000 字符；极端大代码/表格保留前部，超限内容只计 token；兜底最多处理 200,000 字符。64 token 以下尾段不生成摘要。
- 同会话的实时面板、历史视图和全部回复条共享一个轮询：活跃/待精炼 1.5 秒，空闲 5 秒；隐藏页面停止请求，卸载取消在途请求。回复条持续接收精炼结果。
- 历史位于 `$DSH_HOME/dsh-think-summary.json`（缺省 `~/.dsh/`），兼容旧版 version 1 文件。250ms 合并、异步串行、独立临时文件原子替换，正常卸载等待写完。强制杀进程可能丢失最近尚未写入的变更。
- 历史不会因空闲一小时被删除。仍需按实际使用量管理历史文件；内存历史和单文件存储规模随已记录历史增长。

## HTTP 边界

仅保留两个本机接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/think-summary/state?sessionId=...` | 明确会话的状态，无最近会话回退 |
| POST | `/api/think-summary/pause` | JSON `{ "paused": true }` |

所有接口校验方法、loopback socket、Host、Origin 和 Fetch Metadata；写接口要求 JSON、16KiB 以内正文和 5 秒读取期限。响应禁用缓存。设置交由宿主原生配置接口处理。Desktop rc.3 使用 `dsh-app://app` 经官方 `forwardWebRequest` 转发至本机 Web Host，已验证 GET、POST 和客户端 bundle 均可通行，无需放宽 Origin 校验。远程 Web 和其他反向代理不在本版支持范围内。

## 从 0.1.2 迁移

历史文件直接兼容。原 `selfSummary` 提示词注入、`filterNonAgentLoop`、`refineTrim`、`refinePrompt` 和归档清理设置已移除；旁路过滤、头尾裁剪与中文提示词成为固定策略。`refineModel=auto` 改为沿用当前模型，移除了按上下文窗口猜测“最小模型”的目录扫描。原始配置中的其余同名字段可放入 rc.3 插件行的 `config`；旧 `settings.yaml` 的迁移由宿主负责，请在原生表单确认有效值。

旧设置桥、模型目录和清理接口已移除。输入框面板不再扫描页面标签文字，随宿主 composer 展示。旧版设计/探测记录只作历史参考，以本 README 与兼容性说明为准。

## 验证

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
