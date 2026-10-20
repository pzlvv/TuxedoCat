/**
 * SpinDesign - Spin 设计器的宿主契约（第二个 UI surface）
 *
 * 与 UIHost 分开的理由（docs/architecture/contracts.md 第 2 节）：
 * 1. 独立面板/窗口（VS Code: WebviewPanel；Electron: BrowserWindow），
 *    生命周期与消息协议都与对话 webview 无关；
 * 2. UIHost 已经有很多成员，再混进 2 个 Spin 专属成员会让「宿主能力」失真；
 * 3. 拆出后 Spin 的整块（HTML 生成 + 导出 + 面板管理）可整体替换或搬走。
 *
 * 构造依赖：constructor(host: UIHost)。实现只用其中 4 个成员——
 * isDarkTheme() / getLocale()（生成 HTML）、saveTextFile()（导出）、log()。
 * 不反向要求 UIHost 知道 Spin 的存在；`spin.json` 与技能清单经 Core 的
 * `UiRequest.spinDesignRequested` 取回，不由宿主直接读盘。
 *
 * 设计器消息协议（设计器 ↔ 宿主，不走 AssistantEventBus）：
 * - 设计器 → 宿主：refreshSpinDesign / saveSpinDesign / exportSpinDesign
 * - 宿主 → 设计器：spinDesignData / spinSaveResult / spinExportResult
 */

/** Spin 设计器的宿主契约。 */
export interface SpinDesign {
  /**
   * 打开设计器；已打开则复用（**会话不同则切到新会话的数据**），不重复创建。
   *
   * @param sessionId 发起方会话 id——`spin.json` 与技能清单都归属该会话的
   *   工作目录（Core 所在机器）。`null` 表示没有会话：空态窗口，保存不可用。
   *   设计器是单例窗口，不能回退到「活动工作目录」：从别的标签页再 `/spin` 时
   *   活动会话可能已经变了。
   *
   * 首次读取失败时不创建窗口并 reject（宿主据此提示错误）；已打开窗口切换会话
   * 读取失败时保持原绑定，向窗口推 `spinDesignError`。
   */
  open(sessionId: string | null): Promise<void>;

  /**
   * 从 Core 重读 `spin.json` + Skill 列表推给已打开的设计器；未打开时 no-op。
   *
   * SpinLoop 执行过程中会直接更新磁盘 meta；若设计器仍持有旧缓存，
   * 用户后续保存会覆盖执行结果，因此执行完成后必须刷新。
   * 读取失败时保持当前画布、向窗口推 `spinDesignError`，不 reject。
   */
  refresh(): Promise<void>;
}
