#!/usr/bin/env node

/**
 * 测试后台任务完成通知链路
 * 
 * 验证: enqueueAgentMessage → messageConsumer → flushAgentQueue → mutableMessages
 */

import { setProjectRootProvider, setExtensionPathProvider } from '../core/history/Config.js';
import { execCommand } from '../core/tools/bash/Exec.js';
import { getBackgroundTaskStatus } from '../core/tools/bash/LocalShellTask.js';

setProjectRootProvider(() => process.cwd());
setExtensionPathProvider(() => process.cwd());

async function testNotifyEngine() {
  console.log('=== Test: notifyEngine directly ===\n');

  // 动态导入 notifyEngine 内部使用的模块
  // 先看看 sessionEngines 是否可用
  try {
    const qe = await import('../core/QueryEngine.js');
    console.log('sessionEngines exists:', !!qe.sessionEngines);
    console.log('sessionEngines size:', qe.sessionEngines?.size);
    
    if (qe.sessionEngines && qe.sessionEngines.size > 0) {
      for (const [sessionId, engine] of qe.sessionEngines) {
        console.log(`  Engine: ${sessionId}`);
        console.log(`  has enqueueAgentMessage: ${typeof engine.enqueueAgentMessage}`);
        console.log(`  agentMessageQueue.length before: ${engine.agentMessageQueue?.length}`);
        
        // 直接调用 enqueueAgentMessage
        console.log('\n  Calling enqueueAgentMessage...');
        engine.enqueueAgentMessage('Test notification from background task');
        
        console.log(`  agentMessageQueue.length after: ${engine.agentMessageQueue?.length}`);
        
        // 等待消费循环处理
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log(`  mutableMessages after flush: ${engine['mutableMessages']?.length}`);
        const lastMsg = engine['mutableMessages']?.[engine['mutableMessages']?.length - 1];
        if (lastMsg) {
          console.log(`  Last message content: ${(lastMsg as any).message?.content?.substring(0, 100)}`);
        }
      }
    } else {
      console.log('No active engines found (expected when running standalone)');
      
      // 手动创建一个 engine 来测试
      console.log('\n  Creating a test engine...');
      const { QueryEngine } = qe;
      const { CLIUI } = await import('../cli/CliUI.js');
      const { getAllTools } = await import('../core/tools/index.js');
      
      const ui = new CLIUI();
      
      // 设置全局 UI
      const { setGlobalUI } = await import('../core/AssistantUI.js');
      setGlobalUI(ui);
      
      const engine = new QueryEngine('test-bg-session', {
        cwd: process.cwd(),
        tools: getAllTools(),
        getAppState: () => ({}),
        setAppState: () => {},
        initialMessages: [],
        ui,
      });
      
      console.log(`  Engine created: test-bg-session`);
      console.log(`  has enqueueAgentMessage: ${typeof engine.enqueueAgentMessage}`);
      console.log(`  agentMessageQueue.length before: ${engine.agentMessageQueue?.length}`);
      
      // 直接调用 enqueueAgentMessage
      console.log('\n  Calling enqueueAgentMessage...');
      engine.enqueueAgentMessage('Test notification from background task');
      
      console.log(`  agentMessageQueue.length after: ${engine.agentMessageQueue?.length}`);
      
      // 等待消费循环处理
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      console.log(`  mutableMessages after flush: ${engine['mutableMessages']?.length}`);
      const lastMsg = engine['mutableMessages']?.[engine['mutableMessages']?.length - 1];
      if (lastMsg) {
        console.log(`  Last message content: ${(lastMsg as any).message?.content?.substring(0, 100)}`);
      } else {
        console.log('  No message was flushed!');
      }
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

async function testLocalShellTaskNotify() {
  console.log('\n=== Test: LocalShellTask notifyEngine ===\n');
  
  // 使用 execCommand 后台执行，触发完整的通知链路
  console.log('Running background command via execCommand...');
  
  const result = await execCommand({
    command: 'echo "BG_TEST_DONE"',
    timeout: 10000,
    signal: new AbortController().signal,
    runInBackground: true,
    description: 'test-notify-engine',
    toolUseId: 'test-notify-tool',
    agentId: 'test-agent',
  });
  
  console.log(`backgroundTaskId: ${result.backgroundTaskId}`);
  
  if (result.backgroundTaskId) {
    // 等待任务完成
    console.log('Waiting for background task to complete...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const status = getBackgroundTaskStatus(result.backgroundTaskId);
    console.log(`Task status: ${status?.status}`);
    console.log(`Exit code: ${status?.exitCode}`);
  }
  
  console.log('\n=== Test complete ===');
}

testNotifyEngine().then(() => testLocalShellTaskNotify()).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
