/**
 * 流式输出「退化重复」检测器
 *
 * 背景：
 * 模型偶尔会陷入退化循环，把同一段内容反复输出，直到把 max_output_tokens 占满。
 * 例如：
 *   - 单字符：`哈哈哈哈…`、`........`、`\n\n\n\n…`
 *   - 短语：  `I'll check the file. I'll check the file. …`
 *   - 整段：  同一段话/同一段代码重复几十遍
 *
 * 这类响应属于服务端异常，既浪费 token 又污染上下文，应在流式阶段就发现并丢弃重试。
 *
 * ---------------------------------------------------------------------------
 * 判定语义
 * ---------------------------------------------------------------------------
 * 「连续重复 K 次」= 存在块长 p ≥ 1，使流的末尾恰好是 u^K（u 是长度 p 的块）。
 * 难点在于 p 未知，且**不对齐**：重复单元不会落在任何固定网格上，还可能跨行、
 * 跨 content block（同一句话被切成多个 block）。
 *
 * ---------------------------------------------------------------------------
 * 算法：尾部窗口 + 反转串 Z 函数
 * ---------------------------------------------------------------------------
 * 设累积文本 S（长度 n），取尾窗反转 R = reverse(S[n-W .. n))，
 * 对 R 求 Z 数组（z[i] = R 与 R[i..] 的最长公共前缀长度），则：
 *
 *     S 末尾连续出现 K 个长度为 p 的相同块   ⟺   z[p] ≥ (K-1)·p
 *
 * 证明：S 末尾 = u^K（|u| = p）→ 反转后 R 开头 = reverse(u)^K →
 * R[0..(K-1)p) 与 R[p..Kp) 逐字符相同 → 两者 LCP ≥ (K-1)p → z[p] ≥ (K-1)p。
 * 反向：该不等式说明 R[0..Kp) 有周期 p，而长度 Kp、周期 p 的串必然是某个
 * p 长块的 K 次重复。
 *
 * 这个写法的好处：
 *   1. 一次 O(W) 扫描同时覆盖所有候选块长 p，不需要枚举、不需要「整除」
 *   2. 天然处理不对齐的重复单元
 *   3. 天然忽略窗口头部混入的循环前正常内容 —— 比对的是 R 的**前缀**
 *      （对应 S 的**末尾**），前面的正常内容落在 R 的尾部，不参与判定
 *   4. 精确，无哈希碰撞
 *
 * 不采用的方案及原因：
 *   - 压缩率/熵：贵、阈值难调，且给不出「重复了多少次」这个语义
 *   - 固定块长哈希：单元长度不能整除块长时会漏检
 *   - 整窗最小周期（KMP 前缀函数）：窗口混有循环前内容时整窗周期不会小，漏检
 */

/** 尾窗长度：可检出的最大重复单元长度 = windowSize / minRepeats */
export const DEFAULT_REPETITION_WINDOW = 16_384;
/** 连续重复次数阈值 */
export const DEFAULT_REPETITION_MIN_REPEATS = 50;
/** 重复片段的最小总长度（字符），与 minRepeats 取更严格者 */
export const DEFAULT_REPETITION_MIN_SPAN = 200;
/** 累积长度低于该值不做检测（避免短输出误报） */
export const DEFAULT_REPETITION_MIN_CHECK_LENGTH = 5_000;
/** 两次检测之间至少要新增的字符数（节流，避免每 chunk 都跑 O(W)） */
export const DEFAULT_REPETITION_CHECK_INTERVAL = 128;
/** 重复检测触发的重试次数上限（独立于网络错误与超时看门狗） */
export const DEFAULT_MAX_REPETITION_RETRIES = 1;

/** 被检测的流类型 */
export type RepetitionStream = 'text' | 'thinking';

export interface RepetitionDetectorOptions {
  windowSize?: number;
  minRepeats?: number;
  minSpan?: number;
  minCheckLength?: number;
  checkInterval?: number;
}

/** 一次命中的详情，用于日志与错误信息 */
export interface RepetitionHit {
  /** 重复单元长度 */
  unitLength: number;
  /** 观测到的连续重复次数（下界） */
  repeatCount: number;
  /** 重复片段总长度 = unitLength * repeatCount */
  spanLength: number;
  /** 重复单元内容预览 */
  unitPreview: string;
  /** 触发时的累积总长度 */
  totalLength: number;
}

/**
 * 退化重复错误。
 *
 * 刻意不使用 `AbortError` 作为 name：上层会把 AbortError 视为「用户主动取消」
 * 而静默丢弃，这里必须走错误上报路径并触发重试。
 */
export class LLMRepetitionError extends Error {
  readonly stream: RepetitionStream;
  readonly hit: RepetitionHit;

  constructor(stream: RepetitionStream, hit: RepetitionHit) {
    super(
      `检测到模型循环输出：${stream === 'thinking' ? '思考' : '正文'}中长度 ${hit.unitLength} 的片段` +
      `连续重复 ${hit.repeatCount} 次（共 ${hit.spanLength} 字符），判定为服务端异常`,
    );
    this.name = 'LLMRepetitionError';
    this.stream = stream;
    this.hit = hit;
  }
}

/**
 * 计算「反转串 R」的 Z 数组，其中 R[i] === tail[n - 1 - i]。
 *
 * 直接用映射索引访问原串，避免为每次检测构造一个 16KB 的反转字符串。
 * 算法本身是标准 Z 算法，摊还 O(n)。
 */
function computeZOnReversed(tail: string, n: number, z: Int32Array): void {
  z[0] = n;
  let l = 0;
  let r = 0;
  for (let i = 1; i < n; i++) {
    let k = 0;
    if (i < r) {
      const reuse = z[i - l];
      k = r - i < reuse ? r - i : reuse;
    }
    while (
      i + k < n &&
      tail.charCodeAt(n - 1 - k) === tail.charCodeAt(n - 1 - i - k)
    ) {
      k++;
    }
    z[i] = k;
    if (i + k > r) {
      l = i;
      r = i + k;
    }
  }
}

/**
 * 单个流（正文 / 思考）的重复检测器。
 *
 * 用法：每次拿到增量文本就 `append(delta)`，返回非 null 表示命中。
 * 生命周期为「单次请求的单个流」，重试时必须新建（不要跨重试复用）。
 */
export class RepetitionDetector {
  private readonly windowSize: number;
  private readonly minRepeats: number;
  private readonly minSpan: number;
  private readonly minCheckLength: number;
  private readonly checkInterval: number;

  /** 尾部缓冲：长度介于 [windowSize, 2*windowSize]，摊还 O(1) 裁剪 */
  private buffer = '';
  /** 累积总长度（不受窗口裁剪影响） */
  private totalLength = 0;
  /** 上次检测时的总长度，用于节流 */
  private lastCheckLength = 0;
  /** 复用的 Z 数组，避免每次检测都分配 16KB */
  private z = new Int32Array(0);

  constructor(options: RepetitionDetectorOptions = {}) {
    this.windowSize = options.windowSize ?? DEFAULT_REPETITION_WINDOW;
    this.minRepeats = options.minRepeats ?? DEFAULT_REPETITION_MIN_REPEATS;
    this.minSpan = options.minSpan ?? DEFAULT_REPETITION_MIN_SPAN;
    this.minCheckLength = options.minCheckLength ?? DEFAULT_REPETITION_MIN_CHECK_LENGTH;
    this.checkInterval = options.checkInterval ?? DEFAULT_REPETITION_CHECK_INTERVAL;
  }

  /**
   * 追加一段增量文本。
   * @returns 命中时返回重复详情，否则返回 null
   */
  append(delta: string): RepetitionHit | null {
    if (!delta) return null;

    this.buffer += delta;
    this.totalLength += delta.length;

    // 尾窗裁剪：留 2 倍余量再裁，避免每 chunk 都做一次 O(W) 复制
    if (this.buffer.length > this.windowSize * 2) {
      this.buffer = this.buffer.slice(-this.windowSize);
    }

    // 短输出不检测；检测本身按新增字符数节流
    if (this.totalLength < this.minCheckLength) return null;
    if (this.totalLength - this.lastCheckLength < this.checkInterval) return null;
    this.lastCheckLength = this.totalLength;

    return this.detect();
  }

  /** 当前累积总长度（含已被窗口裁掉的部分） */
  get length(): number {
    return this.totalLength;
  }

  private detect(): RepetitionHit | null {
    const tail = this.buffer.length > this.windowSize
      ? this.buffer.slice(-this.windowSize)
      : this.buffer;
    const n = tail.length;
    if (n < this.minRepeats) return null;

    if (this.z.length < n) this.z = new Int32Array(n);
    const z = this.z;
    computeZOnReversed(tail, n, z);

    // 至少要能放下 minRepeats 个块
    const maxUnit = Math.floor(n / this.minRepeats);
    for (let p = 1; p <= maxUnit; p++) {
      // 需要的重复次数：minRepeats 与「重复片段至少 minSpan 字符」取更严格者
      const required = Math.max(this.minRepeats, Math.ceil(this.minSpan / p));
      const need = (required - 1) * p;
      if (need + p > n) continue;
      if (z[p] >= need) {
        const repeatCount = Math.floor(z[p] / p) + 1;
        return {
          unitLength: p,
          repeatCount,
          spanLength: p * repeatCount,
          unitPreview: tail.slice(n - p),
          totalLength: this.totalLength,
        };
      }
    }
    return null;
  }
}

/**
 * 便捷封装：追加增量并校验，命中直接抛 LLMRepetitionError。
 * 三个适配器共用，避免每处都写一遍 throw。
 */
export function checkRepetition(
  detector: RepetitionDetector,
  delta: string,
  stream: RepetitionStream,
): void {
  const hit = detector.append(delta);
  if (hit) throw new LLMRepetitionError(stream, hit);
}
