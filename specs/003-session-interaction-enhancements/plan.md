# 实施方案：会话交互增强——标签页右键菜单、空闲发送与跳到底部

> **占位骨架**：`spec.md` 尚在起草评审中，「待澄清」未清零，按工作流不得进入本阶段。
> 本文件仅满足目录三件套的结构约定，待 spec 评审通过后由 /plan 产出真实技术方案。

## 技术方案

待 /plan 产出（前置条件：`spec.md` 评审通过且「待澄清」节清零）。

## 受影响模块与契约

待 /plan 产出。已定案的前提：空闲发送挂起为 webview 本地状态（`sendMessage` /
`onQueuedMessage` 宿主契约不动，见 `spec.md` FR-003）；标签页右键走「渲染层上报 +
主进程原生菜单弹出」通道（复用既有 `titlebar:` IPC 形态）。

## 宪章检查

待 /plan 逐项检查（不适用的一条也要写「不涉及 + 理由」）：

- [ ] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：core 不 import host 实现、host 不 import 宿主 API、
      不做宿主嗅探——
- [ ] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback、契约成员全必选、一份事实一个
      写入点、默认值单源——
- [ ] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：涉及任一侧 Core 行为必须同步另一侧、
      对照表与两侧测试——
- [ ] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：受影响规格清单与同步时机——

## 被否决的替代方案

待 /plan 产出。
