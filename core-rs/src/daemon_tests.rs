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
}

impl CoreSpawner for FakeSpawner {
    fn spawn(
        &self,
        _channel: u64,
        _sink: Arc<dyn CoreEventSink>,
    ) -> io::Result<Box<dyn CoreProcessHandle>> {
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::Other, "spawn failed"));
        }
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let child = Arc::new(FakeChild::default());
        self.children.lock().unwrap().push(Arc::clone(&child));
        Ok(Box::new(FakeHandle { child }))
    }
}

/// 测试事件汇：把子进程的输出 / 退出转成 `DaemonEvent`
struct TestSink {
    tx: Sender<DaemonEvent>,
}

impl CoreEventSink for TestSink {
    fn on_line(&self, channel: u64, line: String) {
        let _ = self.tx.send(DaemonEvent::FrameLine { channel, line });
    }

    fn on_exit(&self, channel: u64, code: Option<i32>) {
        let _ = self.tx.send(DaemonEvent::CoreExited { channel, code });
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
        let (tx, rx) = mpsc_channel::<DaemonEvent>();
        let (out_tx, out_rx) = mpsc_channel::<String>();
        let sink: Arc<dyn CoreEventSink> = Arc::new(TestSink { tx: tx.clone() });
        let spawner = Arc::new(FakeSpawner::default());
        let out: Arc<dyn FrameOutput> = Arc::new(ChannelOutput { tx: out_tx });
        let spawner_for_thread = Arc::clone(&spawner);
        let join = thread::spawn(move || run_daemon(rx, out, sink, spawner_for_thread, options));
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
