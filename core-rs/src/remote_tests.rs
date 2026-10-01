//! 远程监听模式用例（`docs/core-daemon.md` 第 12 节）：
//! token 生成与定长比较、启动横幅、命令行解析、目录列举，以及一条真实 TCP
//! 控制通道上的「错误 token 被拒 / 正确 token 通过后能列目录」端到端路径。

use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ==================== 工具 ====================

/// 造一个唯一临时目录（不引入 tempfile 依赖），退出时由调用方删除。
fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!(
        "tuxedo-cat-remote-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn read_line(reader: &mut BufReader<TcpStream>) -> String {
    let mut line = String::new();
    reader.read_line(&mut line).expect("read frame line");
    line
}

fn is_hex(token: &str) -> bool {
    token.len() == TOKEN_HEX_LEN && token.chars().all(|c| c.is_ascii_hexdigit())
}

// ==================== token ====================

#[test]
fn token_is_hex_and_varies() {
    let first = generate_token();
    let second = generate_token();
    assert!(is_hex(&first), "token 应为 32 位十六进制：{first}");
    assert!(is_hex(&second));
    assert_ne!(first, second, "两次生成的 token 不应相同");
}

#[test]
fn token_compare_is_exact() {
    assert!(token_matches("abcd", "abcd"));
    assert!(!token_matches("abcd", "abce"));
    assert!(!token_matches("abcd", "abc"));
    assert!(!token_matches("abcd", "abcde"));
    assert!(!token_matches("", "a"));
}

#[test]
fn banner_reports_endpoint_and_token() {
    let text = banner("172.20.1.5:17321", "deadbeef");
    assert!(text.contains("172.20.1.5:17321"), "{text}");
    assert!(text.contains("deadbeef"), "{text}");
}

#[test]
fn banner_host_keeps_concrete_addresses() {
    // 默认回环不能被换成对外 IPv4：Host 会按横幅地址连接
    assert_eq!(display_host(DEFAULT_HOST), DEFAULT_HOST);
    assert_eq!(display_host("127.0.0.1"), "127.0.0.1");
    assert_eq!(display_host("192.168.1.5"), "192.168.1.5");
    // 通配地址才探测；探测不到回退回环，至少不是 0.0.0.0
    assert_ne!(display_host("0.0.0.0"), "0.0.0.0");
}

// ==================== 命令行 ====================

#[test]
fn parses_start_options() {
    let args: Vec<String> = ["start", "--host", "0.0.0.0", "--port", "8123", "--token", "abc"]
        .iter()
        .map(|value| value.to_string())
        .collect();
    let options = RemoteOptions::from_args(&args);
    assert_eq!(options.host, "0.0.0.0");
    assert_eq!(options.port, 8123);
    assert_eq!(options.token, "abc");

    let inline: Vec<String> = ["--host=0.0.0.0", "--port=9000", "--token=t"]
        .iter()
        .map(|value| value.to_string())
        .collect();
    let options = RemoteOptions::from_args(&inline);
    assert_eq!(options.host, "0.0.0.0");
    assert_eq!(options.port, 9000);
    assert_eq!(options.token, "t");

    // 缺省：回环地址 + 默认端口 + token 留空（由 daemon 生成或复用状态文件里的）
    let options = RemoteOptions::from_args(&["start".to_string()]);
    assert_eq!(options.host, DEFAULT_HOST);
    assert_eq!(options.port, DEFAULT_PORT);
    assert!(options.token.is_empty());
}

// ==================== 目录列举 ====================

#[test]
fn lists_only_subdirectories_sorted() {
    let dir = temp_dir("listing");
    std::fs::create_dir_all(dir.join("alpha")).unwrap();
    std::fs::create_dir_all(dir.join("Beta")).unwrap();
    std::fs::write(dir.join("note.txt"), b"x").unwrap();

    let listing = list_directories(Some(dir.to_string_lossy().as_ref())).expect("list");
    let names: Vec<&str> = listing.entries.iter().map(|entry| entry.name.as_str()).collect();
    assert_eq!(names, vec!["alpha", "Beta"], "只列子目录并按名字排序");
    assert!(listing.entries.iter().all(|entry| entry.path.starts_with(&listing.path)));
    let expected_parent = dir.parent().map(|p| p.to_string_lossy().to_string());
    assert_eq!(listing.parent, expected_parent);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rejects_relative_path() {
    let error = list_directories(Some("relative/dir")).expect_err("相对路径应被拒绝");
    assert!(error.contains("absolute"), "{error}");
}

#[test]
fn empty_path_starts_at_home() {
    let Some(home) = home_dir() else {
        return; // 环境没有 HOME / USERPROFILE：跳过
    };
    let listing = list_directories(None).expect("home listing");
    assert_eq!(PathBuf::from(&listing.path), home);
}

// ==================== 端口重试 ====================

#[test]
fn bind_listener_retries_next_port_on_conflict() {
    let occupied = TcpListener::bind(("127.0.0.1", 0)).expect("bind occupied");
    let taken = occupied.local_addr().expect("addr").port();

    let listener = bind_listener("127.0.0.1", taken).expect("retry bind");
    let bound = listener.local_addr().expect("addr").port();
    // 相邻端口也可能被本机其它进程占用，只要求「向前挪且不超过重试上限」
    assert!(bound > taken, "被占用时应向前重试：taken={taken} bound={bound}");
    assert!(
        bound - taken <= PORT_RETRY_LIMIT,
        "重试次数不应超过上限：taken={taken} bound={bound}"
    );

    // 端口 0 交给内核，不做重试
    let ephemeral = bind_listener("127.0.0.1", 0).expect("ephemeral bind");
    assert_ne!(ephemeral.local_addr().expect("addr").port(), 0);
}

// ==================== 控制通道鉴权 ====================

fn start_server(token: &str) -> (std::net::SocketAddr, thread::JoinHandle<ChannelExit>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let address = listener.local_addr().expect("addr");
    let token = token.to_string();
    let handle = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        serve_connection(stream, &token, remote_daemon_options())
    });
    (address, handle)
}

#[test]
fn rejects_wrong_token() {
    let (address, server) = start_server("right-token");
    let mut client = TcpStream::connect(address).expect("connect");
    client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    client
        .write_all(b"{\"kind\":\"auth\",\"token\":\"wrong-token\"}\n")
        .unwrap();
    let mut reader = BufReader::new(client.try_clone().unwrap());
    let line = read_line(&mut reader);
    assert!(line.contains("\"authFailed\""), "{line}");
    drop(client);
    // 鉴权失败只是这条连接用完：daemon 继续等下一条
    assert_eq!(server.join().expect("server thread"), ChannelExit::Continue);
}

#[test]
fn accepts_token_then_lists_directories() {
    let dir = temp_dir("e2e");
    std::fs::create_dir_all(dir.join("work")).unwrap();

    let (address, server) = start_server("secret");
    let mut client = TcpStream::connect(address).expect("connect");
    client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(client.try_clone().unwrap());

    client
        .write_all(b"{\"kind\":\"auth\",\"token\":\"secret\"}\n")
        .unwrap();
    assert!(read_line(&mut reader).contains("\"authOk\""));

    let request = format!(
        "{{\"kind\":\"listDirectories\",\"id\":7,\"path\":{}}}\n",
        serde_json::to_string(&dir.to_string_lossy().to_string()).unwrap()
    );
    client.write_all(request.as_bytes()).unwrap();
    let listed = read_line(&mut reader);
    assert!(listed.contains("\"directoriesListed\""), "{listed}");
    assert!(listed.contains("\"id\":7"), "{listed}");
    assert!(listed.contains("work"), "{listed}");

    // shutdown：daemon 主循环退出，serve_connection 报告「结束 daemon」
    client.write_all(b"{\"kind\":\"shutdown\"}\n").unwrap();
    drop(reader);
    drop(client);
    assert_eq!(server.join().expect("server thread"), ChannelExit::Stop);

    std::fs::remove_dir_all(&dir).ok();
}

// ==================== daemon 状态文件 ====================

/// 状态文件读写：字段名与内容原样往返（Host / 用户都按这三个字段读）。
#[test]
fn daemon_state_round_trip() {
    let dir = temp_dir("state");
    let path = dir.join(DAEMON_STATE_FILE_NAME);
    let state = DaemonState {
        requested: "127.0.0.1:10975".to_string(),
        endpoint: "127.0.0.1:10976".to_string(),
        token: "aabbccdd".to_string(),
    };
    write_daemon_state(&path, &state).expect("write state");
    assert_eq!(read_daemon_state_at(&path), Some(state));

    let text = std::fs::read_to_string(&path).unwrap();
    for field in ["requested", "endpoint", "token"] {
        assert!(text.contains(field), "状态文件缺少 {field}：{text}");
    }
    // 原子落盘：临时文件不留在目录里
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name != DAEMON_STATE_FILE_NAME)
        .collect();
    assert!(leftovers.is_empty(), "落盘后残留临时文件：{leftovers:?}");

    std::fs::remove_dir_all(&dir).ok();
}

/// token 是凭证：Unix 上状态文件只有属主可读写。
#[cfg(unix)]
#[test]
fn daemon_state_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("state-mode");
    let path = dir.join(DAEMON_STATE_FILE_NAME);
    write_daemon_state(
        &path,
        &DaemonState {
            requested: "127.0.0.1:10975".to_string(),
            endpoint: "127.0.0.1:10975".to_string(),
            token: "aabbccdd".to_string(),
        },
    )
    .expect("write state");
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "状态文件权限应为 0600，实际 {mode:o}");
    std::fs::remove_dir_all(&dir).ok();
}

/// 读不出 / 不是 JSON：当作「没有 daemon」，不 panic。
#[test]
fn daemon_state_read_tolerates_garbage() {
    let dir = temp_dir("state-garbage");
    let path = dir.join(DAEMON_STATE_FILE_NAME);
    assert_eq!(read_daemon_state_at(&path), None, "文件不存在时返回 None");
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(read_daemon_state_at(&path), None);
    std::fs::remove_dir_all(&dir).ok();
}

// ==================== token 取值 ====================

/// `--token` > 状态文件里的 > 新随机。
#[test]
fn token_prefers_argument_then_state_then_random() {
    let dir = temp_dir("token");
    let path = dir.join(DAEMON_STATE_FILE_NAME);
    let mut options = RemoteOptions::default();

    // 都没有：新随机（32 位十六进制）
    let generated = resolve_token(&options, &path);
    assert!(is_hex(&generated), "应生成 32 位十六进制：{generated}");

    // 有状态文件：复用文件里的
    write_daemon_state(
        &path,
        &DaemonState {
            requested: "127.0.0.1:10975".to_string(),
            endpoint: "127.0.0.1:10975".to_string(),
            token: "from-file".to_string(),
        },
    )
    .unwrap();
    assert_eq!(resolve_token(&options, &path), "from-file");

    // 显式给了 --token：用它（并覆盖文件里的）
    options.token = "from-arg".to_string();
    assert_eq!(resolve_token(&options, &path), "from-arg");

    // 状态文件里的 token 是空串：视同没有，重新生成
    write_daemon_state(
        &path,
        &DaemonState {
            requested: "127.0.0.1:10975".to_string(),
            endpoint: "127.0.0.1:10975".to_string(),
            token: String::new(),
        },
    )
    .unwrap();
    options.token = String::new();
    assert!(is_hex(&resolve_token(&options, &path)));

    std::fs::remove_dir_all(&dir).ok();
}

// ==================== 启动器的复用判断 ====================

/// 状态文件缺失 / 端口连不上：都按「没有 daemon」处理（要拉起）。
#[test]
fn existing_daemon_is_none_without_a_live_listener() {
    let dir = temp_dir("existing-none");
    let path = dir.join(DAEMON_STATE_FILE_NAME);
    let options = RemoteOptions::default();
    assert_eq!(existing_daemon(&path, &options), ExistingDaemon::None);

    // 文件在、但 endpoint 没人监听（拿一个刚释放的端口）
    let port = {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    write_daemon_state(
        &path,
        &DaemonState {
            requested: requested_key(&options),
            endpoint: format!("127.0.0.1:{port}"),
            token: "dead".to_string(),
        },
    )
    .unwrap();
    assert_eq!(existing_daemon(&path, &options), ExistingDaemon::None);

    std::fs::remove_dir_all(&dir).ok();
}

/// 在跑的 daemon 参数一致 → 复用；参数不同 → 报错（不静默忽略用户给的参数）。
#[test]
fn existing_daemon_reuses_or_rejects_by_request() {
    let dir = temp_dir("existing-live");
    let path = dir.join(DAEMON_STATE_FILE_NAME);
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let endpoint = listener.local_addr().unwrap().to_string();
    let options = RemoteOptions::default();
    write_daemon_state(
        &path,
        &DaemonState {
            requested: requested_key(&options),
            endpoint: endpoint.clone(),
            token: "shared".to_string(),
        },
    )
    .unwrap();

    assert_eq!(
        existing_daemon(&path, &options),
        ExistingDaemon::Running(DaemonState {
            requested: requested_key(&options),
            endpoint,
            token: "shared".to_string(),
        })
    );

    // 换端口：本次请求与在跑的不是同一个 daemon
    let other = RemoteOptions {
        port: 12345,
        ..RemoteOptions::default()
    };
    match existing_daemon(&path, &other) {
        ExistingDaemon::Mismatch(message) => assert!(message.contains("--host / --port"), "{message}"),
        other => panic!("expected mismatch, got {other:?}"),
    }

    // 显式给了不同的 token：同样报错
    let with_token = RemoteOptions {
        token: "another".to_string(),
        ..RemoteOptions::default()
    };
    match existing_daemon(&path, &with_token) {
        ExistingDaemon::Mismatch(message) => assert!(message.contains("--token"), "{message}"),
        other => panic!("expected mismatch, got {other:?}"),
    }

    // 显式给了相同的 token：照常复用
    let same_token = RemoteOptions {
        token: "shared".to_string(),
        ..RemoteOptions::default()
    };
    assert!(matches!(
        existing_daemon(&path, &same_token),
        ExistingDaemon::Running(_)
    ));

    drop(listener);
    std::fs::remove_dir_all(&dir).ok();
}

/// 探测：监听中的端口为真，空端口为假。
#[test]
fn probe_endpoint_reports_listeners() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let endpoint = listener.local_addr().unwrap().to_string();
    assert!(probe_endpoint(&endpoint), "{endpoint} 应在监听");
    drop(listener);
    assert!(!probe_endpoint(&endpoint), "{endpoint} 已释放");
    assert!(!probe_endpoint("not-an-endpoint"), "解析不了即视为没有");
}

// ==================== 结束 daemon（`kill`）====================

/// `stop_daemon`：`auth` → `shutdown`，服务端据此结束 daemon。
#[test]
fn stop_daemon_shuts_the_server_down() {
    let (address, server) = start_server("secret");
    let state = DaemonState {
        requested: requested_key(&RemoteOptions::default()),
        endpoint: address.to_string(),
        token: "secret".to_string(),
    };
    stop_daemon(&state).expect("stop daemon");
    assert_eq!(server.join().expect("server thread"), ChannelExit::Stop);
}

/// token 对不上：报错，不假装停掉了（也不能把状态文件当成已清理）。
#[test]
fn stop_daemon_refuses_on_token_mismatch() {
    let (address, server) = start_server("secret");
    let state = DaemonState {
        requested: requested_key(&RemoteOptions::default()),
        endpoint: address.to_string(),
        token: "another".to_string(),
    };
    let error = stop_daemon(&state).expect_err("token 不匹配应报错");
    assert!(error.contains("rejected the stored token"), "{error}");
    server.join().expect("server thread");
}

/// 端口上没人监听：报「连不上」，调用方据此清理过期状态文件。
#[test]
fn stop_daemon_reports_unreachable() {
    let port = {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let state = DaemonState {
        requested: requested_key(&RemoteOptions::default()),
        endpoint: format!("127.0.0.1:{port}"),
        token: "secret".to_string(),
    };
    assert_eq!(
        stop_daemon(&state).expect_err("没有 daemon 应报错"),
        STOP_UNREACHABLE
    );
}

/// 状态文件只在内容仍是自己那份时才删（新 daemon 可能已经覆盖过它）。
#[test]
fn state_file_is_removed_only_when_unchanged() {
    let dir = temp_dir("remove-state");
    let path = dir.join(DAEMON_STATE_FILE_NAME);
    let state = DaemonState {
        requested: "127.0.0.1:10975".to_string(),
        endpoint: "127.0.0.1:10975".to_string(),
        token: "mine".to_string(),
    };
    write_daemon_state(&path, &state).unwrap();

    // 别人已经覆盖：不动它
    let other = DaemonState {
        token: "newer".to_string(),
        ..state.clone()
    };
    write_daemon_state(&path, &other).unwrap();
    remove_state_if_unchanged(&path, &state);
    assert_eq!(read_daemon_state_at(&path), Some(other));

    // 还是自己那份：删掉
    write_daemon_state(&path, &state).unwrap();
    remove_state_if_unchanged(&path, &state);
    assert_eq!(read_daemon_state_at(&path), None);

    std::fs::remove_dir_all(&dir).ok();
}
