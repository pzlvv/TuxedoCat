---
status: 已修
---

# 缺陷：远端车道模型请求全部超时（mock LLM 不可达）

`electron-ssh` 车道的用例在「发一条消息」这一步永久卡住：界面一直转圈、`终止` 按钮
常亮，而本机 mock LLM 侧**一个请求都没收到**。所有依赖消息往返的用例因此超时失败，
包括与本次改动无关的既有用例。

## 现状

远端 Core 要回连本机的 mock LLM（`settings.json` 的 `baseURL`），地址来自
`detectLlmAdvertiseHost()`：

```ts src=e2e/helpers/testEnvironment.ts
export function detectLlmAdvertiseHost(): string {
  const fallbacks: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('192.168.')) return info.address;
      fallbacks.push(info.address);
    }
  }
  if (fallbacks.length > 0) return fallbacks[0];
```

它返回本机内网地址（实测 `192.168.31.228`）。远端是公网机（`8.136.22.171`），
**访问不到**这个 NAT 后的地址，于是每次模型请求都连到超时。Core 不报错（那是
「端点不可达」而不是「配置错误」），宿主也不报错——表现为纯粹的静默挂起。

症状具有强误导性：0 个模型请求 + 界面转圈，看起来像工具链或引擎缺陷。实际是
mock 根本没被访问到。

## 期望

远端 Core 能访问到本机的 mock LLM。测试机与本机之间本来就有一条可用的 SSH 连接，
把它当传输通道即可：mock 监听后经 SSH 反向隧道暴露到测试机回环。

隧道端口由**远端**分配（`forwardIn` 传 0），因为 mock 的监听端口是动态的；写死会与
并行用例撞车。`sshd` 的 `GatewayPorts no` 只允许绑回环，而 Core 与隧道同在测试机上，
`127.0.0.1` 足够。

## 不变量

- 远端车道不依赖本机对远端可达：本机在 NAT 后、无公网地址时仍能跑。
- 本地车道不受影响：不传 `reverseTunnel` 时不建任何隧道，行为与改动前一致。
- 隧道随 `MockLlm.close()` 关闭，不残留远端监听。

## 回归测试

- **RT-1**：`remoteSshExecution` 的「远程工作区启动恢复：SSH 建链 → daemon 引导 →
  Core 就绪可输入」——纯文本往返，改动前 0 请求必失败，改动后通过。
- **RT-2**：`remoteSshExecution` 的「Bash 在远端执行」——模型可达 + 工具真在远端跑，
  覆盖完整往返。
- **RT-3**：`overlayMountProxyRemote` 普通段全部用例——隔离会话里的 Write / Bash
  与本次改动共用同一条 mock 通道。
- **RT-4**：`US-42 远程重连就绪后侧栏文件树自动重读`——顺带修掉的脚手架地址错误，
  由 4 分钟超时转为 12.8 秒通过。

反向隧道本身的端到端可达性另用一次性脚本验证（本机 HTTP 服务 → 远端 `curl` 取到
内容），不留在仓库里。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `test:e2e:ssh -- remoteSshExecution -g "远程工作区启动恢复"` | 红 | 0 个模型请求，60s 超时 |
| 复现（修复前） | `test:e2e:ssh -- remoteSshExecution -g "Bash 在远端执行"` | 红 | 同上，界面一直转圈 |
| 隧道可达性 | 一次性脚本：本机 HTTP + `forwardIn(0)` → 远端 `curl` | 绿 | 取到 `EPHEMERAL-TUNNEL-OK` |
| 建链（修复后） | `test:e2e:ssh -- remoteSshExecution -g "远程工作区启动恢复"` | 绿 | 7.2s |
| 工具往返（修复后） | `test:e2e:ssh -- remoteSshExecution -g "Bash 在远端执行"` | 绿 | 6.5s |
| 隔离车道（修复后） | `test:e2e:ssh -- overlayMountProxyRemote` | 绿 | 6 通过 / 6 跳过 |
| 三个远端 spec | `test:e2e:ssh -- remoteSshExecution remoteChangeList remoteTaskSurvival` | 绿 | 26 通过（含修好的 US-42） |

