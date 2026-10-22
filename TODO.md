# TODO

只列**未排期**的想法与跨 spec 的缺口，每条带验收判据或指向某个 spec。进度不在本文件：
进入实施的改动在 `specs/<NNN>-<slug>/` 跟踪，`tasks.md` 的勾选状态即进度（工作流见
[specs/README.md](specs/README.md)）。完成的项当场删除；里程碑与已完成工作的历史记录见
`docs/archive/`。文档体系与「什么内容写到哪」见 `docs/README.md`。

- **查看器自动刷新在 Core 不可用时的兜底**（[specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) 收敛时登记）：
  远程查看器当前依赖远端 Core 推送；Core 不可用 / 未就绪时只显示「自动刷新不可用」标记，不做
  刷新。方向：Core 不可用时降级为 SFTP 轮询，或 Core 恢复后补齐断线期间的修改；需定义切换
  条件、轮询周期与重复刷新抑制。验收判据：Core 不可用期间的文件变更在恢复后可见（或按明确
  周期刷新），同一内容不重复刷新；`viewerWatch` 单测覆盖切换与恢复。

- **Markdown 内嵌相对路径图片的加载与刷新**（[specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) 收敛时登记）：
  Markdown 预览是 data URL 页面，没有 base URL，`![](./a.png)` 这类相对路径图片当前不加载；
  方向：自定义协议 / file base / 预览服务，并让内嵌图片随源文件更新。验收判据：相对路径
  图片正常显示，源图片更新后预览自动刷新；有 e2e 或单测锁定。
