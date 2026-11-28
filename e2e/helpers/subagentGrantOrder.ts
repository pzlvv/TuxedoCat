/**
 * 子代理「槽位授予顺序」的观测与判定（US-49 FIFO 断言，specs/defects/
 * us49-fifo-assertion-reads-first-request-order.md）。
 *
 * 为什么单独一层纯函数：产品的 FIFO 保证点是**槽位预留转移**
 * （`core-rs/src/subagent.rs` 的 `enter_slot_queue` / `hand_off_reservation`），
 * 而「子代理发出首个 LLM 请求」远在若干级线程与现实 I/O 之后
 * （预留 → 后台线程 → 建 meta / 注册 / emit → 再起驱动线程 → 组提示词 → 发请求），
 * 每一段都没有顺序依赖。把判定写成「按 mock 记录的 `startedAt` 排序」等于断言一个
 * 产品从未承诺的事实——CI 上因此概率性读到 `[6, 5]`（run `45089008241`）。
 *
 * 观测点取子会话 id 里的 `now_millis()` 前缀：`generate_sub_session_id` 的形态是
 * `sub_<millis>_<suffix>`，该毫秒值就是「拿到预留后创建会话」的时刻，与
 * `enter_slot_queue` 的授予点一一对应，且随 meta.json 落在磁盘上（不需要产品新增
 * 任何 wire 事件或契约成员）。
 */

/** 子会话 id 的形态：`sub_<millis>_<suffix>`（`core-rs/src/subagent.rs` 的 `generate_sub_session_id`） */
const SUB_SESSION_ID = /^sub_(\d+)_/;

/** Agent 工具的 description 形态：`任务<编号>`（e2e 脚本的固定写法） */
const TASK_DESCRIPTION = /^任务(\d+)$/;

/** 一条子代理的落盘事实：`description` 即子会话 meta.json 的 `title` */
export interface SubAgentGrant {
  /** Agent 工具的 description（子会话 `meta.json` 的 `title`，如「任务5」） */
  description: string;
  /** 子会话 id（`sub_<millis>_<suffix>`） */
  sessionId: string;
}

/** 从子会话 id 取出槽位授予时刻（毫秒）；不是子会话 id 的形态返回 `null` */
export function parseGrantMillis(sessionId: string): number | null {
  const matched = SUB_SESSION_ID.exec(sessionId);
  return matched ? Number(matched[1]) : null;
}

/** 从 description 取出脚本里的任务编号；不匹配返回 `null` */
export function parseTaskNumber(description: string): number | null {
  const matched = TASK_DESCRIPTION.exec(description);
  return matched ? Number(matched[1]) : null;
}

/**
 * 按槽位授予时刻升序排列（先获预留者在前）。
 *
 * 取不到授予时刻 / 任务编号直接抛错而不是排到末尾：那种情况说明读到的不是子会话
 * （接线或选择器错了），静默降级只会把「没观测到」伪装成「顺序正确」。
 */
export function grantOrder(grants: readonly SubAgentGrant[]): SubAgentGrant[] {
  return grants
    .map((grant) => ({ grant, millis: requireMillis(grant) }))
    .sort((left, right) => left.millis - right.millis)
    .map((entry) => entry.grant);
}

function requireMillis(grant: SubAgentGrant): number {
  const millis = parseGrantMillis(grant.sessionId);
  if (millis === null) {
    throw new Error(`不是子会话 id 形态，取不到槽位授予时刻：${grant.sessionId}`);
  }
  return millis;
}

function requireTask(grant: SubAgentGrant): number {
  const task = parseTaskNumber(grant.description);
  if (task === null) {
    throw new Error(`子会话 description 不是「任务<编号>」形态：${grant.description}`);
  }
  return task;
}

/**
 * 排队者是否按发起顺序拿到槽位预留（US-49 验收 2 要锁的语义）。
 *
 * 只校验 `queuedTasks` 给出的任务**彼此之间**的先后：它们由脚本跨轮发起，产品承诺
 * 按发起顺序授予。首轮并发直取的那批（同一轮 `tools` 批）相互之间本来就不承诺
 * 顺序，`queuedTasks` 之外的任务一律不参与比较。
 *
 * 返回空数组即顺序正确。注意本函数**完全不看 mock 的请求到达时刻**：把首请求顺序
 * 反过来喂给它，结果不变——这正是上一次修复的要害
 * （`specs/defects/us49-fifo-assertion-reads-first-request-order.md`）。
 *
 * **同毫秒不判违规**：观测用的是 `now_millis()`，它的分辨率是产品实现的细节，产品从未
 * 承诺「相邻两次授予必然落在不同毫秒」。排队者被连续放行时两次授予同毫秒是可发生的
 * 真实形态（`sub_<millis>_<suffix>` 的毫秒值在拿到预留**之后**、经 `on_grant` 后台
 * 线程才取，中间几段无顺序依赖）。把同毫秒报成缺陷等于断言一个产品没承诺的事实，
 * CI 上因此两次误报（一次报「同一毫秒先后无法观测」、一次读成 `[6, 5]`）。
 * 这里按「先后未知但不违规」处理——只在**看到反序证据**（后发起者的授予时刻严格更早）
 * 时才报破坏，那是产品语义确实被违反的形态。
 *
 * **毫秒差还可能被线程调度翻过来**（`specs/defects/
 * us49-fifo-grant-observed-through-thread-scheduling.md`）：产品的授予顺序由
 * `hand_off_reservation` 按 `waiters` 顺序敲定（正确），但毫秒是**在后台线程里**
 * 取的（`on_grant` → `create_sub_agent` → `generate_sub_session_id`），两个排队者
 * 连续放行时后唤醒者完全可能先跑到那一行。因此「严格更早」只在差值足够大时才可信。
 * 本函数本身不设阈值——阈值取决于机器，写死会把慢机变成常红；余量由用例侧拉开各
 * 排队者的执行时长来保证（`subagentConcurrency.spec.ts` 给任务 5 更长的 `delayMs`）。
 * 保留判定语义，让真出现反序证据时仍然报红。
 */
export function queuedGrantViolations(
  grants: readonly SubAgentGrant[],
  queuedTasks: readonly number[],
): string[] {
  const millisByTask = new Map<number, number>();
  for (const grant of grants) {
    const task = requireTask(grant);
    if (!queuedTasks.includes(task)) continue;
    millisByTask.set(task, requireMillis(grant));
  }
  const problems: string[] = [];
  // 缺席只报一次：双层循环会把同一个缺席任务在每个外层轮次里重复报一遍
  for (const task of queuedTasks) {
    if (!millisByTask.has(task)) {
      problems.push(`任务${task} 没有出现在子会话落盘记录里（排队者未启动）`);
    }
  }
  for (let index = 0; index < queuedTasks.length; index += 1) {
    const earlierTask = queuedTasks[index];
    const earlierMillis = millisByTask.get(earlierTask);
    if (earlierMillis === undefined) continue;
    for (let next = index + 1; next < queuedTasks.length; next += 1) {
      const laterTask = queuedTasks[next];
      const laterMillis = millisByTask.get(laterTask);
      if (laterMillis === undefined) continue;
      // 只认「严格更早」为破坏；同毫秒不构成反序证据（见函数头注释）
      if (laterMillis < earlierMillis) {
        problems.push(
          `任务${laterTask} 比任务${earlierTask} 更晚发起却先拿到槽位预留（FIFO 破坏）`,
        );
      }
    }
  }
  return problems;
}
