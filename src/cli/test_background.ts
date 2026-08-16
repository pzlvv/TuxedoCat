#!/usr/bin/env node

/**
 * 测试 Bash 后台执行功能
 * 
 * 直接测试 execCommand 的后台模式，不经过 LLM 层
 * 验证 task notification 是否能正确触发
 */

import { execCommand } from '../core/tools/bash/Exec.js';
import { setProjectRootProvider, setExtensionPathProvider } from '../core/history/Config.js';

// 配置基础设施
setProjectRootProvider(() => process.cwd());
setExtensionPathProvider(() => process.cwd());

async function test() {
  console.log('=== Test: Bash background execution ===\n');

  // 1. 测试前台执行（快速命令）
  console.log('1. Testing foreground command (echo)...');
  const foregroundResult = await execCommand({
    command: 'echo "hello world"',
    timeout: 5000,
    signal: new AbortController().signal,
  });
  console.log(`   stdout: ${foregroundResult.stdout}`);
  console.log(`   exitCode: ${foregroundResult.exitCode}`);
  console.log(`   interrupted: ${foregroundResult.interrupted}`);
  console.log(`   backgroundTaskId: ${foregroundResult.backgroundTaskId}`);
  console.log();

  // 2. 测试后台执行（sleep）
  console.log('2. Testing background command (sleep 3)...');
  const bgResult = await execCommand({
    command: 'echo "start" && sleep 3 && echo "done"',
    timeout: 10000,
    signal: new AbortController().signal,
    runInBackground: true,
    description: 'test-sleep-3',
    toolUseId: 'test-tool-use',
    agentId: 'test-agent',
  });
  console.log(`   stdout: "${bgResult.stdout}"`);
  console.log(`   exitCode: ${bgResult.exitCode}`);
  console.log(`   backgroundTaskId: ${bgResult.backgroundTaskId}`);
  console.log(`   assistantAutoBackgrounded: ${bgResult.assistantAutoBackgrounded}`);

  if (bgResult.backgroundTaskId) {
    console.log(`\n   Background task registered: ${bgResult.backgroundTaskId}`);
    console.log('   Waiting for task to complete (5 seconds)...');
    
    // 等待后台任务完成
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 检查任务状态
    const { getBackgroundTaskStatus } = await import('../core/tools/bash/LocalShellTask.js');
    const status = getBackgroundTaskStatus(bgResult.backgroundTaskId);
    
    if (status) {
      console.log(`\n   Task status: ${status.status}`);
      console.log(`   Exit code: ${status.exitCode}`);
      console.log(`   Duration: ${status.endTime ? status.endTime - status.startTime : 'N/A'}ms`);
      
      // 读取输出文件
      const { readFile } = await import('fs/promises');
      try {
        const output = await readFile(status.shellCommand?.taskOutput?.path ?? '', 'utf-8');
        console.log(`   Output file content: "${output.trim()}"`);
      } catch {
        console.log('   Output file not found');
      }
    } else {
      console.log('   Task not found in registry');
    }
  }
  console.log();

  // 3. 测试自动转后台（长时间运行的命令 + 短超时）
  console.log('3. Testing auto-background (long command, short timeout)...');
  const autoBgResult = await execCommand({
    command: 'echo "auto-start" && sleep 4 && echo "auto-done"',
    timeout: 1000, // 1秒就超时，自动转后台
    signal: new AbortController().signal,
    description: 'test-auto-bg',
    toolUseId: 'test-tool-use-2',
    agentId: 'test-agent',
  });
  console.log(`   assistantAutoBackgrounded: ${autoBgResult.assistantAutoBackgrounded}`);
  console.log(`   backgroundTaskId: ${autoBgResult.backgroundTaskId}`);
  if (autoBgResult.backgroundTaskId) {
    console.log('   Waiting for auto-backgrounded task to complete (6 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    const { getBackgroundTaskStatus } = await import('../core/tools/bash/LocalShellTask.js');
    const status = getBackgroundTaskStatus(autoBgResult.backgroundTaskId);
    if (status) {
      console.log(`   Task status: ${status.status}`);
      console.log(`   Exit code: ${status.exitCode}`);
    }
  }
  console.log();

  // 4. 检查所有后台任务
  const { getAllBackgroundTasks } = await import('../core/tools/bash/LocalShellTask.js');
  const allTasks = getAllBackgroundTasks();
  console.log(`All background tasks: ${allTasks.length}`);
  for (const task of allTasks) {
    console.log(`  - ${task.taskId}: ${task.status} (${task.description})`);
  }

  console.log('\n=== Test complete ===');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
