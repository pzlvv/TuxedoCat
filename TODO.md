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

- **技能发现向上查找父目录**（[specs/029 归档](docs/archive/specs/029-skill-system-alignment/spec.md) 非目标）：
  项目级技能只看会话工作目录（`<cwd>/.agents/skills` 与 `<cwd>/<configDir>/skills`），在 monorepo
  子包（如 `packages/web`）里打开会话时，仓库根上的技能不可见。方向：从 cwd 向上走到 git 工作树根，
  逐层收集同名时按「离 cwd 近的优先」。验收判据：仓库根放的技能在子目录会话里可见；同名时近的胜出
  且只出现一次；`skills_tests` 覆盖向上查找与同名仲裁的叠加。

- **SKILL.md 换成真正的 YAML 解析器**（[specs/029 归档](docs/archive/specs/029-skill-system-alignment/spec.md) 非目标）：
  当前是手写子集，只支持标量、`- ` 数组与 `|` 字面量块；`>-` / `>` 折叠标量、流式数组
  （`[a, b]`）、嵌套 map（`metadata:`）都会被静默降级——`description: >-` 会解析成字面量 `>-`，
  名单里的路由信息直接丢失。验收判据：`>-` / `>` / 流式数组 / 嵌套 map 四类用例进
  `core-rs/fixtures/skills.json` 并有对应断言；解析失败时按「跳过该技能 + 日志」而不是写进错误描述。

- **技能名单的上下文经济**（[specs/029 归档](docs/archive/specs/029-skill-system-alignment/spec.md) 非目标）：
  模型名单没有字符预算，技能一多就线性膨胀；压缩后不重新挂载已加载的技能正文；同一技能重复调用会把
  正文再灌一遍。方向：按比例预算 + 单项上限、压缩时按 token 预算重挂最近调用的技能、内容相同时只加
  一句「已加载」。验收判据：预算与上限可配置且有单测；压缩后技能指令仍可被模型读到；重复调用不重复
  注入正文。
