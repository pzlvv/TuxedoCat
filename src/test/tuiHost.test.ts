import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setHostLocale } from '../host/i18n';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { TuiUIHost, numberedTarget, trimUnchanged } from '../tui/TuiUIHost';
import { TuiSpinDesign } from '../tui/TuiSpinDesign';
import { TuiConversationManager } from '../tui/TuiConversationManager';
import { defaultTuiInstallPrefix, resolveTuiExtensionPath, tuiRootCandidates, TUI_ROOT_ENV } from '../tui/coreRoot';
import { createTuiStore, type TuiAction } from '../tui/store';
import { noticeText } from '../tui/i18n';
import {
  applyInput,
  editorText,
  initialEditor,
  insertNewline,
  insertText,
} from '../tui/composerState';
import { createChecker, runTests } from './helpers/harness';

/**
 * TUI 宿主契约与纯逻辑（docs/tui.md 第 5 节映射表的表驱动单测）。
 *
 * 覆盖：TuiUIHost 传输三出口 / 工作区契约 / 主题与 locale / 预览覆盖层（diff 折叠、
 * 上下文裁剪）/ Mermaid 显式不支持 / saveTextFile 命名规则 / closeConversationView
 * 切出语义；TuiSpinDesign、TuiConversationManager；coreRoot 候选与失败指引；
 * 编辑器状态机；notice 翻译。
 *
 * 运行方式：npm run test:all -- tuiHost
 */

runTests('tuiHost', async () => {
  const { check, finish } = createChecker();
  setHostLocale('zh-CN');

  const actions: TuiAction[] = [];
  const logs: string[] = [];
  const store = createTuiStore((line) => logs.push(line));
  const workspace = process.cwd();
  const host = new TuiUIHost({
    workspacePath: workspace,
    log: (...args) => logs.push(args.map(String).join(' ')),
    dispatch: (action) => actions.push(action),
  });

  // ── 传输：三个出口都收敛到 dispatch（单视图退化语义） ──
  host.sendToWebview({ type: 'notice', key: 'k', params: {}, level: 'info' });
  host.broadcastToWebviews({ type: 'notice', key: 'k', params: {}, level: 'info' });
  host.sendToWebviewView({ view: null } as never, { type: 'notice', key: 'k', params: {}, level: 'info' });
  check('三个传输出口都投递 wire 消息', actions.length === 3);

  // ── 工作区契约 ──
  check('getWorkspacePath 返回启动目录', host.getWorkspacePath() === workspace);
  const ref = host.getWorkspaceRef();
  check('getWorkspaceRef 为本地引用', ref?.scheme === 'file' && ref.endpoint === null && ref.path.length > 0);
  check('getOpenWorkspaceRefs 恒为单元素', host.getOpenWorkspaceRefs().length === 1 && host.getOpenWorkspaceRefs()[0] === ref);
  check('onWorkspaceChanged 可取消（no-op 订阅）', host.onWorkspaceChanged(() => {})() === undefined);

  // ── 环境成员 ──
  check('isDarkTheme 恒 true（终端深色基准）', host.isDarkTheme() === true);
  check('getLocale 来自宿主语言收敛', host.getLocale() === 'zh');
  host.log('一条日志');
  check('log 走注入出口不打 stdout', logs.some((line) => line.includes('一条日志')));

  // ── 主题事件 no-op（设计允许：终端不消费） ──
  host.onThemeChanged(null);
  check('onThemeChanged no-op 不产生动作', actions.length === 3);

  // ── 预览覆盖层 ──
  await host.showVirtualDocument('第一行\n第二行', 'doc');
  const docOverlay = actions.find((a) => a.type === 'tui:showOverlay') as
    | { overlay: { kind: string; lines: ReadonlyArray<{ text: string }> } }
    | undefined;
  check('虚拟文档进覆盖层', docOverlay !== undefined
    && docOverlay.overlay.kind === 'document'
    && docOverlay.overlay.lines.length === 2);

  actions.length = 0;
  await host.showDiff({
    filePath: null, newContent: null, title: 'diff',
    beforeContent: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n',
    afterContent: 'a\nb\nc\nX\ne\nf\ng\nh\ni\nj\nk\nY\n',
  });
  const diffAction = actions.find((a) => a.type === 'tui:showOverlay') as
    | { overlay: { kind: string; lines: ReadonlyArray<{ text: string; color: string }> } }
    | undefined;
  check('diff 进覆盖层并带色行', diffAction !== undefined && diffAction.overlay.kind === 'diff'
    && diffAction.overlay.lines.some((l) => l.color === 'green' && l.text.includes('X'))
    && diffAction.overlay.lines.some((l) => l.color === 'red'));
  check('长 diff 等值上下文折叠', diffAction!.overlay.lines.some((l) => l.text.includes('⋯')));

  host.closePreview();
  check('closePreview 投递关闭动作', actions.some((a) => a.type === 'tui:closeOverlay'));

  // ── Mermaid：显式不支持（notice，不静默） ──
  actions.length = 0;
  await host.openMermaidPreview('graph');
  const mermaidNotice = actions.find((a) => a.type === 'tui:notice') as { text: string } | undefined;
  check('Mermaid 预览显式提示不支持', mermaidNotice !== undefined && mermaidNotice.text.includes('Mermaid'));

  // ── SpinDesign：显式提示终端不承载 ──
  actions.length = 0;
  const spin = new TuiSpinDesign((action) => actions.push(action));
  await spin.open();
  await spin.refresh();
  check('Spin 设计器 open/refresh 都提示', actions.filter((a) => a.type === 'tui:notice').length === 2);

  // ── saveTextFile：写入工作目录 + 重名追加序号 ──
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-save-'));
  try {
    const saveHost = new TuiUIHost({ workspacePath: saveDir, log: () => {}, dispatch: () => {} });
    const first = await saveHost.saveTextFile('内容', {
      defaultFileName: 'spin.md', title: 't', filters: [{ name: 'md', extensions: ['md'] }],
    });
    check('首次保存成功', first.success === true && first.success && fs.existsSync(first.filePath));
    const second = await saveHost.saveTextFile('内容2', {
      defaultFileName: 'spin.md', title: 't', filters: [{ name: 'md', extensions: ['md'] }],
    });
    check('重名追加序号', second.success === true && path.basename(second.success ? second.filePath : '').startsWith('spin (1)'));
    check('numberedTarget 纯函数同规则', path.basename(numberedTarget(saveDir, 'a.txt')) === 'a.txt');
    const bad = await new TuiUIHost({
      workspacePath: path.join(saveDir, '不存在的目录'),
      log: () => {}, dispatch: () => {},
    }).saveTextFile('x', { defaultFileName: 'a.txt', title: 't', filters: [] });
    check('写失败如实返回失败分支', bad.success === false && !bad.canceled);
  } finally {
    fs.rmSync(saveDir, { recursive: true, force: true });
  }

  // ── closeConversationView：活动会话切出、其余无显示变化（经真 store 验证；
  //    单独建一个接 store.dispatch 的 host——上面的 host 接的是动作记录器） ──
  const storeHost = new TuiUIHost({
    workspacePath: workspace,
    log: (...args) => logs.push(args.map(String).join(' ')),
    dispatch: (action) => store.dispatch(action),
  });
  store.dispatch({ type: 'tui:activateSession', sessionId: 's1' });
  await storeHost.closeConversationView('别的');
  check('关闭其它会话视图不改活动会话', store.getState().activeSessionId === 's1');
  await storeHost.closeConversationView('s1');
  check('关闭活动会话视图切出到空态', store.getState().activeSessionId === null);

  // ── ConversationManager：两条流写 store ──
  const conv = new TuiConversationManager(host, (action) => store.dispatch(action));
  conv.updateSessionStates([{
    sessionId: 's1', idle: true, waiting: false, queryRunning: false,
    compacting: false, backgroundRunning: false, subAgentRunning: false,
  }]);
  check('运行态流写 store', store.getState().runtimeStates.length === 1
    && store.getState().runtimeStates[0].sessionId === 's1');

  // dispatchList 是 protected：经子类暴露后验证（列表流 → conversationsData）
  class ExposedConversationManager extends TuiConversationManager {
    async dispatchListForTest(list: Parameters<TuiConversationManager['dispatchList']>): Promise<void> {
      return this.dispatchList(...list);
    }
  }
  const exposed = new ExposedConversationManager(host, (action) => store.dispatch(action));
  await exposed.dispatchListForTest([[{
    sessionId: 's2', project: workspace, title: '会话二',
    createdAt: 1, updatedAt: 2, messageCount: 4,
  }]]);
  check('列表流写 store', store.getState().conversations.length === 1
    && store.getState().conversations[0].sessionId === 's2');

  // ── coreRoot：候选顺序与失败指引 ──
  const savedRoot = process.env[TUI_ROOT_ENV];
  const savedHome = process.env.USERPROFILE;
  const savedHome2 = process.env.HOME;
  try {
    process.env[TUI_ROOT_ENV] = 'D:\\explicit\\tui-root';
    check('环境变量优先并去重', tuiRootCandidates('D:\\bundle')[0] === 'D:\\explicit\\tui-root'
      && new Set(tuiRootCandidates('D:\\bundle')).size === tuiRootCandidates('D:\\bundle').length);

    // 伪造安装布局（按当前平台的产物目录名），env 指向它应解析成功
    const fakePrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-prefix-'));
    const pkg = corePlatformDir(process.platform, process.arch);
    if (pkg) {
      const coreDir = path.join(fakePrefix, 'resources', 'core', pkg);
      fs.mkdirSync(coreDir, { recursive: true });
      fs.writeFileSync(path.join(coreDir, coreBinaryFileName(process.platform)), 'fake-core');
      process.env[TUI_ROOT_ENV] = fakePrefix;
      check('安装前缀可解析出 extensionPath', resolveTuiExtensionPath(path.join(os.tmpdir(), 'nope')) === fakePrefix);
    } else {
      check('安装前缀可解析出 extensionPath（本平台无产物目录，跳过）', true);
    }

    // 全部落空：报错含安装指引与环境变量名
    process.env[TUI_ROOT_ENV] = '';
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-home-'));
    process.env.USERPROFILE = emptyHome;
    process.env.HOME = emptyHome;
    let errorMessage = '';
    try {
      resolveTuiExtensionPath(path.join(emptyHome, 'bundle'));
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    check('落空时报错带安装指引', errorMessage.includes(TUI_ROOT_ENV) && errorMessage.includes('build:core'));
    check('默认安装前缀在候选里', tuiRootCandidates('D:\\bundle').includes(defaultTuiInstallPrefix()));
  } finally {
    if (savedRoot === undefined) delete process.env[TUI_ROOT_ENV];
    else process.env[TUI_ROOT_ENV] = savedRoot;
    if (savedHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedHome;
    if (savedHome2 === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome2;
  }

  // ── 编辑器状态机 ──
  let editor = initialEditor();
  editor = applyInput(editor, '你', {});
  editor = applyInput(editor, '好', {});
  check('输入追加', editorText(editor) === '你好' && editor.col === 2);
  editor = applyInput(editor, '', { backspace: true });
  check('退格删除', editorText(editor) === '你');
  editor = insertNewline(editor);
  editor = applyInput(editor, '二行', {});
  check('Ctrl+O 换行后输入', editorText(editor) === '你\n二行' && editor.row === 1);
  editor = applyInput(editor, '', { leftArrow: true });
  editor = applyInput(editor, '', { leftArrow: true });
  editor = applyInput(editor, '', { backspace: true });
  check('行首退格并回上一行', editorText(editor) === '你二行' && editor.row === 0 && editor.col === 1);
  editor = applyInput(editor, '', { rightArrow: true });
  editor = applyInput(editor, '', { rightArrow: true });
  editor = insertText(editor, 'a\nb\nc');
  check('多行粘贴原样保留', editorText(editor) === '你二行a\nb\nc');
  editor = applyInput(editor, '', { upArrow: true });
  check('上箭头跨行并夹取列', editor.row === 1 && editor.col === 1);
  editor = applyInput(editor, '', { tab: true });
  check('Tab 缩进两空格', editorText(editor).includes('  '));

  // ── notice 翻译（zh 字典 + 参数替换；未知键回显） ──
  check('noticeText 参数替换', noticeText('notice.spin.variableNoValueWithNames', { names: 'x、y' }).includes('x、y'));
  check('noticeText 未知键回显', noticeText('no.such.key', {}) === 'no.such.key');

  // ── trimUnchanged：等值行折叠 ──
  const trimmed = trimUnchanged(
    [
      { text: ' a', color: 'gray' }, { text: ' b', color: 'gray' }, { text: ' c', color: 'gray' },
      { text: ' d', color: 'gray' }, { text: '+X', color: 'green' },
      { text: ' e', color: 'gray' }, { text: ' f', color: 'gray' }, { text: ' g', color: 'gray' },
      { text: ' h', color: 'gray' },
    ],
    1,
  );
  check('等值上下文折叠保留变更邻域', trimmed.some((l) => l.text.includes('⋯')) && trimmed.every((l) => l.color !== 'red'));

  finish();
});
