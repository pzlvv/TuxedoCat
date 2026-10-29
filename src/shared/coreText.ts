/**
 * Core 面向界面的文案键（`docs/architecture/core-ui-separation.md` 第 4.8 / 4.9 节）。
 *
 * Core 不感知语言：瞬时状态提示以「键 + 参数」表达，经 `CoreEvent.notice` 交给 UI
 * 翻译；内置命令的描述同样以键表达。这些键必须在 UI 翻译表里存在，由
 * `src/test/coreTextParity.test.ts` 对照 `src/test/fixtures/coreTextKeys.json` 锁定，
 * Rust 侧由 `core-rs/src/core_text_tests.rs` 读同一份对照表。
 *
 * 落盘文本（进 JSONL / LLM 上下文）不在这里：那部分一律英文常量，不参与键化。
 */

/** 瞬时状态提示的键（`CoreEvent.notice.key`） */
export const CoreNoticeKeys = {
  /** `/spin` 未接线（单测 / 未装配的宿主） */
  spinEngineNotWired: 'notice.spin.engineNotWired',
  /** 没有 spin.json 设计文件 */
  spinDesignMissing: 'notice.spin.designMissing',
  /** 有设计文件但读不出来 */
  spinCannotRead: 'notice.spin.cannotRead',
  /** 设计存在空节点 */
  spinEmptyNode: 'notice.spin.emptyNode',
  /** 设计不是 DAG */
  spinNotDag: 'notice.spin.notDag',
  /** 存在未赋值的变量（不带变量名） */
  spinVariableNoValue: 'notice.spin.variableNoValue',
  /** 存在未赋值的变量（`{names}` 为变量名列表） */
  spinVariableNoValueWithNames: 'notice.spin.variableNoValueWithNames',
  /** spin.json 格式不合法 */
  spinInvalid: 'notice.spin.invalid',
  /** Spin 主循环跑完 */
  spinAllCompleted: 'notice.spin.allCompleted',
  /** 会话被其他实例独占打开（specs/032 FR-001，装载被拒；`{pid}` 为持有者进程） */
  sessionLockedOpen: 'notice.session.lockedOpen',
  /** 会话被其他实例独占、变更被拒（specs/032 FR-002；`{pid}` 为持有者进程） */
  sessionLockedChange: 'notice.session.lockedChange',
} as const;

/** 内置命令描述的键（斜杠补全列表的 `description`） */
export const CoreCommandDescriptionKeys = {
  spin: 'command.spin.description',
} as const;

/** Core 用到的全部界面文案键 */
export const CORE_TEXT_KEYS: readonly string[] = [
  ...Object.values(CoreNoticeKeys),
  ...Object.values(CoreCommandDescriptionKeys),
];

/** 瞬时提示的级别 */
export type NoticeLevel = 'info' | 'warn' | 'error';

/** 瞬时提示的占位符取值 */
export type NoticeParams = Readonly<Record<string, string | number>>;
