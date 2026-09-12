/**
 * 从同一个真实会话生成「不同长度」的样本集，用于隔离「长度」这一个变量。
 * 切点取用户消息边界，保证每条切片都是一个语义完整的对话前缀
 * （不会把工具调用和它的结果从中间切断）。
 *
 * 输出 length-sweep.json：sessions = [{ name: 'L30', ..., messages: 前 30 条 }, ...]
 * 用法: node make-length-sweep.mjs [--src=big-sessions.json] [--session=<name>] [--out=length-sweep.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');

const srcFile = arg('src', 'big-sessions.json');
const outFile = arg('out', 'length-sweep.json');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, srcFile), 'utf8'));

// 默认选 UI 消息最多、且工具种类最全的那个会话
const pick = arg('session', '');
let base = pick ? data.sessions.find((s) => s.name.includes(pick)) : null;
if (!base) base = data.sessions.reduce((a, b) => (b.messages.length > a.messages.length ? b : a));

const msgs = base.messages;
const boundaries = [];
msgs.forEach((m, i) => { if (m.role === 'user') boundaries.push(i); });
// 切片长度 = 每个用户消息的起点（跳过 0）+ 总长度；
// 再补几个更短的前缀（首个用户轮次有 93 条，短样本按消息数直接切）。
const extra = (arg('extra', '10,30,60') || '').split(',').map(Number).filter((n) => n > 0 && n < msgs.length);
const cuts = [...new Set(extra.concat(boundaries.filter((i) => i > 0), [msgs.length]))].sort((a, b) => a - b);

const sessions = cuts.map((n) => {
  const slice = msgs.slice(0, n);
  const byRole = {};
  for (const m of slice) byRole[m.role] = (byRole[m.role] || 0) + 1;
  const byTool = {};
  for (const m of slice) if (m.role === 'toolcall') byTool[m.toolName] = (byTool[m.toolName] || 0) + 1;
  const contentKB = Math.round(slice.reduce((a, m) => a + (m.content?.length || 0), 0) / 1024);
  return {
    ...base,
    name: `L${String(n).padStart(4, '0')}`,
    srcSession: base.name,
    messages: slice,
    stats: { messages: n, byRole, byTool, contentKB },
  };
});

fs.writeFileSync(path.join(__dirname, outFile), JSON.stringify({ sessions }));
console.log(`源会话: ${base.name.split('/').pop()}（共 ${msgs.length} 条 UI 消息，${boundaries.length} 个用户轮次）`);
console.log(`生成 ${sessions.length} 个切片 → ${outFile}`);
console.log('切片: ' + sessions.map((s) => s.name.replace('L0', 'L')).join(' '));
for (const s of sessions) {
  console.log(
    `  ${s.name.padEnd(7)} 消息 ${String(s.stats.messages).padStart(4)}` +
    `  内容 ${String(s.stats.contentKB).padStart(5)}KB` +
    `  user=${s.stats.byRole.user || 0} thinking=${s.stats.byRole.thinking || 0} tool=${s.stats.byRole.toolcall || 0} assistant=${s.stats.byRole.assistant || 0}` +
    `  ${Object.entries(s.stats.byTool).map(([k, v]) => k + ':' + v).join(' ')}`,
  );
}
