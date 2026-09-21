/**
 * 空状态背景图（logo1.png … logo7.png）的随机轮换。
 *
 * 规则（按「新对话」计数，每开一次新对话轮换一次）：
 *   - **N 次正好覆盖全部 N 张**：每轮把 N 张洗成一个随机排列（洗牌袋），依次取出，
 *     一轮内不重复、一轮取完恰好每张出现一次；
 *   - **相邻两次不同**：袋内天然不同；换新一轮时若洗出的第一张恰好是上一轮最后一张，
 *     就把它和后面随机一张换位，保证跨轮边界也不同。
 *
 * 轮换时机（只在这些明确时机调用，不要放进会反复执行的渲染路径）：
 *   - 页面加载：没有绑定会话的视图就是「新对话」视图（Electron 每个新会话一个视图，
 *     后台预热视图也在这里轮换），见 Main.tsx；
 *   - 单视图内点「+」新建对话：见 App.tsx 的 handleNewConversation；
 *   - 切换/打开会话时的 loading 动画出现：见 ConversationLoading（每个挂载周期轮换一张，
 *     让 loading 动画与随后露出的空状态背景图都是随机且一致的那张）。
 *
 * 候选 URI 只借用宿主注入的 window.logoUri 定位**目录**（取最后一个 `/` 之前的部分），
 * 再拼上候选文件名：宿主不需要知道有哪几张背景图，新增一张只改 LOGO_FILES，
 * 换基准文件名也不用改宿主。
 *
 * 轮换状态（上一次展示的 + 本轮剩余）记在 localStorage —— Electron 每个新对话都是
 * 一个新页面，只记「上一次」不够，必须把本轮没取完的袋一起带走，跨页面才能凑满一轮。
 * 存的是文件名而不是 URI，宿主换了资源路径（扩展被移动/升级、Electron 换了安装目录）
 * 也依然能对上；localStorage 不可用（沙箱/隐私模式）时退化为「仅本页成轮」，
 * 不抛错、不影响展示。
 */
import { getLogoUri } from './webviewEnv';
import { EXTENSION_NAME } from '../config/project';

/** 背景图候选文件名（与宿主注入的基准图同目录，随 public/ 一起构建进 dist/webview） */
const LOGO_FILES = [
  'logo1.png',
  'logo2.png',
  'logo3.png',
  'logo4.png',
  'logo5.png',
  'logo6.png',
  'logo7.png',
] as const;

type LogoFile = (typeof LOGO_FILES)[number];

/** 轮换状态：一轮 = N 张的一个随机排列，逐张取出 */
interface LogoCycle {
  /** 上一次展示的文件名；null = 还没有过（首次） */
  last: LogoFile | null;
  /** 本轮还没展示的候选（顺序即展示顺序）；空 = 该开新一轮了 */
  bag: LogoFile[];
}

const STORAGE_KEY = `${EXTENSION_NAME}:placeholder-logo`;

/** 本页的轮换状态；null = 还没读过（首次使用时从 localStorage 载入） */
let cycle: LogoCycle | null = null;

/** 宿主注入 URI 所在目录（含结尾 `/`）；注入的是裸文件名（无 `/`）时返回空串 */
function assetDirPrefix(): string {
  const base = getLogoUri();
  const at = base.lastIndexOf('/');
  return at < 0 ? '' : base.slice(0, at + 1);
}

/** 候选文件名 → 完整 URI */
function uriOfFile(file: string): string {
  return assetDirPrefix() + file;
}

/** 候选白名单校验（localStorage 里的记录可能来自旧版本，如 logo.png → logo1.png） */
function isKnownFile(file: unknown): file is LogoFile {
  return typeof file === 'string' && (LOGO_FILES as readonly string[]).includes(file);
}

/**
 * 洗一轮：把 N 张打乱成随机排列。
 * 若洗出的第一张与上一轮最后一张相同，与后面随机一张换位 —— 跨轮边界也不能相邻相同。
 */
function shuffledBag(previous: LogoFile | null): LogoFile[] {
  const bag = [...LOGO_FILES];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  if (previous !== null && bag.length > 1 && bag[0] === previous) {
    const j = 1 + Math.floor(Math.random() * (bag.length - 1));
    [bag[0], bag[j]] = [bag[j], bag[0]];
  }
  return bag;
}

function readCycle(): LogoCycle {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { last: null, bag: [] };
  }
  if (!raw) return { last: null, bag: [] };
  // 旧版本只存了「上一次」这一个裸文件名（没有 JSON）：按「本轮剩余为空」迁移
  if (!raw.startsWith('{')) {
    return { last: isKnownFile(raw) ? raw : null, bag: [] };
  }
  try {
    const parsed = JSON.parse(raw) as { last?: unknown; bag?: unknown };
    return {
      last: isKnownFile(parsed.last) ? parsed.last : null,
      bag: Array.isArray(parsed.bag) ? parsed.bag.filter(isKnownFile) : [],
    };
  } catch {
    return { last: null, bag: [] };
  }
}

function writeCycle(value: LogoCycle): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 写不进去不影响本页展示：本页仍按内存里的袋轮换，只是跨页面可能重新开轮
  }
}

/** 取本页轮换状态；首次调用从 localStorage 载入 */
function currentCycle(): LogoCycle {
  if (cycle === null) cycle = readCycle();
  return cycle;
}

/**
 * 轮换到下一张背景图：从本轮袋里取下一张，取空了就洗新的一轮。
 *
 * 只应在明确的轮换时机调用（页面加载 / 点「+」/ loading 动画挂载），
 * 不要放进会反复执行的渲染路径，否则每次重渲染都会换图。
 */
export function rotatePlaceholderLogo(): void {
  const current = currentCycle();
  if (current.bag.length === 0) current.bag = shuffledBag(current.last);
  const next = current.bag.shift()!;
  current.last = next;
  writeCycle(current);
}

/**
 * 当前应展示的背景图 URI。
 *
 * 本页轮换过就是本轮刚取出的那张；否则（例如直接打开一个已有会话）
 * 沿用上一次展示的，不在这里轮换、也不写盘 —— 轮换只属于「新对话」。
 */
export function getPlaceholderLogoUri(): string {
  return uriOfFile(currentCycle().last ?? LOGO_FILES[0]);
}
