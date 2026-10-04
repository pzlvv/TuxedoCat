/**
 * 单测：SSH 连接历史（`src/host/sshHistory.ts`）。
 *
 * 覆盖四块纯逻辑：
 * - `rememberSshEntry`：同一 user@host:port 去重置顶、口令更新、上限截断；
 * - `parseSshHistory`：落盘数组的形状校验（非法项整项丢弃，不猜不补）；
 * - `matchSshEntries`：候选的两级排序——前缀匹配 > 非前缀匹配，同级按时间（列表序），
 *   关键字同时对着 `user@host` / `user@host:port` / 裸 `host` 匹配，空关键字取最近几条；
 * - `formatSshEntry`：`<user>@<host>(:port)`，端口 22 不显示。
 *
 * 运行方式：npm run test:all -- ssh-history
 */

import { createChecker, runTests } from './helpers/harness';
import {
  formatSshEntry,
  matchSshEntries,
  parseSshHistory,
  rememberSshEntry,
  removeSshEntry,
  sshHistoryKey,
  MAX_SSH_HISTORY,
  type SshHistoryEntry,
} from '../host/sshHistory';

function entry(user: string, host: string, port: number, password = 'pw'): SshHistoryEntry {
  return { host, port, user, password };
}

runTests('sshHistory', async () => {
  const { check, finish } = createChecker();

  // ---------- 去重键 ----------

  check('去重键含用户与端口', sshHistoryKey(entry('root', '10.0.0.1', 22))
    !== sshHistoryKey(entry('dev', '10.0.0.1', 22))
    && sshHistoryKey(entry('root', '10.0.0.1', 22)) !== sshHistoryKey(entry('root', '10.0.0.1', 2222)));
  check('去重键的 host 不分大小写', sshHistoryKey(entry('root', 'Web-1', 22))
    === sshHistoryKey(entry('root', 'web-1', 22)));

  // ---------- rememberSshEntry：置顶 / 去重 / 口令更新 / 截断 ----------

  {
    const list = [entry('dev', 'build-1', 22), entry('root', 'web-1', 22)];
    const next = rememberSshEntry(list, entry('root', 'web-1', 22, 'new-pw'));
    check('重复连接置顶且只留一条', next.length === 2
      && sshHistoryKey(next[0]) === sshHistoryKey(entry('root', 'web-1', 22))
      && sshHistoryKey(next[1]) === sshHistoryKey(entry('dev', 'build-1', 22)));
    check('重复连接更新口令', next[0].password === 'new-pw');
  }
  {
    const full = Array.from({ length: MAX_SSH_HISTORY }, (_, i) => entry(`u${i}`, `h${i}`, 22));
    const next = rememberSshEntry(full, entry('new', 'h-new', 22));
    check('超出上限截断最旧的', next.length === MAX_SSH_HISTORY
      && sshHistoryKey(next[0]) === sshHistoryKey(entry('new', 'h-new', 22))
      && !next.some((item) => item.user === 'u19'));
  }
  {
    const list = [entry('dev', 'build-1', 22)];
    check('删除按去重键匹配', removeSshEntry(list, sshHistoryKey(entry('dev', 'build-1', 22))).length === 0
      && removeSshEntry(list, sshHistoryKey(entry('dev', 'build-1', 2222))).length === 1);
  }

  // ---------- parseSshHistory：形状校验 ----------

  check('非数组按空处理', parseSshHistory(null).length === 0 && parseSshHistory('x').length === 0);
  {
    const parsed = parseSshHistory([
      { host: ' web-1 ', port: 22, user: ' root ', password: 'pw' },
      { host: '', port: 22, user: 'root', password: 'pw' },
      { host: 'h', port: 0, user: 'root', password: 'pw' },
      { host: 'h', port: 70000, user: 'root', password: 'pw' },
      { host: 'h', port: 22.5, user: 'root', password: 'pw' },
      { host: 'h', port: '22', user: 'root', password: 'pw' },
      { host: 'h', port: 22, user: '', password: 'pw' },
      { host: 'h', port: 22, user: 'root', password: '' },
      'not-an-object',
      null,
    ]);
    check('只留合法项（字段类型 / 范围逐一过）', parsed.length === 1);
    check('合法项 trim 主机与用户、口令不 trim', parsed[0].host === 'web-1'
      && parsed[0].user === 'root' && parsed[0].password === 'pw');
  }
  {
    const tooMany = Array.from({ length: MAX_SSH_HISTORY + 5 }, (_, i) => entry(`u${i}`, `h${i}`, 22));
    check('读取也受上限约束', parseSshHistory(tooMany).length === MAX_SSH_HISTORY);
  }

  // ---------- matchSshEntries：两级排序 ----------

  // 列表按连接时间倒序（idx 0 最近）
  const history = [
    entry('root', '10.0.0.1', 22),
    entry('dev', 'build-1', 2222),
    entry('carol', 'web-2', 22),
    entry('alice', 'db-2', 22),
    entry('root', 'web-1', 22),
    entry('bob', '10.0.0.9', 2200),
    entry('root', 'cache-1', 22),
    entry('dave', 'build-2', 22),
  ];

  {
    const matched = matchSshEntries(history, '');
    check('空关键字取最近 6 条', matched.length === 6
      && matched.map((item) => sshHistoryKey(item)).join()
        === history.slice(0, 6).map((item) => sshHistoryKey(item)).join());
  }
  {
    // root@web-1(idx4) / root@cache-1(idx6) 是前缀匹配；carol(contains 'ro', idx2) 更近但排在后
    const matched = matchSshEntries(history, 'ro');
    check('前缀匹配排在非前缀之前（即便更旧）', matched.map((item) => item.user).join() === 'root,root,root,carol');
  }
  {
    // 'build' 命中裸 host 前缀：build-1 与 build-2，按时间序
    const matched = matchSshEntries(history, 'build');
    check('按裸 host 前缀匹配并按时间排序', matched.map((item) => item.host).join() === 'build-1,build-2');
  }
  {
    // '2222' 命中 `user@host:port` 文本
    const matched = matchSshEntries(history, '2222');
    check('端口也能当关键字', matched.length === 1 && matched[0].host === 'build-1');
  }
  {
    const matched = matchSshEntries(history, 'DEV@');
    check('匹配不分大小写、关键字做 trim', matchSshEntries(history, ' dev@')[0].host === 'build-1'
      && matched[0].host === 'build-1');
  }
  check('无匹配返回空', matchSshEntries(history, 'zzz').length === 0);
  {
    const many = Array.from({ length: 12 }, (_, i) => entry(`u${i}`, `h${i}`, 22));
    check('候选最多 limit 条', matchSshEntries(many, 'h').length === 6
      && matchSshEntries(many, 'h', 3).length === 3);
  }

  // ---------- formatSshEntry ----------

  check('端口 22 不显示', formatSshEntry(entry('root', 'web-1', 22)) === 'root@web-1');
  check('非 22 端口追加 :port', formatSshEntry(entry('dev', 'build-1', 2222)) === 'dev@build-1:2222');

  finish();
});
