/**
 * Standalone Core 的帧协议（见 docs/core/standalone-core.md 第 6 节）。
 *
 * 编码：UTF-8，换行（`\n`）分隔的 JSON，一行一帧。
 * 帧内换行以 JSON 转义表达，帧边界只由 `\n` 决定。
 *
 * 本模块只做编解码与帧校验，不含进程与业务逻辑，无宿主依赖。
 */

import type { CoreEvent, CoreRequest, UiEvent, UiRequest } from '../../shared/AssistantEventBus.js';
import { stringifyJsonSafe } from '../../shared/utils/stringUtils.js';
import { StringDecoder } from 'node:string_decoder';

/**
 * 协议版本；握手时由 Core 校验。
 *
 * 2：新增 UI → core 的请求方向（`UiToCoreFrame.request` / `CoreToUiFrame.response`）。
 */
export const CORE_PROTOCOL_VERSION = 2;

// ==================== 帧类型 ====================

/** UI → Core */
export type UiToCoreFrame =
  | { kind: 'hello'; protocol: number }
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | { kind: 'uiEvent'; event: UiEvent }
  /** UI → core 的请求；Core 以 `response` 帧回同 id */
  | { kind: 'request'; id: number; request: UiRequest }
  | { kind: 'shutdown' };

/** Core → UI */
export type CoreToUiFrame =
  | { kind: 'ready' }
  | { kind: 'event'; event: CoreEvent }
  | { kind: 'request'; id: number; request: CoreRequest }
  /** core → UI 请求的应答；也用于回 UI → core 请求 */
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string };

/** 两侧帧的并集（解码器产出、编码器接受） */
export type Frame = UiToCoreFrame | CoreToUiFrame;

// ==================== 编码 ====================

/**
 * 编码一帧；返回值以 `\n` 结尾，可直接写入帧通道。
 *
 * 走 `stringifyJsonSafe`：帧里会带对话消息（含工具输出预览），一旦混进孤立代理项，
 * Core 侧 serde_json 会**直接拒绝整帧**（严格解析器不允许 `\ude00`），表现为
 * Core 卡死/丢消息。这里在出口兜底。
 */
export function encodeFrame(frame: Frame): string {
  return `${stringifyJsonSafe(frame)}\n`;
}

// ==================== 校验 ====================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判别字段 `kind` 的取值；非帧结构返回 null */
export function frameKind(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  return typeof kind === 'string' ? kind : null;
}

export function isCoreToUiFrame(value: unknown): value is CoreToUiFrame {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'ready':
      return true;
    case 'event':
      return isRecord(value['event']);
    case 'request':
      return typeof value['id'] === 'number' && isRecord(value['request']);
    case 'response':
      return isResponseFrame(value);
    default:
      return false;
  }
}

export function isUiToCoreFrame(value: unknown): value is UiToCoreFrame {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'hello':
      return typeof value['protocol'] === 'number';
    case 'response':
      return isResponseFrame(value);
    case 'uiEvent':
      return isRecord(value['event']);
    case 'request':
      return typeof value['id'] === 'number' && isRecord(value['request']);
    case 'shutdown':
      return true;
    default:
      return false;
  }
}

/** `response` 帧的结构校验（两个方向共用） */
function isResponseFrame(value: Record<string, unknown>): boolean {
  return (
    typeof value['id'] === 'number' &&
    typeof value['ok'] === 'boolean' &&
    (value['ok'] === true ? 'result' in value : typeof value['error'] === 'string')
  );
}

// ==================== 解码 ====================

export interface FrameDecoderOptions {
  /** 收到一帧合法 JSON（尚未做方向校验） */
  onFrame(value: unknown): void;
  /** 行不是合法 JSON */
  onError(error: Error): void;
}

/**
 * 换行分隔 JSON 的增量解码器。
 *
 * 输入是任意切分的字节块；按 `\n` 切分并缓存残行。空行跳过。
 * 单行 JSON 解析失败只报告该行，不中断后续行。
 *
 * 字节块走 `StringDecoder` 而不是 `chunk.toString('utf8')`：一个多字节 UTF-8 字符
 * 完全可能被 TCP / SSH 通道切在两次 `push` 之间，逐块解码会把两半各自换成 U+FFFD。
 * 替换字符是合法字符，`JSON.parse` 照样成功——坏掉的文本因此**静默**流进 Core 与 UI
 * （日志乱码、对话正文出现 `�`），不留任何错误记录
 * （specs/defects/frame-decoder-splits-multibyte-chunks.md）。
 *
 * 残行按**分片数组**累积、只在成行时 `join` 一次：帧大小没有上限
 * （docs/core/standalone-core.md 第 5.1 节），而会话应答是整段历史一个帧——
 * 若在单个字符串上 `+=` 累积，每块都要把已收内容重拷一遍，总拷贝量与帧长平方成正比
 * （specs/defects/frame-decoder-quadratic-buffer-copy.md）。分片累积让成本与帧长线性。
 */
export class FrameDecoder {
  /**
   * 尚未成行的分片（按到达顺序）。
   *
   * 用数组而不是拼接的字符串：`+=` 在残行持续增长时每块整段重拷，大帧因此是 O(n²)。
   * 压栈是平摊 O(1)，`join` 每行只做一次。
   */
  private pending: string[] = [];
  /**
   * 跨块暂存半个 UTF-8 字符的解码器。
   *
   * `reset` 会换一个新实例：`StringDecoder` 没有公开的「丢弃余量」入口，而重启进程
   * 时必须把上一段字节流留下的半字符一起丢掉，否则它会与重启后的第一块拼在一起，
   * 解出一个凭空多出来的字符。
   */
  private decoder = new StringDecoder('utf8');

  constructor(private readonly options: FrameDecoderOptions) {}

  /** 丢弃残行与未完成的字符（重启进程时调用） */
  reset(): void {
    this.pending = [];
    this.decoder = new StringDecoder('utf8');
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let start = 0;
    for (;;) {
      const index = text.indexOf('\n', start);
      if (index < 0) {
        // 没有换行：余下部分留在分片里，等下一块
        if (start < text.length) this.pending.push(text.slice(start));
        return;
      }
      // 本行的前半段；整行只有这一段时（残行为空）不必 join，省一次拷贝
      const head = text.slice(start, index);
      const line = this.pending.length === 0 ? head : this.pending.join('') + head;
      this.pending = [];
      this.decodeLine(line);
      start = index + 1;
      // 正好以换行结尾：循环下一轮 `indexOf` 返回 -1，走上面的返回分支
    }
  }

  private decodeLine(line: string): void {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.length === 0) return;
    try {
      this.options.onFrame(JSON.parse(trimmed));
    } catch (error) {
      this.options.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
