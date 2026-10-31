/**
 * 单测：远程工作区路径的尾分隔符归一（`src/host/workspaceRef.ts`）。
 *
 * 缺陷场景（specs/defects/remote-workspace-trailing-slash-splits-identity.md）：
 * 远程目录选择器把用户敲进路径框的目录原样交给宿主——路径框里的目录**始终带尾分隔符**
 * （`electron/remoteWorkspace/pathInput.ts` 的 `ensureTrailingSeparator`，
 * `docs/core/core-remote.md` 第 2.6 节），daemon 回显的 `listing.path` 也保留用户
 * 输入的原样（`core-rs/src/remote.rs` 的 `list_directories` 用
 * `requested.to_string_lossy()`）。于是同一个目录会以 `/srv/app/` 与 `/srv/app`
 * 两种写法进入打开集合：
 *
 * - `workspaceRefKey`（Connection 身份、标签页 id）逐字拼路径 → 两种写法是两个键，
 *   `Client.openWorkspace` 为同一个目录建**两条** Connection；
 * - `sameWorkspaceRef` 远程分支逐字比较 → `findWorkspace` 判不出重复，打开集合里出现
 *   同一目录的两张标签页；
 * - Core 侧的对话空间目录按 `encodeURIComponent(path)` 派生
 *   （`core-rs/src/config.rs` 的 `project_conversation_dir`），`%2Fsrv%2Fapp%2F` 与
 *   `%2Fsrv%2Fapp` 是两个空间 → 同一目录的对话列表裂成两份。
 *
 * 口径的**唯一**判据就在本模块：`sameRemotePath` 的文档写明「只抹平末尾分隔符差异」
 * 并给出理由——「工作区引用与对话元数据可能一个带尾斜杠、一个不带，逐字比较会把同一个
 * 目录判成两个」。构造与反序列化必须用同一份归一，身份键才有同一份输入。
 *
 * 运行方式：npm run test:unit -- remoteWorkspacePath
 */

import * as assert from 'assert';
import {
  remoteWorkspaceRef,
  sameRemotePath,
  sameWorkspaceRef,
  workspacePathMatches,
  workspaceRefKey,
  workspaceRefKeyMatches,
  type WorkspaceEndpoint,
} from '../host/workspaceRef';
import { parseWorkspaceEntry, serializeWorkspaceRef } from '../host/workspaceState';
import { createChecker, runTests } from './helpers/harness';

function endpoint(host = '192.168.1.10', port = 22, password = 'pw'): WorkspaceEndpoint {
  return { host, port, user: 'root', auth: { kind: 'sshPassword', password } };
}

/** 落盘往返：序列化 → JSON → 反序列化（与真实 `workspace-state.json` 同口径） */
function roundTrip(path: string): string | null {
  const ref = remoteWorkspaceRef(endpoint(), path);
  const persisted = JSON.parse(JSON.stringify(serializeWorkspaceRef(ref)));
  return parseWorkspaceEntry(persisted, () => true)?.path ?? null;
}

function run(): void {
  const { check, finish } = createChecker();

  // ---------------- RT-1：构造即归一 ----------------

  const trailing = remoteWorkspaceRef(endpoint(), '/srv/app/');
  const plain = remoteWorkspaceRef(endpoint(), '/srv/app');
  assert.strictEqual(trailing.path, '/srv/app', '构造时去掉尾分隔符');
  assert.strictEqual(
    workspaceRefKey(trailing),
    workspaceRefKey(plain),
    '同一目录的两种写法必须得到同一个 Connection 键（修复前不等）',
  );
  assert.ok(
    sameWorkspaceRef(trailing, plain),
    '同一目录的两种写法必须判等，打开集合里不出现第二张标签页（修复前为假）',
  );
  check('RT-1 构造时归一去尾分隔符，身份键与判等一致', true);

  // ---------------- RT-2：根路径不能剥成空串 ----------------

  assert.strictEqual(remoteWorkspaceRef(endpoint(), '/').path, '/', '根路径保持 /');
  check('RT-2 远程根路径 / 原样保留', true);

  // ---------------- RT-3：落盘恢复同样归一 ----------------

  assert.strictEqual(
    roundTrip('/srv/app/'),
    '/srv/app',
    '旧状态文件里带尾分隔符的远程项恢复后必须归一（修复前保留尾斜杠）',
  );
  assert.strictEqual(roundTrip('/srv/app'), '/srv/app', '无尾分隔符的远程项往返不变');
  assert.strictEqual(roundTrip('/'), '/', '根路径往返不变');
  check('RT-3 反序列化同样归一去尾分隔符', true);

  // ---------------- RT-4：多个尾分隔符收敛成一个都不剩 ----------------

  for (const path of ['/srv/app//', '/srv/app///']) {
    assert.strictEqual(
      remoteWorkspaceRef(endpoint(), path).path,
      '/srv/app',
      `多余尾分隔符全部去掉：${path}`,
    );
  }
  check('RT-4 连续的尾分隔符全部去掉', true);

  // ---------------- RT-5：对话空间目录不再裂成两份 ----------------

  const encoded = (path: string): string => encodeURIComponent(path);
  assert.strictEqual(
    encoded(roundTrip('/srv/app/') ?? ''),
    encoded('/srv/app'),
    'Core 侧对话空间目录（encodeURIComponent(path)）必须只有一个',
  );
  check('RT-5 同一目录只对应一个对话空间目录', true);

  // ---------------- RT-6：既有判等语义不变 ----------------

  assert.ok(sameRemotePath('/srv/app/', '/srv/app'), 'sameRemotePath 仍抹平尾分隔符差异');
  assert.ok(!sameRemotePath('/srv/app', '/srv/other'), '不同目录仍不相等');
  assert.ok(
    workspacePathMatches(remoteWorkspaceRef(endpoint(), '/srv/app/'), '/srv/app'),
    '会话工作目录归属判定不受归一影响',
  );
  assert.strictEqual(remoteWorkspaceRef(endpoint(), '/srv/app/').scheme, 'ssh', 'scheme 原样保留');
  assert.strictEqual(
    remoteWorkspaceRef(endpoint(), '/srv/app/').endpoint?.host,
    '192.168.1.10',
    'endpoint 原样保留',
  );
  check('RT-6 判等 / 归属 / scheme / endpoint 语义不变', true);

  // ---------------- RT-7：各机器的同名目录不被归一混淆 ----------------

  const machineA = remoteWorkspaceRef(endpoint('10.0.0.1'), '/srv/app/');
  const machineB = remoteWorkspaceRef(endpoint('10.0.0.2'), '/srv/app/');
  assert.notStrictEqual(
    workspaceRefKey(machineA),
    workspaceRefKey(machineB),
    '同一路径在不同主机上是两个工作区',
  );
  assert.ok(!sameWorkspaceRef(machineA, machineB), '同一路径在不同主机上不判等');
  check('RT-7 归一只作用于路径，不混淆不同主机', true);

  // ---------------- RT-8：落盘的旧 activeWorkspaceKey 仍能认回活动项 ----------------

  const plainRef = remoteWorkspaceRef(endpoint(), '/srv/app');
  const legacyKey = `${workspaceRefKey(plainRef)}/`;
  assert.strictEqual(
    legacyKey,
    'ssh//root@192.168.1.10:22/srv/app/',
    '旧键形态与被归一前的实现逐字一致（末尾多一个 /）',
  );
  assert.ok(
    workspaceRefKeyMatches(plainRef, legacyKey),
    '归一之前写下的远程活动键必须仍能认回该工作区（修复前逐字比较失配，活动标签页回落）',
  );
  assert.ok(
    workspaceRefKeyMatches(plainRef, workspaceRefKey(plainRef)),
    '当前形态的键照常命中',
  );
  check('RT-8 旧 activeWorkspaceKey 兼容', true);

  // ---------------- RT-9：兼容只放行「末尾多一个 /」，不放大命中面 ----------------

  assert.ok(
    !workspaceRefKeyMatches(plainRef, 'ssh//root@192.168.1.10:22/srv/ap'),
    '不能前缀匹配',
  );
  assert.ok(
    !workspaceRefKeyMatches(plainRef, 'ssh//root@192.168.1.10:22/other/app/'),
    '不能匹配别的目录',
  );
  const rootRef = remoteWorkspaceRef(endpoint(), '/');
  assert.strictEqual(workspaceRefKey(rootRef), 'ssh//root@192.168.1.10:22/', '根路径的键以 / 结尾');
  assert.ok(
    !workspaceRefKeyMatches(rootRef, 'ssh//root@192.168.1.10:22//'),
    '根路径不再接受双斜杠键（那条历史形态不存在）',
  );
  check('RT-9 兼容窗口只覆盖末尾多一个 /', true);

  finish();
}

runTests('remoteWorkspacePath', run);
