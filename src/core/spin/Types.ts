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
  role?: string
  /** 该节点执行前需要依次加载的 Skill 名称列表 */
  skills?: string[]
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
}

/** spin.json 顶层结构（流程图编辑器保存+执行状态） */
export interface SpinDesign {
  nodes: SpinNode[]
  edges: SpinEdge[]
  meta: Record<string, SpinNodeMeta>  // nodeId -> execution state
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
