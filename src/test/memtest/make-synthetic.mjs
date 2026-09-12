/**
 * 生成"多语言"合成会话，用于验证 Shiki 按需加载：
 * 覆盖 懒加载语言（php / ruby / scss / haskell / dockerfile / tsx）
 * 与 需保持正常的语言（typescript / json）。
 *
 * 输出 sessions-synthetic.json，结构与 preprocess.js 一致（供 harness 直接消费）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PHP_BEFORE = `<?php
namespace App\\Service;

class UserService
{
    private $repository;

    public function __construct(UserRepository $repository)
    {
        $this->repository = $repository;
    }

    public function findActiveUsers(): array
    {
        return $this->repository->findBy(['active' => true]);
    }
}
`;

const PHP_AFTER = `<?php
namespace App\\Service;

class UserService
{
    private $repository;
    private $cache;

    public function __construct(UserRepository $repository, CacheInterface $cache)
    {
        $this->repository = $repository;
        $this->cache = $cache;
    }

    public function findActiveUsers(): array
    {
        return $this->cache->remember('active_users', function () {
            return $this->repository->findBy(['active' => true]);
        });
    }
}
`;

const RUBY_BEFORE = `class OrderProcessor
  def initialize(order, gateway)
    @order = order
    @gateway = gateway
  end

  def process
    return false unless @order.valid?
    @gateway.charge(@order.total)
  end
end
`;

const RUBY_AFTER = `class OrderProcessor
  attr_reader :result

  def initialize(order, gateway, logger)
    @order = order
    @gateway = gateway
    @logger = logger
  end

  def process
    return false unless @order.valid?

    @result = @gateway.charge(@order.total)
    @logger.info("charged #{@order.total}")
    @result
  end
end
`;

const SCSS_BEFORE = `$primary: #6366f1;
$radius: 8px;

.card {
  border-radius: $radius;
  padding: 16px;

  .title {
    color: $primary;
    font-weight: 600;
  }
}
`;

const SCSS_AFTER = `$primary: #6366f1;
$primary-dark: #4f46e5;
$radius: 8px;

.card {
  border-radius: $radius;
  padding: 16px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);

  .title {
    color: $primary-dark;
    font-weight: 700;
  }

  &:hover .title {
    color: $primary;
  }
}
`;

const HASKELL_BEFORE = `module Main where

import System.IO

main :: IO ()
main = do
  hSetBuffering stdout NoBuffering
  putStrLn "hello"
`;

const HASKELL_AFTER = `module Main where

import System.IO
import Data.List (sortBy)
import Data.Ord (comparing)

main :: IO ()
main = do
  hSetBuffering stdout NoBuffering
  let names = ["charlie", "alice", "bob"]
  mapM_ putStrLn (sortBy (comparing length) names)
`;

const TSX_BEFORE = `import React from 'react';

export function Button({ label }: { label: string }) {
  return <button className="btn">{label}</button>;
}
`;

const TSX_AFTER = `import React from 'react';

interface ButtonProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}

export function Button({ label, onClick, disabled }: ButtonProps) {
  return (
    <button className="btn" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}
`;

/** 构造一条 Edit 工具调用的恢复消息（toolArgs 由 harness 运行时补 diffHunks） */
function editToolCall(id, filePath, timestamp) {
  return {
    role: 'toolcall',
    content: 'The file has been updated successfully.',
    param: '⚙️ Edit',
    toolName: 'Edit',
    toolCallId: id,
    status: 'success',
    timestamp,
    toolArgs: {
      file_path: filePath,
      old_string: '...',
      new_string: '...',
      startLine: 1,
      endLine: 10,
    },
  };
}

const cases = [
  ['call_php_1', 'D:\\app\\src\\Service\\UserService.php', PHP_BEFORE, PHP_AFTER, 'php'],
  ['call_rb_1', 'D:\\app\\lib\\order_processor.rb', RUBY_BEFORE, RUBY_AFTER, 'ruby'],
  ['call_scss_1', 'D:\\app\\styles\\card.scss', SCSS_BEFORE, SCSS_AFTER, 'scss'],
  ['call_hs_1', 'D:\\app\\src\\Main.hs', HASKELL_BEFORE, HASKELL_AFTER, 'haskell'],
  ['call_tsx_1', 'D:\\app\\src\\Button.tsx', TSX_BEFORE, TSX_AFTER, 'tsx'],
];

const messages = [];
const editDiffNeeded = {};
let ts = 1789000000000;

messages.push({ role: 'user', content: '请帮我重构这几个文件，分别用 PHP / Ruby / SCSS / Haskell / TSX。', timestamp: ts });

for (const [id, filePath, before, after, lang] of cases) {
  ts += 1000;
  messages.push({ role: 'thinking', content: `准备修改 ${filePath}（${lang}）`, timestamp: ts });
  ts += 1000;
  messages.push(editToolCall(id, filePath, ts));
  editDiffNeeded[id] = { beforeContent: before, afterContent: after };
}

ts += 1000;
messages.push({
  role: 'assistant',
  content: '已完成 5 个文件的重构：PHP 增加缓存层、Ruby 增加日志与结果返回、SCSS 补充悬停态、Haskell 改为排序输出、TSX 补充 props 类型。',
  timestamp: ts,
});

// 追加一个 JSON 编辑（json 属于"启动即加载"集合，用于对照）
const JSON_BEFORE = `{
  "name": "app",
  "version": "1.0.0"
}
`;
const JSON_AFTER = `{
  "name": "app",
  "version": "1.1.0",
  "scripts": {
    "build": "vite build"
  }
}
`;
ts += 1000;
messages.push(editToolCall('call_json_1', 'D:\\app\\package.json', ts));
editDiffNeeded['call_json_1'] = { beforeContent: JSON_BEFORE, afterContent: JSON_AFTER };

const session = {
  name: 'synthetic/mixed-langs',
  file: '(synthetic)',
  rawBytes: 0,
  rawMessages: messages.length,
  messages,
  editDiffNeeded,
};

const out = { sessions: [session] };
fs.writeFileSync(path.join(__dirname, 'sessions-synthetic.json'), JSON.stringify(out));
console.log(`Wrote sessions-synthetic.json: ${messages.length} messages, ${Object.keys(editDiffNeeded).length} Edit diff payloads`);
console.log('语言覆盖:', cases.map((c) => c[4]).join(', '), ', json');
