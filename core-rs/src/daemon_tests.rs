//! daemon 进程模型用例（`docs/core/core-daemon.md` 第 10 节）：
//! channel 分配、多 channel 隔离、关闭与计数、grace 退出、崩溃重启、重启上限、
//! 控制通道断开清理。进程工厂与事件汇都注入假实现，不依赖真实可执行文件。

use super::*;
use serde_json::{json, Value};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel as mpsc_channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ==================== 假进程 ====================

#[derive(Default)]
struct FakeChild {
    /// 收到的内层帧行（不含换行）
    lines: Mutex<Vec<String>>,
    killed: AtomicBool,
}

struct FakeHandle {
    child: Arc<FakeChild>,
}

impl CoreProcessHandle for FakeHandle {
    fn send_line(&self, line: &str) -> io::Result<()> {
        self.child.lines.lock().unwrap().push(line.to_string());
        Ok(())
    }

    fn kill(&self) {
        self.child.killed.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeSpawner {
    children: Mutex<Vec<Arc<FakeChild>>>,
    /// 每次 spawn 时收到的帧出口（specs/031：模拟 Core 输出经 `RoutableSink` 的真实路径）
    sinks: Mutex<Vec<Arc<dyn CoreEventSink>>>,
    spawns: AtomicUsize,
    fail_next: AtomicBool,
}

impl FakeSpawner {
    fn child(&self, index: usize) -> Arc<FakeChild> {
        self.children.lock().unwrap()[index].clone()
    }

    fn lines_of(&self, index: usize) -> Vec<String> {
        self.child(index).lines.lock().unwrap().clone()
    }

    fn sink_of(&self, index: usize) -> Arc<dyn CoreEventSink> {
        Arc::clone(&self.sinks.lock().unwrap()[index])
    }
}

impl CoreSpawner for FakeSpawner {
    fn spawn(
        &self,
        _channel: u64,
        sink: Arc<dyn CoreEventSink>,
    ) -> io::Result<Box<dyn CoreProcessHandle>> {
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::Other, "spawn failed"));
        }
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let child = Arc::new(FakeChild::default());
        self.children.lock().unwrap().push(Arc::clone(&child));
        self.sinks.lock().unwrap().push(sink);
        Ok(Box::new(FakeHandle { child }))
    }
}

// ==================== Harness ====================

struct Harness {
    tx: Sender<DaemonEvent>,
    out_rx: Receiver<String>,
    spawner: Arc<FakeSpawner>,
    join: Option<thread::JoinHandle<ChannelExit>>,
}

impl Harness {
    fn new(options: DaemonOptions) -> Harness {
        Harness::with_context(options, None)
    }

    /// `context` 传孤儿表上下文即启用 specs/031 语义（断开孤儿化 / detach / 认领）
    fn with_context(options: DaemonOptions, context: Option<ConnectionContext>) -> Harness {
        let (tx, rx) = mpsc_channel::<DaemonEvent>();
        let (out_tx, out_rx) = mpsc_channel::<String>();
        let spawner = Arc::new(FakeSpawner::default());
        let out: Arc<dyn FrameOutput> = Arc::new(ChannelOutput { tx: out_tx });
        let spawner_for_thread = Arc::clone(&spawner);
        let tx_for_thread = tx.clone();
        let join = thread::spawn(move || {
            run_daemon(tx_for_thread, rx, out, spawner_for_thread, options, context)
        });
        Harness {
            tx,
            out_rx,
            spawner,
            join: Some(join),
        }
    }

    fn fast() -> Harness {
        Harness::new(Harness::fast_options())
    }

    fn command(&self, value: Value) {
        self.tx
            .send(DaemonEvent::Command(value.to_string()))
            .expect("send command");
    }

    fn exit_core(&self, channel: u64, code: Option<i32>) {
        self.tx
            .send(DaemonEvent::CoreExited { channel, code })
            .expect("send exit");
    }

    /// 模拟第 index 个 Core 的 stdout 输出一帧内层帧（经 spawn 时登记的
    /// `RoutableSink`，与生产路径一致：孤儿化后帧进孤儿表而不是连接）
    fn emit_line(&self, index: usize, line: &str) {
        self.spawner.sink_of(index).on_line(0, line.to_string());
    }

    /// 模拟第 index 个 Core 退出（经 spawn 时登记的 `RoutableSink`）
    fn emit_exit(&self, index: usize, code: Option<i32>) {
        self.spawner.sink_of(index).on_exit(0, code);
    }

    fn next_frame(&self) -> Value {
        let line = self
            .out_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("daemon frame");
        serde_json::from_str(&line).expect("valid daemon frame")
    }

    fn wait_for_spawns(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.spawner.spawns.load(Ordering::SeqCst) < expected {
            assert!(Instant::now() < deadline, "core was not restarted in time");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_for_lines(&self, index: usize, expected: usize) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let lines = self.spawner.lines_of(index);
            if lines.len() >= expected {
                return lines;
            }
            assert!(Instant::now() < deadline, "core did not receive frames in time");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn shutdown(&mut self) -> ChannelExit {
        self.command(json!({ "kind": "shutdown" }));
        self.join.take().expect("daemon thread").join().expect("daemon join")
    }
}

fn open(id: u64, path: &str) -> Value {
    json!({
        "kind": "openWorkspace",
        "id": id,
        "workspaceRef": { "scheme": "file", "path": path, "endpoint": null },
    })
}

// ==================== 用例 ====================

#[test]
fn open_workspace_spawns_a_core_and_returns_a_descriptor() {
    let mut harness = Harness::fast();
    harness.command(open(1, "D:/repo/a"));

    let opened = harness.next_frame();
    assert_eq!(opened["kind"], "workspaceOpened");
    assert_eq!(opened["id"], 1);
    assert_eq!(opened["channel"], 1);
    assert_eq!(opened["descriptor"]["kind"], "multiplexed");
    assert_eq!(opened["descriptor"]["channel"], 1);
    assert_eq!(harness.spawner.spawns.load(Ordering::SeqCst), 1);

    // 内层帧原样转发给该 channel 的 Core
    harness.command(json!({
        "kind": "frame",
        "channel": 1,
        "frame": { "kind": "hello", "protocol": 2 },
    }));
    let lines = harness.wait_for_lines(0, 1);
    assert_eq!(lines[0], "{\"kind\":\"hello\",\"protocol\":2}");

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn two_workspaces_get_isolated_channels() {
    let mut harness = Harness::fast();
    harness.command(open(1, "D:/repo/a"));
    harness.command(open(2, "D:/repo/b"));
    assert_eq!(harness.next_frame()["channel"], 1);
    assert_eq!(harness.next_frame()["channel"], 2);

    harness.command(json!({
        "kind": "frame",
        "channel": 2,
        "frame": { "kind": "uiEvent", "event": { "type": "abortRequested", "sessionId": "s" } },
    }));
    harness.wait_for_lines(1, 1);
    assert!(
        harness.spawner.lines_of(0).is_empty(),
        "channel 1 must stay untouched"
    );
    assert_eq!(harness.spawner.lines_of(1).len(), 1);

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn close_workspace_shuts_down_the_core_and_reports_closed() {
    let mut harness = Harness::fast();
    harness.command(open(1, "D:/repo/a"));
    harness.next_frame();

    harness.command(json!({ "kind": "closeWorkspace", "channel": 1 }));
    let lines = harness.wait_for_lines(0, 1);
    assert_eq!(lines[0], "{\"kind\":\"shutdown\"}");

    harness.exit_core(1, Some(0));
    let closed = harness.next_frame();
    assert_eq!(closed["kind"], "workspaceClosed");
    assert_eq!(closed["channel"], 1);
    assert_eq!(closed["reason"], "closed");

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn grace_period_exits_after_the_last_core_closes() {
    let mut harness = Harness::new(DaemonOptions {
        grace_period: Duration::from_millis(80),
        ..Harness::fast_options()
    });
    harness.command(open(1, "D:/repo/a"));
    harness.next_frame();
    harness.command(json!({ "kind": "closeWorkspace", "channel": 1 }));
    harness.exit_core(1, Some(0));
    assert_eq!(harness.next_frame()["kind"], "workspaceClosed");

    // 没有新工作区：grace 期到点后 daemon 自行退出
    let exit = harness.join.take().expect("daemon thread").join().expect("daemon join");
    assert_eq!(exit, ChannelExit::Stop);
}

#[test]
fn idle_exit_false_keeps_the_daemon_alive_without_cores() {
    // 远程 daemon 的语义：控制通道在，daemon 就在；没有工作区也不 grace 退出
    let mut harness = Harness::new(DaemonOptions {
        grace_period: Duration::from_millis(50),
        idle_exit: false,
        ..Harness::fast_options()
    });
    thread::sleep(Duration::from_millis(200));
    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

impl Harness {
    fn fast_options() -> DaemonOptions {
        DaemonOptions {
            grace_period: Duration::from_millis(200),
            shutdown_timeout: Duration::from_millis(500),
            restart_policy: RestartPolicy {
                max_attempts: 3,
                window: Duration::from_secs(60),
                base_delay: Duration::from_millis(10),
                max_delay: Duration::from_millis(20),
            },
            idle_exit: true,
            heartbeat_timeout: None,
        }
    }
}

#[test]
fn opening_a_workspace_during_grace_keeps_the_daemon_alive() {
    let mut harness = Harness::new(DaemonOptions {
        grace_period: Duration::from_millis(150),
        ..Harness::fast_options()
    });
    harness.command(open(1, "D:/repo/a"));
    harness.next_frame();
    harness.command(json!({ "kind": "closeWorkspace", "channel": 1 }));
    harness.exit_core(1, Some(0));
    harness.next_frame();

    // grace 期内新开工作区：取消退出计时，daemon 继续服务
    harness.command(open(2, "D:/repo/b"));
    let reopened = harness.next_frame();
    assert_eq!(reopened["kind"], "workspaceOpened");
    assert_eq!(reopened["channel"], 2);

    thread::sleep(Duration::from_millis(200));
    assert_eq!(harness.spawner.spawns.load(Ordering::SeqCst), 2, "daemon must stay alive");
    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn crashed_core_restarts_on_the_same_channel_and_flushes_queued_frames() {
    let mut harness = Harness::fast();
    harness.command(open(1, "D:/repo/a"));
    assert_eq!(harness.next_frame()["channel"], 1);

    harness.exit_core(1, Some(1));
    let reset = harness.next_frame();
    assert_eq!(reset["kind"], "channelReset");
    assert_eq!(reset["channel"], 1);

    // 重启窗口内的帧先排队，新进程起来后按序冲刷
    harness.command(json!({
        "kind": "frame",
        "channel": 1,
        "frame": { "kind": "hello", "protocol": 2 },
    }));
    harness.wait_for_spawns(2);
    let lines = harness.wait_for_lines(1, 1);
    assert_eq!(lines[0], "{\"kind\":\"hello\",\"protocol\":2}");
    assert_eq!(harness.spawner.spawns.load(Ordering::SeqCst), 2, "same channel restart");

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn restart_limit_closes_the_channel_and_reports_failure() {
    let mut harness = Harness::new(DaemonOptions {
        grace_period: Duration::from_millis(100),
        shutdown_timeout: Duration::from_millis(200),
        restart_policy: RestartPolicy {
            max_attempts: 2,
            window: Duration::from_secs(60),
            base_delay: Duration::from_millis(5),
            max_delay: Duration::from_millis(10),
        },
        heartbeat_timeout: None,
        idle_exit: true,
    });
    harness.command(open(1, "D:/repo/a"));
    harness.next_frame();

    // 前两次崩溃都重启（同 channel）
    harness.exit_core(1, Some(1));
    assert_eq!(harness.next_frame()["kind"], "channelReset");
    harness.wait_for_spawns(2);
    harness.exit_core(1, Some(1));
    assert_eq!(harness.next_frame()["kind"], "channelReset");
    harness.wait_for_spawns(3);

    // 第三次超过上限：报告原因并关闭 channel，不静默重试
    harness.exit_core(1, Some(1));
    let reset = harness.next_frame();
    assert_eq!(reset["kind"], "channelReset");
    assert!(reset["reason"].as_str().unwrap().contains("restart limit"));
    let closed = harness.next_frame();
    assert_eq!(closed["kind"], "workspaceClosed");
    assert_eq!(closed["reason"], "failed");

    // 没有 channel 了：grace 期后 daemon 退出
    let exit = harness.join.take().expect("daemon thread").join().expect("daemon join");
    assert_eq!(exit, ChannelExit::Stop);
}

#[test]
fn host_disconnect_closes_all_cores_and_exits() {
    let mut harness = Harness::fast();
    harness.command(open(1, "D:/repo/a"));
    harness.command(open(2, "D:/repo/b"));
    harness.next_frame();
    harness.next_frame();

    harness.tx.send(DaemonEvent::HostDisconnected).expect("disconnect");
    // 只是这条控制通道断了：远程 daemon 回到 accept，进程不退出
    let exit = harness.join.take().expect("daemon thread").join().expect("daemon join");
    assert_eq!(exit, ChannelExit::Continue);
    assert!(harness.spawner.child(0).killed.load(Ordering::SeqCst));
    assert!(harness.spawner.child(1).killed.load(Ordering::SeqCst));
}

#[test]
fn heartbeat_silence_closes_all_cores_and_continues() {
    // 远程序列：控制通道在但 Host 沉默——TCP 没断（读不到 EOF），靠心跳超时回收
    let mut harness = Harness::new(DaemonOptions {
        idle_exit: false,
        heartbeat_timeout: Some(Duration::from_millis(200)),
        ..Harness::fast_options()
    });
    harness.command(open(1, "D:/repo/a"));
    harness.next_frame();

    // 心跳在连接建立时已武装；此后沉默超过时限按 Host 断开处理
    harness.command(json!({ "kind": "ping" }));
    let exit = harness.join.take().expect("daemon thread").join().expect("daemon join");
    assert_eq!(exit, ChannelExit::Continue);
    assert!(harness.spawner.child(0).killed.load(Ordering::SeqCst));
}

#[test]
fn heartbeat_expires_a_silent_connection() {
    // 控制通道建立即武装心跳：连上后一直不发帧，沉默超过时限按 Host 断开处理
    let mut harness = Harness::new(DaemonOptions {
        idle_exit: false,
        heartbeat_timeout: Some(Duration::from_millis(200)),
        ..Harness::fast_options()
    });
    let exit = harness.join.take().expect("daemon thread").join().expect("daemon join");
    assert_eq!(exit, ChannelExit::Continue);
}

#[test]
fn heartbeat_is_refreshed_by_control_traffic() {
    // 任何控制帧都顺延心跳：第二次 ping 把到期时刻推后一个窗口
    let mut harness = Harness::new(DaemonOptions {
        idle_exit: false,
        heartbeat_timeout: Some(Duration::from_millis(300)),
        ..Harness::fast_options()
    });
    harness.command(open(1, "D:/repo/a"));
    harness.next_frame();
    harness.command(json!({ "kind": "ping" }));
    thread::sleep(Duration::from_millis(200));
    harness.command(json!({ "kind": "ping" }));
    thread::sleep(Duration::from_millis(200)); // 距首个 ping 已 400ms > 300ms 窗口
    // 未经顺延此刻已经回收：daemon 还活着说明控制帧确实顺延了心跳
    harness.command(json!({
        "kind": "frame",
        "channel": 1,
        "frame": { "kind": "hello", "protocol": 2 },
    }));
    harness.wait_for_lines(0, 1);
    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn ping_gets_a_pong_reply() {
    // Host 靠 pong 武装沉默判定（`docs/core/core-remote.md` 第 2.5 节）：daemon 对
    // 每个 ping 都回一帧 pong，沉默判定与心跳空闲回收互不干扰
    let mut harness = Harness::fast();
    harness.command(json!({ "kind": "ping" }));
    let pong = harness.next_frame();
    assert_eq!(pong["kind"], "pong");
    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn workspace_failure_is_reported_without_a_channel() {
    let mut harness = Harness::fast();
    harness.spawner.fail_next.store(true, Ordering::SeqCst);
    harness.command(open(1, "D:/repo/a"));
    let failed = harness.next_frame();
    assert_eq!(failed["kind"], "workspaceFailed");
    assert_eq!(failed["id"], 1);
    assert!(failed["error"].as_str().unwrap().contains("spawn failed"));
    assert_eq!(harness.spawner.spawns.load(Ordering::SeqCst), 0);

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

// ==================== 孤儿化 / detach / 认领（specs/031）====================

/// 一条 `sessionRuntimeChanged` 快照帧（单会话）
fn runtime_snapshot(idle: bool, waiting: bool) -> String {
    format!(
        "{{\"kind\":\"event\",\"event\":{{\"type\":\"sessionRuntimeChanged\",\"states\":\
         [{{\"sessionId\":\"s1\",\"idle\":{idle},\"waiting\":{waiting}}}]}}}}"
    )
}

/// 一条用户请求帧（权限确认形态）
fn pending_request(id: u64) -> String {
    format!(
        "{{\"kind\":\"request\",\"id\":{id},\"request\":{{\"type\":\"permissionRequested\",\
         \"sessionId\":\"s1\"}}}}"
    )
}

fn orphan_context() -> Option<ConnectionContext> {
    Some(ConnectionContext {
        orphans: Arc::new(OrphanRegistry::new()),
        connection: 1,
    })
}

#[test]
fn host_disconnect_orphans_busy_cores_and_closes_idle_ones() {
    let mut harness = Harness::with_context(Harness::fast_options(), orphan_context());
    harness.command(open(1, "D:/repo/busy"));
    harness.command(open(2, "D:/repo/idle"));
    harness.next_frame();
    harness.next_frame();
    // channel 1 有非 idle 会话，channel 2 无快照
    harness.emit_line(0, &runtime_snapshot(false, false));

    harness.tx.send(DaemonEvent::HostDisconnected).expect("disconnect");
    let exit = harness.join.take().expect("daemon thread").join().expect("join");
    assert_eq!(exit, ChannelExit::Continue);
    // 忙 Core 孤儿化存活，idle Core 照旧终止（spec AC-5 / AC-6）
    assert!(
        !harness.spawner.child(0).killed.load(Ordering::SeqCst),
        "busy core must survive the disconnect"
    );
    assert!(
        harness.spawner.child(1).killed.load(Ordering::SeqCst),
        "idle core must be closed as before"
    );
}

#[test]
fn malformed_snapshot_counts_as_busy_for_orphaning() {
    // 契约漂移（快照缺 states）按忙 fail-safe：保活，不静默杀任务
    let mut harness = Harness::with_context(Harness::fast_options(), orphan_context());
    harness.command(open(1, "D:/repo/w"));
    harness.next_frame();
    harness.emit_line(0, "{\"kind\":\"event\",\"event\":{\"type\":\"sessionRuntimeChanged\"}}");

    harness.tx.send(DaemonEvent::HostDisconnected).expect("disconnect");
    let exit = harness.join.take().expect("daemon thread").join().expect("join");
    assert_eq!(exit, ChannelExit::Continue);
    assert!(!harness.spawner.child(0).killed.load(Ordering::SeqCst));
}

#[test]
fn detach_workspace_orphans_the_core_and_keeps_serving_the_connection() {
    let mut harness = Harness::with_context(Harness::fast_options(), orphan_context());
    harness.command(open(1, "D:/repo/a"));
    harness.next_frame();

    harness.command(json!({ "kind": "detachWorkspace", "channel": 1 }));
    let closed = harness.next_frame();
    assert_eq!(closed["kind"], "workspaceClosed", "{closed}");
    assert_eq!(closed["channel"], 1);
    assert_eq!(closed["reason"], "detached");
    assert!(
        !harness.spawner.child(0).killed.load(Ordering::SeqCst),
        "detached core must keep running"
    );

    // 连接本身继续服务：新工作区照常打开、帧照常转发
    harness.command(open(2, "D:/repo/b"));
    let opened = harness.next_frame();
    assert_eq!(opened["kind"], "workspaceOpened");
    assert_eq!(opened["channel"], 2);
    harness.command(json!({
        "kind": "frame",
        "channel": 2,
        "frame": { "kind": "hello", "protocol": 2 },
    }));
    harness.wait_for_lines(1, 1);

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
    // shutdown 只收尾本连接的 channel；孤儿由 daemon 停机路径收尾（不在本表）
    assert!(!harness.spawner.child(0).killed.load(Ordering::SeqCst));
}

#[test]
fn second_orphan_for_the_same_key_falls_back_to_close() {
    // 同一连接、同一工作区路径的第二条孤儿登记拒绝插入：按现行关闭兜底，
    // 不静默覆盖（spec FR-005）
    let mut harness = Harness::with_context(Harness::fast_options(), orphan_context());
    harness.command(open(1, "D:/repo/w"));
    harness.command(open(2, "D:/repo/w"));
    harness.next_frame();
    harness.next_frame();

    harness.command(json!({ "kind": "detachWorkspace", "channel": 1 }));
    assert_eq!(harness.next_frame()["reason"], "detached");
    harness.command(json!({ "kind": "detachWorkspace", "channel": 2 }));
    let closed = harness.next_frame();
    assert_eq!(closed["kind"], "workspaceClosed");
    assert_eq!(closed["reason"], "closed");
    assert!(harness.spawner.child(1).killed.load(Ordering::SeqCst));

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn claim_replays_orphan_frames_in_arrival_order_without_spawning() {
    let mut harness = Harness::with_context(Harness::fast_options(), orphan_context());
    harness.command(open(1, "D:/repo/w"));
    assert_eq!(harness.next_frame()["channel"], 1);
    harness.command(json!({ "kind": "detachWorkspace", "channel": 1 }));
    assert_eq!(harness.next_frame()["reason"], "detached");

    // 孤儿期间的帧：running → 请求帧 → idle（经 RoutableSink 进孤儿表）
    harness.emit_line(0, &runtime_snapshot(false, false));
    harness.emit_line(0, &pending_request(7));
    harness.emit_line(0, &runtime_snapshot(true, false));

    // 重开同一工作区：认领，不开新进程（spec AC-7）
    harness.command(open(2, "D:/repo/w"));
    let opened = harness.next_frame();
    assert_eq!(opened["kind"], "workspaceOpened");
    assert_eq!(opened["id"], 2);
    assert_eq!(opened["channel"], 2);
    assert_eq!(harness.spawner.spawns.load(Ordering::SeqCst), 1, "claim must not spawn");

    // 重放缓存帧按到达序，channel 号换成新连接分配的号（spec AC-8 / AC-9 原料）
    let first = harness.next_frame();
    assert_eq!(first["kind"], "frame");
    assert_eq!(first["channel"], 2);
    assert_eq!(first["frame"]["kind"], "event");
    assert_eq!(first["frame"]["event"]["states"][0]["idle"], false);
    let second = harness.next_frame();
    assert_eq!(second["frame"]["kind"], "request");
    assert_eq!(second["frame"]["id"], 7);
    let third = harness.next_frame();
    assert_eq!(third["frame"]["event"]["states"][0]["idle"], true);

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn claim_with_quiet_orphan_replays_the_last_runtime_snapshot() {
    let mut harness = Harness::with_context(Harness::fast_options(), orphan_context());
    harness.command(open(1, "D:/repo/w"));
    harness.next_frame();
    harness.emit_line(0, &runtime_snapshot(false, true));
    // 连接态的快照会照常转发给宿主：消费掉，后续断言才对得上帧序
    assert_eq!(harness.next_frame()["kind"], "frame");
    harness.command(json!({ "kind": "detachWorkspace", "channel": 1 }));
    assert_eq!(harness.next_frame()["reason"], "detached");

    // 孤儿期间没有任何新帧：认领时补放最新快照，保证全量状态（spec FR-006）
    harness.command(open(2, "D:/repo/w"));
    let opened = harness.next_frame();
    assert_eq!(opened["channel"], 2);
    let replayed = harness.next_frame();
    assert_eq!(replayed["kind"], "frame");
    assert_eq!(replayed["channel"], 2);
    assert_eq!(replayed["frame"]["event"]["states"][0]["waiting"], true);

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn claimed_core_receives_new_connection_frames() {
    let mut harness = Harness::with_context(Harness::fast_options(), orphan_context());
    harness.command(open(1, "D:/repo/w"));
    harness.next_frame();
    harness.command(json!({ "kind": "detachWorkspace", "channel": 1 }));
    harness.next_frame();
    harness.command(open(2, "D:/repo/w"));
    assert_eq!(harness.next_frame()["channel"], 2);

    // 认领后宿主 → Core 的帧走移交后的句柄
    harness.command(json!({
        "kind": "frame",
        "channel": 2,
        "frame": { "kind": "hello", "protocol": 2 },
    }));
    let lines = harness.wait_for_lines(0, 1);
    assert_eq!(lines[0], "{\"kind\":\"hello\",\"protocol\":2}");

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn crashed_orphan_is_not_restarted_and_reopen_spawns_fresh() {
    let mut harness = Harness::with_context(Harness::fast_options(), orphan_context());
    harness.command(open(1, "D:/repo/w"));
    harness.next_frame();
    harness.emit_line(0, &runtime_snapshot(false, false));
    assert_eq!(harness.next_frame()["kind"], "frame");
    harness.command(json!({ "kind": "detachWorkspace", "channel": 1 }));
    assert_eq!(harness.next_frame()["reason"], "detached");

    // 孤儿崩溃：经帧出口路由进孤儿表，不走重启（无 channelReset）
    harness.emit_exit(0, Some(1));

    harness.command(open(2, "D:/repo/w"));
    let opened = harness.next_frame();
    assert_eq!(opened["kind"], "workspaceOpened");
    assert_eq!(
        harness.spawner.spawns.load(Ordering::SeqCst),
        2,
        "dead orphan must be replaced by a fresh spawn"
    );

    assert_eq!(harness.shutdown(), ChannelExit::Stop);
}

#[test]
fn replay_drain_drops_requests_beyond_the_reply_ttl() {
    let now = Instant::now();
    let mut entry = OrphanEntry {
        workspace_path: "D:/repo/w".to_string(),
        handle: None,
        runtime: None,
        runtime_line: None,
        replay: VecDeque::new(),
        busy: false,
        idle_since: None,
        exited: false,
    };
    push_replay(&mut entry.replay, BufferedFrame {
        line: pending_request(1),
        at: now.checked_sub(PENDING_REQUEST_TTL).unwrap_or(now),
        is_request: true,
    });
    push_replay(&mut entry.replay, BufferedFrame {
        line: runtime_snapshot(true, false),
        at: now,
        is_request: false,
    });

    let lines = drain_replay(&mut entry);
    assert_eq!(lines.len(), 1, "过时效的请求帧不再重放");
    assert!(lines[0].contains("sessionRuntimeChanged"));
}
