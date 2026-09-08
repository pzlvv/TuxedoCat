/**
 * Spin Design 类型定义
 *
 * Spin Design 是产品（PRODUCT_NAME）内置的流程图式任务编排系统。
 * 它读取项目根目录的 spin.json，按拓扑顺序逐个执行节点任务，
 * 每次迭代起一个子代理完成一个节点。
 */

/** 流程图中的单个节点 */
export interface SpinNode {
  id: number
  x: number
  y: number
  task: string
  criteria: string[]
  /** rollout 执行次数，默认 1；每次执行会注入不同的 ${ROLLOUT_ID}（从 0 开始） */
  rollout?: number
  /** For Each 遍历的用户变量名；非空时按该变量的每一行执行，且验收标准不参与 */
  forEach?: string
  role?: string
  /** 该节点执行前需要依次加载的 Skill 名称列表 */
  skills?: string[]
  /** 节点标题（可选，仅用于 Spin Design 画布展示，不参与执行） */
  title?: string
}

/** 节点间的连线 */
export interface SpinEdge {
  from: number
  to: number
  fromSide?: string
  toSide?: string
}

/** 单个节点的执行状态 */
export interface SpinNodeMeta {
  passed: boolean
  note: string
  /** 已完成的迭代数量；For Each 行与 rollout 统一按迭代计数（一行内先完成全部 rollout） */
  rolloutPassed?: number
}

/** spin.json 顶层结构（流程图编辑器保存+执行状态） */
export interface SpinDesign {
  nodes: SpinNode[]
  edges: SpinEdge[]
  meta: Record<string, SpinNodeMeta>  // nodeId -> execution state
  /** 用户定义的变量（key -> value），可在节点描述/验收标准中以 ${KEY} 引用 */
  variables?: Record<string, string>
  /** 变量说明/注释（key -> description），仅用于 Spin Design 展示，不参与执行 */
  variableComments?: Record<string, string>
}

/** spinCommand 消息载荷 */
export interface SpinCommandPayload {
  type: 'spinCommand'
  sessionId: string
  cmd: 'init' | 'status' | 'run'
  args?: string
}

/** spinInit 消息载荷（扩展端注入到主对话的 prompt） */
export interface SpinInitPayload {
  type: 'spinInit'
  sessionId: string
}
