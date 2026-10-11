/**
 * SpinDesign - Spin 设计器的宿主契约（第二个 UI surface）
 *
 * 与 UIHost 分开的理由（docs/contracts.md 第 2 节）：
 * 1. 独立面板/窗口（VS Code: WebviewPanel；Electron: BrowserWindow），
 *    生命周期与消息协议都与对话 webview 无关；
 * 2. UIHost 已经有很多成员，再混进 2 个 Spin 专属成员会让「宿主能力」失真；
 * 3. 拆出后 Spin 的整块（HTML 生成 + 导出 + 面板管理）可整体替换或搬走。
 *
 * 构造依赖：constructor(host: UIHost)。实现只用其中 5 个成员——
 * getWorkspacePath()（定位 spin.json）、isDarkTheme() / getLocale()（生成 HTML）、
 * saveTextFile()（导出）、log()。不反向要求 UIHost 知道 Spin 的存在。
 *
 * 设计器消息协议（设计器 ↔ 宿主，不走 AssistantEventBus）：
 * - 设计器 → 宿主：refreshSpinDesign / saveSpinDesign / exportSpinDesign
 * - 宿主 → 设计器：spinDesignData / spinSaveResult / spinExportResult
 */

/** Spin 设计器的宿主契约。 */
export interface SpinDesign {
  /**
   * 打开设计器；已打开则复用（**目录不同则切到新目录的数据**），不重复创建。
   *
   * @param workspacePath 发起方会话的工作目录——spin.json 与技能清单都归属它。
   *   多工作目录宿主（Electron）里不能回退到「活动工作目录」：设计器是单例窗口，
   *   从别的标签页再 `/spin` 时活动目录可能已经变了。不传时回退宿主的活动工作目录
   *   （兼容旧调用 / 无会话场景）。
   */
  open(workspacePath?: string): Promise<void>;

  /**
   * 从磁盘重读 spin.json + Skill 列表推给已打开的设计器；未打开时 no-op。
   *
   * SpinLoop 执行过程中会直接更新磁盘 meta；若设计器仍持有旧缓存，
   * 用户后续保存会覆盖执行结果，因此执行完成后必须刷新。
   */
  refresh(): Promise<void>;
}
