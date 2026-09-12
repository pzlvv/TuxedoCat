/**
 * 预处理脚本：把 ~/.tuxedo-cat/conversations 下的 JSONL 会话文件
 * 转换为 webview Message[]（完整复刻 useMessageHandler.ts 中
 * conversationLoaded 的恢复逻辑 + VSCodeUI.postConversationLoaded 的
 * _meta 裁剪逻辑），并附带扩展端统计信息（消息条数、原始字节数）。
 *
 * 用法: node preprocess.js <output.json>
 * 输出: { sessions: [{ name, file, rawBytes, rawMessages, messages, toolMetaMap }] }
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONV_ROOT = path.join(os.homedir(), '.tuxedo-cat', 'conversations');

// ── 精简版 buildEditDiffHunks 前置统计（不真正 diff，只记录行数）──────
// 真正的 diff 在 webview bundle 内由 harness 的 runtime 逻辑执行，
// 这里只做数据准备。

function loadJsonl(fp) {
  const content = fs.readFileSync(fp, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  const messageMap = new Map();
  const updates = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'tool_use_update') {
        updates.push(parsed);
        continue;
      }
      if (parsed && typeof parsed.uuid === 'string') {
        messageMap.set(parsed.uuid, parsed);
      }
    } catch {
      /* skip corrupted line */
    }
  }
  // parentUuid 链 + BFS（与 Conversation.loadConversation 一致）
  const childrenMap = new Map();
  const roots = [];
  for (const stored of messageMap.values()) {
    if (stored.parentUuid && messageMap.has(stored.parentUuid)) {
      let ch = childrenMap.get(stored.parentUuid);
      if (!ch) { ch = []; childrenMap.set(stored.parentUuid, ch); }
      ch.push(stored);
    } else {
      roots.push(stored);
    }
  }
  roots.sort((a, b) => a.timestamp - b.timestamp);
  const messages = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift();
    messages.push(cur.message);
    const ch = childrenMap.get(cur.uuid);
    if (ch) {
      ch.sort((a, b) => a.timestamp - b.timestamp);
      queue.push(...ch);
    }
  }
  // 回放 tool_use 更新
  for (const upd of updates) {
    for (const msg of messages) {
      if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) continue;
      for (const block of msg.message.content) {
        if (block && block.type === 'tool_use' && block.id === upd.toolUseId) {
          if (upd.input) block.input = upd.input;
          if (upd.meta) {
            if (!block._meta || typeof block._meta !== 'object') block._meta = {};
            Object.assign(block._meta, upd.meta);
          }
        }
      }
    }
  }
  return messages;
}

// ── 复刻 VSCodeUI.postConversationLoaded 的 _meta 裁剪 ────────────────
// 注意：这里无法运行 vscode-diff（Edit 的 diffHunks 由 harness 在浏览器
// 端用 bundle 内的 buildEditDiffHunks 计算），所以 Edit 工具的 beforeContent/
// afterContent 原样传给 harness，由 harness 调 buildEditDiffHunks 生成
// diffHunks 后再注入（与扩展端行为等价）。
function trimMeta(messages) {
  const toolMetaMap = {};
  const filtered = messages.filter((m) => !m.isMeta && !m.silent);
  for (const msg of filtered) {
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use' && block._meta) {
          block._metaTrimmed = true;
          block._toolUseId = block.id;
          const rawMeta = block._meta;
          const { beforeContent, afterContent, ...smallFields } = rawMeta;
          block._meta = smallFields;
          // 与扩展端不同：Edit 的 diffHunks 由 harness 在 bundle 内计算，
          // 因此把 before/after 暂存到独立字段，由 runtime 处理
          if (block.name === 'Edit') {
            toolMetaMap[block.id] = { beforeContent, afterContent, __needsDiff: true };
          } else {
            toolMetaMap[block.id] = { beforeContent, afterContent };
          }
        }
      }
    }
  }
  return { messages: filtered, toolMetaMap };
}

// ── 复刻 useMessageHandler conversationLoaded 的消息转换 ──────────────
function extractUserContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), images: [] };
  const textParts = [];
  const images = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    if (block.type === 'image' && block.source?.type === 'base64' && typeof block.source?.data === 'string') {
      const mediaType = block.source.media_type || 'image/png';
      images.push({ dataUrl: `data:${mediaType};base64,${block.source.data}`, mediaType });
    }
  }
  return { text: textParts.join('\n'), images };
}

function restoreMessages(rawMessages, toolMetaMap) {
  const toolResultMap = new Map();
  const canceledToolResults = new Map();
  for (const convMsg of rawMessages) {
    if (convMsg.type === 'user' && Array.isArray(convMsg.message?.content)) {
      for (const block of convMsg.message.content) {
        if (block.type === 'tool_result') {
          if (block.is_canceled === true) {
            if (block.tool_use_id) canceledToolResults.set(block.tool_use_id, block.content || '');
            continue;
          }
          toolResultMap.set(block.tool_use_id, {
            content: Array.isArray(block.content) ? '[Image]' : block.content || '',
            exitCode: block.exit_code ?? 0,
            timestamp: typeof convMsg.timestamp === 'number' ? convMsg.timestamp : undefined,
          });
        }
      }
    }
  }

  const restored = [];
  for (const convMsg of rawMessages) {
    if (convMsg.type === 'stream_request_start') continue;
    const msgTimestamp = typeof convMsg.timestamp === 'number' ? convMsg.timestamp : Date.now();

    if (convMsg.type === 'system') {
      if (convMsg.subtype === 'compact_boundary') continue;
      restored.push({ role: 'system', content: convMsg.content || '', timestamp: msgTimestamp });
      continue;
    }

    if (convMsg.type === 'user') {
      const content = convMsg.message?.content;
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
      const msgMeta = convMsg._meta;
      const isFromAgent = convMsg.fromSubAgent === true;
      if (convMsg.silent === true) continue;
      const rawFilePath = convMsg.filePath || msgMeta?.filePath || undefined;
      const rawFileSelectedLines = convMsg.fileSelectedLines || msgMeta?.fileSelectedLines || undefined;
      const wasFileHidden = convMsg.fileHidden === true;
      const showFileInfo = !wasFileHidden && !!rawFilePath;
      const msgMetaClean = msgMeta ? { ...msgMeta } : undefined;
      if (msgMetaClean) {
        if (showFileInfo) {
          msgMetaClean.filePath = rawFilePath;
          if (rawFileSelectedLines) msgMetaClean.fileSelectedLines = rawFileSelectedLines;
        } else {
          delete msgMetaClean.filePath;
          delete msgMetaClean.fileSelectedLines;
          if (!isFromAgent) delete msgMetaClean.param;
        }
      }
      const msgParam = isFromAgent ? msgMeta?.param : undefined;
      const { text, images } = extractUserContent(content);
      restored.push({
        role: 'user',
        content: text,
        images: images.length > 0 ? images : undefined,
        param: msgParam,
        filePath: showFileInfo ? rawFilePath : undefined,
        fileSelectedLines: showFileInfo ? rawFileSelectedLines : undefined,
        isCompactSummary: convMsg.isCompactSummary === true,
        isFromAgent,
        meta: msgMetaClean,
        timestamp: msgTimestamp,
      });
      continue;
    }

    if (convMsg.type === 'assistant') {
      if (convMsg.silent === true) continue;
      const blocks = convMsg.message?.content || [];
      for (const block of blocks) {
        if (block.type === 'thinking') {
          restored.push({ role: 'thinking', content: block.thinking || '', timestamp: msgTimestamp });
        } else if (block.type === 'text') {
          restored.push({ role: 'assistant', content: block.text, timestamp: msgTimestamp });
        } else if (block.type === 'tool_use') {
          const toolUseId = block.id;
          const canceledContent = canceledToolResults.get(toolUseId);
          if (canceledContent !== undefined) {
            restored.push({
              role: 'toolcall', content: canceledContent, param: `⚙️ ${block.name}`,
              toolName: block.name, toolArgs: block.input || {}, toolCallId: toolUseId,
              status: 'fail', timestamp: msgTimestamp,
            });
            continue;
          }
          const result = toolResultMap.get(toolUseId);
          const hasResult = result !== undefined;
          const isPending = (convMsg.pendingToolUseIds || []).includes(toolUseId);
          let status = 'running';
          if (hasResult) status = result.exitCode !== 0 ? 'fail' : 'success';
          else if (isPending) status = 'normal';

          const blockMeta = block._meta;
          const metaTrimmed = block._metaTrimmed === true;
          const preloadedMeta = toolMetaMap?.[toolUseId];
          const toolArgs = block.input || {};

          if (block.name === 'Write' && toolArgs.content) {
            const c = String(toolArgs.content);
            if (!toolArgs.contentPreview) toolArgs.contentPreview = c;
            if (!toolArgs.totalLines) toolArgs.totalLines = c.split('\n').length;
            if (toolArgs.isTruncated === undefined) toolArgs.isTruncated = false;
          }

          if (blockMeta || preloadedMeta) {
            if (metaTrimmed) {
              toolArgs.contextBefore = blockMeta?.contextBefore || [];
              toolArgs.contextAfter = blockMeta?.contextAfter || [];
              toolArgs.startLine = blockMeta?.startLine;
              toolArgs.endLine = blockMeta?.endLine;

              if (block.name === 'Edit') {
                const diffHunks = preloadedMeta?.diffHunks || blockMeta?.diffHunks || [];
                toolArgs.diffHunks = diffHunks;
                if (diffHunks.length === 0) {
                  const bc = blockMeta?.beforeContent || '';
                  const ac = blockMeta?.afterContent || '';
                  if (bc || ac) {
                    toolArgs.beforeContent = bc;
                    toolArgs.afterContent = ac;
                  } else if (!preloadedMeta) {
                    toolArgs._needsMeta = true;
                    toolArgs._toolUseId = block._toolUseId || toolUseId;
                  }
                }
              } else {
                const bc = preloadedMeta?.beforeContent || blockMeta?.beforeContent || '';
                const ac = preloadedMeta?.afterContent || blockMeta?.afterContent || '';
                toolArgs.beforeContent = bc;
                toolArgs.afterContent = ac;
                if (!preloadedMeta && !bc && !ac) {
                  toolArgs._needsMeta = true;
                  toolArgs._toolUseId = block._toolUseId || toolUseId;
                }
              }
            } else {
              toolArgs.beforeContent = blockMeta?.beforeContent || '';
              toolArgs.afterContent = blockMeta?.afterContent || '';
              toolArgs.contextBefore = blockMeta?.contextBefore || [];
              toolArgs.contextAfter = blockMeta?.contextAfter || [];
              toolArgs.startLine = blockMeta?.startLine;
              toolArgs.endLine = blockMeta?.endLine;
            }
          }

          restored.push({
            role: 'toolcall',
            content: result?.content || '',
            param: `⚙️ ${block.name}`,
            toolName: block.name,
            toolArgs,
            toolCallId: toolUseId,
            status,
            timestamp: msgTimestamp,
            toolResultTimestamp: result?.timestamp,
          });
        }
      }
    }
  }
  return restored;
}

// ── 主流程：扫描会话目录，挑选代表性会话 ─────────────────────────────
const dirs = fs.readdirSync(CONV_ROOT)
  .map((d) => path.join(CONV_ROOT, d))
  .filter((d) => fs.statSync(d).isDirectory());

const all = [];
for (const dir of dirs) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('archive'));
  for (const f of files) {
    const fp = path.join(dir, f);
    const size = fs.statSync(fp).size;
    all.push({ dir, file: f, fp, size });
  }
}
all.sort((a, b) => a.size - b.size);
console.log('All sessions (by size):');
for (const s of all) console.log(`  ${String(s.size).padStart(10)} B  ${s.dir.split(path.sep).pop()}/${s.file}`);

// 选取样本：最大、中等（~500KB、~2MB）、最小
const picked = new Map();
function pick(s) {
  if (s && !picked.has(s.fp)) picked.set(s.fp, s);
}
const topArg = process.argv.find((a) => a.startsWith('--top='));
if (topArg) {
  // --top=N: 取最大的 N 个会话（用于"大对话"专项分析）
  const N = Number(topArg.split('=')[1]);
  for (let i = 0; i < N && i < all.length; i++) pick(all[all.length - 1 - i]);
} else {
  pick(all[all.length - 1]);                       // 最大
  pick(all.find((s) => s.size > 2 * 1024 * 1024)); // >2MB
  pick(all.find((s) => s.size > 800 * 1024));      // ~1MB
  pick(all.find((s) => s.size > 400 * 1024));      // ~500KB
  pick(all.find((s) => s.size > 100 * 1024));      // ~150KB
  pick(all.find((s) => s.size > 50 * 1024));       // ~100KB
  pick(all[0]);                                    // 最小
}

const sessions = [];
for (const s of picked.values()) {
  if (!s) continue;
  const rawMessages = loadJsonl(s.fp);
  const { messages: trimmed, toolMetaMap } = trimMeta(rawMessages);
  const restored = restoreMessages(trimmed, toolMetaMap);
  // Edit 的 diffHunks 需要在 bundle 内计算（vscode-diff 是 ESM 包，浏览器可用）
  // 标记哪些 toolUseId 需要运行时 diff
  const editDiffNeeded = {};
  for (const [id, meta] of Object.entries(toolMetaMap)) {
    if (meta && meta.__needsDiff) editDiffNeeded[id] = { beforeContent: meta.beforeContent || '', afterContent: meta.afterContent || '' };
  }
  const proj = path.basename(s.dir);
  sessions.push({
    name: `${proj}/${s.file}`,
    file: s.fp,
    rawBytes: s.size,
    rawMessages: trimmed.length,
    messages: restored,
    editDiffNeeded,
    toolMetaMap: undefined,
  });
  console.log(`\n${proj}/${s.file}`);
  console.log(`  raw bytes=${(s.size / 1024).toFixed(0)}KB rawMessages=${trimmed.length} uiMessages=${restored.length}`);
  const byRole = {};
  for (const m of restored) byRole[m.role] = (byRole[m.role] || 0) + 1;
  console.log('  byRole:', JSON.stringify(byRole));
  const byTool = {};
  for (const m of restored) if (m.role === 'toolcall') byTool[m.toolName] = (byTool[m.toolName] || 0) + 1;
  console.log('  byTool:', JSON.stringify(byTool));
  const contentBytes = restored.reduce((acc, m) => acc + (m.content?.length || 0), 0);
  const argsBytes = restored.reduce((acc, m) => acc + JSON.stringify(m.toolArgs || {}).length, 0);
  console.log(`  contentChars=${(contentBytes / 1024).toFixed(0)}KB toolArgsChars=${(argsBytes / 1024).toFixed(0)}KB`);
}

const outPath = process.argv[2];
fs.writeFileSync(outPath, JSON.stringify({ sessions }));
console.log(`\nWrote ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);

// ── 附加模式：--edits=<outfile> 扫描全部会话，导出所有 Edit 工具的 diff 输入 ──
// 用于离线统计「EditFile diff 实际渲染行数」的全局最大值（不依赖浏览器渲染）。
const editsArg = process.argv.find((a) => a.startsWith('--edits='));
if (editsArg) {
  const outFile = editsArg.split('=')[1];
  const edits = [];
  let scanned = 0;
  for (const s of all) {
    scanned++;
    let rawMessages;
    try {
      rawMessages = loadJsonl(s.fp);
    } catch {
      continue;
    }
    const { messages: trimmed, toolMetaMap } = trimMeta(rawMessages);
    const restored = restoreMessages(trimmed, toolMetaMap);
    for (const m of restored) {
      if (m.role !== 'toolcall' || m.toolName !== 'Edit') continue;
      const args = m.toolArgs || {};
      const meta = m.toolCallId ? toolMetaMap[m.toolCallId] : null;
      const before = args.beforeContent ?? meta?.beforeContent;
      const after = args.afterContent ?? meta?.afterContent;
      if (typeof before !== 'string' || typeof after !== 'string') continue;
      edits.push({
        session: `${path.basename(s.dir)}/${s.file}`,
        file: args.file_path || '',
        startLine: args.startLine,
        endLine: args.endLine,
        replaceAll: Boolean(args.replace_all),
        beforeContent: before,
        afterContent: after,
      });
    }
    if (scanned % 20 === 0) console.log(`  ... 已扫描 ${scanned}/${all.length} 个会话，累计 Edit ${edits.length} 个`);
  }
  fs.writeFileSync(outFile, JSON.stringify(edits));
  console.log(`\n扫描 ${all.length} 个会话，导出 ${edits.length} 个 Edit 输入 → ${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB)`);
}
