# TODO

只列**未排期**的想法与跨 spec 的缺口，每条带验收判据或指向某个 spec。进度不在本文件：
进入实施的改动在 `specs/<NNN>-<slug>/` 跟踪，`tasks.md` 的勾选状态即进度（工作流见
[specs/README.md](specs/README.md)）。完成的项当场删除；里程碑与已完成工作的历史记录见
`docs/archive/`。文档体系与「什么内容写到哪」见 `docs/README.md`。

- **e2e 测试名 ↔ spec FR 编号双向对照**（docsLint 组）：e2e 用例名里引用的 `FR-nnn` 必须能解析到
  活动 spec 或 `docs/features/` 的 FR 条目，spec 的每个 FR 至少被测试名或追溯矩阵行引用——防
  「spec 重排编号后既有测试名引用悬空」（specs/003 收敛评审时发现 FR-007 与 FR-002/003 两套编号
  分叉的实例）。验收判据：docsLint 新组上线，引用悬空即红。

- **SubAgentRegistry 只增不减**（specs/005 收敛反向对照发现的存量缺口）：TS
  `SubAgentRegistry.unregister` 与 Rust `subagent::unregister` 在生产代码中无调用方，
  注册表条目随子代理创建单调增长；注释声称的「完成一轮后注销」未接线，当前语义
  （递归中止可达性 / `subagent` 变更信号）依赖只增不减。接线需先定义「子代理何时
  算完」（一轮 vs 会话终结）并评估递归中止可达范围的变化。验收判据：注销接线后
  长对话场景注册表条目数有界（单测锁定），递归中止用例不回归。

- **`docs/features/user-stories.md` 的拆分**（specs/010 收敛时登记，753 行已超文档 500 行上限
  的豁免项）：需求基线按主题拆成多份，但 `US-xx` 锚点被 e2e 用例与归档 spec 广泛引用，拆分要
  同时处理锚点迁移与引用重指。验收判据：拆分后全仓指向该文件的章节链接零失效（docsLint 链接
  组绿），e2e 的 US 编号映射不变。

- **`CoreRequest` 的 `waiting` 语义没有用例强制登记**（`specs/defects/tool-card-roundtrip-marks-waiting.md`
  修复时登记的缺口）：载荷类型已把「是否等用户」分开（`HostRenderRequest` / `UserBlockingRequest`，
  见 [docs/core/session-runtime.md 第 1 节](docs/core/session-runtime.md#1-来源与调用点)），发起点
  选错入口编译不过；但新增一种 `CoreRequest` 时没有任何用例要求声明它的 `waiting` 语义——该缺陷
  复发正是因为两条发点没有被任何用例覆盖。方向：表驱动用例，对每种 `CoreRequest` 类型跑一次，
  断言在途期间是否出现 `waiting=true` 快照与登记表一致。验收判据：新增 `CoreRequest` 类型而漏
  登记时用例红。

- **查看器自动刷新在 Core 不可用时的兜底**（[specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) 收敛时登记）：
  远程查看器当前依赖远端 Core 推送；Core 不可用 / 未就绪时只显示「自动刷新不可用」标记，不做
  刷新。方向：Core 不可用时降级为 SFTP 轮询，或 Core 恢复后补齐断线期间的修改；需定义切换
  条件、轮询周期与重复刷新抑制。验收判据：Core 不可用期间的文件变更在恢复后可见（或按明确
  周期刷新），同一内容不重复刷新；`viewerWatch` 单测覆盖切换与恢复。

- **本地查看器打开期间的修改丢失**（specs/018 拉取代码评审发现）：远程查看器注册成功后补读
  一次内容，本地查看器建 watcher 后不补读——「读盘 → fs.watch 就绪」之间（开窗加载数百毫秒）
  的外部修改没有任何事件，违反 [specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md)
  FR-005「本地与远程两种后端遵循同一组行为」与 AC-19。方向：`ViewerWatchController.open`
  本地分支建 watcher 后补读一次，内容判重保证未变不投递。验收判据：`viewerWatch` 单测的
  本地打开补读用例绿（不靠任何 watcher 事件）；缺陷规格 `specs/defects/local-viewer-open-race-misses-change.md`。

- **查看器并发刷新乱序可显示旧内容**（specs/018 拉取代码评审发现）：
  `ViewerWatchController.refreshFromSource` 无串行化，两次相邻保存触发的两次「读 → 投递」
  并发执行，读取完成乱序时旧内容后投递，查看器停在旧内容且无后续事件纠正，违反
  [specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) FR-005「刷新以最终落盘内容为准」。
  方向：按当前 watch 串行化「读 → 投递」并在途合并新请求。验收判据：受控延迟读取的单测证明
  两次变更乱序完成后最终投递为最新内容；缺陷规格 `specs/defects/viewer-refresh-races-show-stale-content.md`。

- **Core 重注册拒绝已删除目标，文件重建后永不恢复**（specs/018 拉取代码评审发现）：
  `core-rs/src/file_watch.rs` 的 `validate_target` 对目标整体 canonicalize，断线期间文件被删除后
  Connection ready 重注册必然失败，标记停在「自动刷新不可用」且 Core 侧无监听，文件重建不再
  触发刷新——违反 [specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) FR-006「文件重新出现后
  清除标记并刷新」。方向：目标缺失时按「父目录可达且在根内」放行注册；目标存在时校验不变
  （含符号链接越界拒绝）。验收判据：core-rs 用例「注册不存在的目标 → 创建文件 → 上报 changed」绿；
  缺陷规格 `specs/defects/file-watch-rejects-missing-target.md`。

- **本地监听 basename 过滤在 Windows 大小写敏感**（specs/018 拉取代码评审发现）：
  `electron/localFileWatch.ts` 的 basename 过滤按全等比较，Core 侧 `same_name` 在 Windows 按
  不区分大小写比较；原子保存换大小写重建（`Readme.md` → `README.md`）时本地漏刷新，违反
  [specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) 边界「路径匹配按各平台语义（Windows
  大小写不敏感）」。验收判据：Windows 上换大小写重建触发 changed 的 `localFileWatch` 用例绿；
  缺陷规格 `specs/defects/local-watch-case-sensitive-on-windows.md`。

- **Markdown 内嵌相对路径图片的加载与刷新**（[specs/018 归档](docs/archive/specs/018-viewer-file-refresh/spec.md) 收敛时登记）：
  Markdown 预览是 data URL 页面，没有 base URL，`![](./a.png)` 这类相对路径图片当前不加载；
  方向：自定义协议 / file base / 预览服务，并让内嵌图片随源文件更新。验收判据：相对路径
  图片正常显示，源图片更新后预览自动刷新；有 e2e 或单测锁定。
