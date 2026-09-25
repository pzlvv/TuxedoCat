/**
 * VS Code 宿主冒烟测试（`npm test`）。
 *
 * 这条车道只放**必须依赖真实 VS Code 宿主**的验证：扩展能否被激活、命令与视图有没有
 * 按 manifest 注册到位。纯逻辑单测不放在这里——它们会 set 全局单例（事件总线、
 * sessionRuntime、projectRoot provider），和同一进程里已经激活的扩展实例会互相污染，
 * 那些用例走 `npm run test:all`。详见 src/test/README.md。
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { COMMAND_PREFIX, EXTENSION_NAME, VIEW_CONTAINER_ID, VIEW_ID } from '../../config/project';

/** 按 package.json 的 name 找本体，避免把 publisher 再硬编码一遍 */
function findSelfExtension(): vscode.Extension<unknown> {
  const found = vscode.extensions.all.find(
    (candidate) => candidate.packageJSON?.name === EXTENSION_NAME,
  );
  assert.ok(
    found,
    `没找到 name=${EXTENSION_NAME} 的扩展；已加载：${vscode.extensions.all
      .map((e) => e.id)
      .sort()
      .join(', ')}`,
  );
  return found;
}

suite('扩展激活', () => {
  test('本体可被激活', async () => {
    const extension = findSelfExtension();
    await extension.activate();
    assert.strictEqual(extension.isActive, true, 'activate() 之后 isActive 应为 true');
  });

  test('open 命令已注册', async () => {
    const commandId = `${COMMAND_PREFIX}.open`;
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(commandId), `命令 ${commandId} 未注册`);
  });

  test('侧栏视图按 manifest 注册', () => {
    const extension = findSelfExtension();
    const views = extension.packageJSON?.contributes?.views?.[VIEW_CONTAINER_ID];
    assert.ok(Array.isArray(views), `manifest 缺少 views.${VIEW_CONTAINER_ID}`);
    assert.ok(
      views.some((view: { id?: string }) => view.id === VIEW_ID),
      `views.${VIEW_CONTAINER_ID} 里没有 ${VIEW_ID}`,
    );
  });
});
