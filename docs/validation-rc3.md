# Desktop 与真实模型验证记录

验证日期：2026-11-18（Asia/Hong_Kong）。插件版本：0.2.0。官方基准：DSH `dsh-v0.2.2-rc.3`，commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`。

## Desktop

**Host 与官方转发链路通过，无需更改插件通信代码。** 上一轮“Desktop 不在支持范围”的结论过于笼统，现已更正。

直接导入官方 `apps/desktop/src/web-document.ts` 中的 `forwardWebRequest`，启动真实 rc.3 `WebServer` 和插件，验证：

| 检查 | 结果 |
|---|---|
| `dsh-app://app/api/think-summary/state?sessionId=...` | 200，返回插件状态 |
| 从 Desktop 转发 JSON 暂停请求 | 200，状态变为 paused |
| 不可信 Origin 经官方转发函数 | 403 |
| 绕过壳层、直接携带 dsh-app Origin 访问 HTTP | 403，原防护仍生效 |
| `/plugins/dsh-think-summary/client.js` | 内容完整转发，响应 no-store |
| 卸载插件后再访问接口 | 404，路由清理成功 |

源码确认 Desktop Host 以本机随机端口运行 Web 应用，壳层在 `dsh-app://app` 下转发非静态请求；`dsh.client.platform: web` 可以被 Desktop 的 Web 客户端模块系统识别。官方转发器校验应用 Origin，再移除相关浏览器请求头并附加壳层 cookie，所以插件原有同源防护无需放宽。

测试范围是实际 Host 服务和官方转发函数。测试不启动完整 Desktop 发行包，使用测试 cookie；不覆盖登录认证、安装器、完整客户端模块发现、macOS/Windows Electron 窗口或视觉布局。

复现：

```bash
npm ci
npm run build
DSH_OFFICIAL_SOURCE=/path/to/official-rc3 npm run test:desktop
```

## 真实模型成功路径

使用环境中已有的凭据，连接 `https://api.deepseek.com/anthropic`，通过官方 rc.3 `DeepSeekAdapter` 和 `LlmRuntime` 调用 `deepseek-flash`。未使用模拟模型，未输出或保存凭据。

- 主问题：从 1..12 选 4 个不同且互不相邻的整数，和为 26，求组合数。
- 实际主推理流包含 5,200 字符 reasoning，正常 `stop`，耗时约 13.8 秒。
- 最终答案为 **12**；另外用本地组合枚举核对，结果同为 12。
- 插件生成 **2 段中文精炼摘要**，两次独立真实请求均正常 `stop`，分别约 2.1 秒和 2.0 秒；未携带工具或主会话消息。
- 真实模型随后调用 `verification_echo`，本地执行这个固定、安全的测试工具，向模型返回结果，模型最终输出 **`DSH_RC3_TOOL_OK`**。
- 卸载时最终精炼状态写入临时 `DSH_HOME`；重新装载插件后读回同样的精炼摘要。
- 成功路径共 5 次真实 API 请求：3 次主调用、2 次精炼。提供方报告 totalTokens 合计 **7,133**，包含缓存读取，非费用估算。

测试工具由脚本执行，使用宿主官方消息组装和工具结果格式；没有执行任意模型生成的 shell 命令，也未声称覆盖完整 agent-loop/tool-executor 的所有工具。

摘要示例：

> 将不相邻且和为26的4数组合变换为1~9中4个不同数和为20，枚举得共12种。

复现（会消耗真实 API 额度）：

```bash
# api_key 环境变量需已配置；不要把真实密钥写进文件或命令历史
DSH_LIVE_REPORT=/tmp/live-model-check.json npm run test:live
```

## 真实网络取消与超时

另外发起 2 次真实精炼请求，均已收到提供方流式文本后才结束：

| 场景 | 底层 signal | 底层流 | 结果回写 |
|---|---|---|---|
| 收到首个模型增量后主动取消 | aborted=true | 已结束，整次约 895ms | 0 |
| 配置 1 秒超时 | aborted=true | 已结束，约 1002ms | 0 |

队列最终 running=0、pending=0，失败状态分别为“精炼已取消”“精炼超时”。取消请求未获取完整 usage，不计入前述 7,133 token。

```bash
DSH_LIVE_REPORT=/tmp/live-cancel-check.json npm run test:live-cancel
```

## 自动化边界

常规 28 项测试、9 组分段回归和类型检查继续通过。Desktop 官方转发检查加入 CI；两项真实模型脚本仅显式运行，避免 CI 自动花费额度。上述实测证明本次模型、配置及调用路径可用，不替代其他提供方和原生桌面 UI 的实机测试。
