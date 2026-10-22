---
status: 已修
---

# 缺陷：本地监听的 basename 过滤在 Windows 大小写敏感，换大小写重建后查看器停在「文件已删除」

[specs/018](../../docs/archive/specs/018-viewer-file-refresh/spec.md) 边界约定「路径匹配按
各平台语义（Windows 大小写不敏感，macOS / Linux 按文件系统语义）」。Core 侧
`file_watch.rs` 的 `same_name` 在 Windows 按不区分大小写比较，本地
`localFileWatch.ts` 的 basename 过滤却按全等比较——同一行为两个口径。

## 现状

- `createLocalFileWatcher` 的回调里 `path.basename(filename) !== targetName` 精确比较。
- 漏报场景：查看器监听 `readme.md`，文件被删除（标题标记「文件已删除」），之后以
  `README.MD` 重建——重建的目录项事件只带新大小写的名字，精确比较过滤掉，没有任何
  事件触发 stat，标记永远停在「文件已删除」，内容不刷新（Core 侧同场景正常上报）。
- rename 保存（删除侧事件带旧大小写）不受影响；只有「删除后换大小写重建」这一路径漏。

## 期望

1. Windows 上 basename 过滤不区分大小写（与 Core 侧 `same_name` 同一口径），换大小写
   重建触发 changed、清除删除标记并刷新。
2. 大小写敏感平台（Linux）保持精确比较：换大小写重建是另一个目录项，不误报 changed。
3. 去抖、stat 判定、错误回调与 `close()` 语义不变。

## 不变量

- `filename` 为 null 时按可能命中处理（最终 stat 收敛）的兜底不变。
- 父目录监听 + basename 过滤 + 50ms 去抖的结构不变。
- 事件语义（changed / deleted / error）与 `LocalWatchHandle` 接口不变。

## 回归测试

- **RT-1**：Windows 上「删除 → 换大小写（`note.txt` → `NOTE.TXT`）重建」上报 changed
  （落点：`src/test/localFileWatch.test.ts` 的「删除后换大小写重建上报 changed（Windows）」）。
- **RT-2**：Linux 上同场景不误报 changed（落点：同文件「大小写敏感平台换大小写不误报
  changed」，防过滤口径被改成全局不区分大小写）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前，Windows） | `npm run test:all -- localFileWatch` | 红 | 重建事件被过滤，等待 3s 超时 |
| RT-1（修复后，Windows） | `npm run test:all -- localFileWatch` | 绿 | 6 通过 / 0 失败 |
| RT-2 | Linux CI（`npm run test:all`） | 绿 | 本机 Windows 跑不到该分支，由 CI 的 tests job 覆盖 |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 无 TS 报错、无 lint 报错 |
