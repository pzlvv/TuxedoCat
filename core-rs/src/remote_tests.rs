//! 远程监听模式用例（`docs/core-daemon.md` 第 12 节）：
//! token 生成与定长比较、连接串、命令行解析、目录列举，以及一条真实 TCP
//! 控制通道上的「错误 token 被拒 / 正确 token 通过后能列目录」端到端路径；
//! 另有多客户端并发用例（双连接鉴权 / 独立 Core / 断开隔离 / shutdown 全局生效 /
//! 探活连接不阻塞接入），Core 进程用假工厂，不依赖真实可执行文件。

use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::json;

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
fn connection_string_carries_host_port_and_token() {
    let text = connection_string("172.20.1.5", 17321, "deadbeef");
    assert_eq!(text, "172.20.1.5:17321#deadbeef");
}

#[test]
fn connection_hosts_keep_concrete_addresses() {
    // 绑具体地址时只列它本身：Host 会按连接串里的地址连
    assert_eq!(connection_hosts("127.0.0.1"), vec!["127.0.0.1".to_string()]);
    assert_eq!(connection_hosts("192.168.1.5"), vec!["192.168.1.5".to_string()]);
}

#[test]
fn connection_hosts_expand_wildcard_to_every_interface() {
    // 通配地址：列出本机网卡，且一定含回环（绑通配地址的 daemon 在回环上必然可达）
    let hosts = connection_hosts("0.0.0.0");
    assert!(!hosts.is_empty(), "至少要有回环");
    assert!(
        hosts.iter().any(|host| host == "127.0.0.1"),
        "通配地址必须列出回环：{hosts:?}"
    );
    assert!(
        !hosts.iter().any(|host| host == "0.0.0.0"),
        "连接串里不能出现通配地址：{hosts:?}"
    );
    // 去重
    let mut sorted = hosts.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), hosts.len(), "主机不应重复：{hosts:?}");
}

#[test]
fn ready_message_lists_one_connection_string_per_line() {
    let text = ready_message("192.168.1.5", 10975, "abc");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "{text}");
    assert!(lines[0].contains("连接串"), "{text}");
    // 连接串单独占一行、不带前缀，双击即可整行选中
    assert_eq!(lines[1], "192.168.1.5:10975#abc");
}

#[test]
fn wildcard_endpoints_are_probed_on_loopback() {
    // 状态文件里存的是绑定的通配地址；直接连 0.0.0.0 在 Windows 上会失败
    assert_eq!(connectable("0.0.0.0:10975"), "127.0.0.1:10975");
    assert_eq!(connectable("[::]:10975"), "127.0.0.1:10975");
    assert_eq!(connectable("192.168.1.5:10975"), "192.168.1.5:10975");
    assert_eq!(connectable("127.0.0.1:10975"), "127.0.0.1:10975");
}

#[test]
fn ipv6_hosts_get_brackets_in_endpoint_text() {
    assert_eq!(address_text("0.0.0.0", 10975), "0.0.0.0:10975");
    assert_eq!(address_text("192.168.1.5", 10975), "192.168.1.5:10975");
    assert_eq!(address_text("::", 10975), "[::]:10975");
    // 端口按最后一个 `:` 取：加方括号后仍能解析
    assert_eq!(address_text("::", 10975).rsplit_once(':').unwrap().1, "10975");
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

    // 缺省：通配地址 + 默认端口 + token 留空（由 daemon 生成或复用状态文件里的）
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

// ==================== 新建 / 删除目录 ====================

#[test]
fn creates_directory_and_missing_parents() {
    let dir = temp_dir("mkdir");
    let target = dir.join("nested").join("leaf");

    let created = create_directory(target.to_string_lossy().as_ref()).expect("create");
    assert!(PathBuf::from(&created).is_dir(), "应真的建出目录：{created}");
    // 父目录不存在时一并创建
    assert!(dir.join("nested").is_dir());

    // 已存在时不报错（幂等）
    create_directory(target.to_string_lossy().as_ref()).expect("create twice");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn create_directory_rejects_relative_path() {
    let error = create_directory("relative/dir").expect_err("相对路径应被拒绝");
    assert!(error.contains("absolute"), "{error}");
}

#[test]
fn deletes_empty_directory_only() {
    let dir = temp_dir("rmdir");
    let target = dir.join("empty");
    std::fs::create_dir_all(&target).unwrap();

    let removed = delete_directory(target.to_string_lossy().as_ref(), false).expect("delete");
    assert_eq!(PathBuf::from(&removed), target);
    assert!(!target.exists(), "空目录应被删掉");

    // 非空目录在非递归模式下拒绝删除，且目录原样保留
    let full = dir.join("full");
    std::fs::create_dir_all(&full).unwrap();
    std::fs::write(full.join("note.txt"), b"x").unwrap();
    let error = delete_directory(full.to_string_lossy().as_ref(), false).expect_err("非空应被拒绝");
    assert_eq!(
        error,
        DeleteDirectoryError::NotEmpty(format!("directory is not empty: {}", full.display())),
        "非空要单独归类，Host 据此提示递归删除"
    );
    assert!(full.exists(), "非空目录必须原样保留");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn deletes_non_empty_directory_recursively() {
    let dir = temp_dir("rmdir-r");
    let target = dir.join("tree");
    std::fs::create_dir_all(target.join("nested").join("deeper")).unwrap();
    std::fs::write(target.join("nested").join("note.txt"), b"x").unwrap();

    let removed = delete_directory(target.to_string_lossy().as_ref(), true).expect("recursive delete");
    assert_eq!(PathBuf::from(&removed), target);
    assert!(!target.exists(), "整棵子树应被删掉");
    assert!(dir.exists(), "只删目标目录，不动它的父目录");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn refuses_to_delete_a_filesystem_root() {
    // 递归删除不该有「把整块盘删掉」的能力：根目录一律拒绝
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    let error = delete_directory(root, true).expect_err("根目录应被拒绝");
    assert_eq!(
        error,
        DeleteDirectoryError::Failed(format!("refusing to delete a filesystem root: {root}"))
    );
    assert!(PathBuf::from(root).exists(), "根目录当然还在");
}

#[test]
fn delete_directory_rejects_relative_path() {
    let error = delete_directory("relative/dir", false).expect_err("相对路径应被拒绝");
    assert_eq!(
        error,
        DeleteDirectoryError::Failed("path must be absolute: relative/dir".to_string())
    );
}

// ==================== 重命名目录 ====================

#[test]
fn renames_directory_in_place() {
    let dir = temp_dir("rename");
    let target = dir.join("before");
    std::fs::create_dir_all(target.join("nested")).unwrap();

    let renamed = rename_directory(target.to_string_lossy().as_ref(), "after").expect("rename");
    assert_eq!(PathBuf::from(&renamed), dir.join("after"));
    assert!(!target.exists(), "旧名字不该还在");
    assert!(dir.join("after").join("nested").is_dir(), "内容原样保留");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rename_rejects_names_that_are_not_plain_names() {
    let dir = temp_dir("rename-bad");
    let target = dir.join("dir");
    std::fs::create_dir_all(&target).unwrap();
    let path = target.to_string_lossy().to_string();

    // 空名字
    assert!(rename_directory(&path, "   ").expect_err("空名字应被拒绝").contains("empty"));
    // 带分隔符（等于移动，不开放）
    assert!(rename_directory(&path, "a/b").expect_err("分隔符应被拒绝").contains("separator"));
    assert!(rename_directory(&path, "a\\b").expect_err("分隔符应被拒绝").contains("separator"));
    // 路径穿越
    assert!(rename_directory(&path, "..").expect_err(".. 应被拒绝").contains("traversal"));
    assert!(rename_directory(&path, ".").expect_err(". 应被拒绝").contains("traversal"));
    assert!(target.is_dir(), "拒绝后目录原样保留");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rename_refuses_existing_target() {
    let dir = temp_dir("rename-exists");
    let source = dir.join("source");
    let taken = dir.join("taken");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&taken).unwrap();

    let error = rename_directory(source.to_string_lossy().as_ref(), "taken").expect_err("已存在应被拒绝");
    assert!(error.contains("already exists"), "{error}");
    assert!(source.is_dir(), "源目录原样保留");
    assert!(taken.is_dir(), "目标目录不能被覆盖");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rename_rejects_relative_path() {
    let error = rename_directory("relative/dir", "x").expect_err("相对路径应被拒绝");
    assert!(error.contains("absolute"), "{error}");
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

/// 真实 Core 进程工厂（单连接用例不开工作区，工厂不会被真正调用）
fn system_spawner() -> Arc<dyn CoreSpawner> {
    Arc::new(daemon::SystemCoreSpawner::current_exe().expect("current exe"))
}

/// 单连接用例的空事件源：调用方拿到 `Sender` 后直接丢弃（不需要停机广播注入）
fn detached_events() -> (Sender<DaemonEvent>, Receiver<DaemonEvent>) {
    mpsc::channel()
}

fn start_server(token: &str) -> (std::net::SocketAddr, thread::JoinHandle<ChannelExit>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let address = listener.local_addr().expect("addr");
    let token = token.to_string();
    let handle = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        serve_connection(
            stream,
            &token,
            remote_daemon_options(),
            system_spawner(),
            detached_events(),
        )
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

    // 新建目录：父目录不存在时一并创建
    let created_path = dir.join("made").join("leaf");
    let request = format!(
        "{{\"kind\":\"createDirectory\",\"id\":8,\"path\":{}}}\n",
        serde_json::to_string(&created_path.to_string_lossy().to_string()).unwrap()
    );
    client.write_all(request.as_bytes()).unwrap();
    let created = read_line(&mut reader);
    assert!(created.contains("\"directoryCreated\""), "{created}");
    assert!(created.contains("\"id\":8"), "{created}");
    assert!(created_path.is_dir(), "应真的建出目录");

    // 重命名：只改同一父目录下的名字
    let renamed_path = dir.join("made").join("renamed");
    let request = format!(
        "{{\"kind\":\"renameDirectory\",\"id\":12,\"path\":{},\"name\":\"renamed\"}}\n",
        serde_json::to_string(&created_path.to_string_lossy().to_string()).unwrap()
    );
    client.write_all(request.as_bytes()).unwrap();
    let renamed = read_line(&mut reader);
    assert!(renamed.contains("\"directoryRenamed\""), "{renamed}");
    assert!(renamed.contains("\"id\":12"), "{renamed}");
    assert!(renamed_path.is_dir(), "新名字应存在");
    assert!(!created_path.exists(), "旧名字不该还在");

    // 再改回来，后面的删除用例仍按原路径断言
    let request = format!(
        "{{\"kind\":\"renameDirectory\",\"id\":13,\"path\":{},\"name\":\"leaf\"}}\n",
        serde_json::to_string(&renamed_path.to_string_lossy().to_string()).unwrap()
    );
    client.write_all(request.as_bytes()).unwrap();
    assert!(read_line(&mut reader).contains("\"directoryRenamed\""));

    // 删除空目录
    let request = format!(
        "{{\"kind\":\"deleteDirectory\",\"id\":9,\"path\":{},\"recursive\":false}}\n",
        serde_json::to_string(&created_path.to_string_lossy().to_string()).unwrap()
    );
    client.write_all(request.as_bytes()).unwrap();
    let deleted = read_line(&mut reader);
    assert!(deleted.contains("\"directoryDeleted\""), "{deleted}");
    assert!(!created_path.exists(), "空目录应被删掉");

    // 非递归删非空目录：回 directoryFailed 且 reason=notEmpty，目录原样保留
    let request = format!(
        "{{\"kind\":\"deleteDirectory\",\"id\":10,\"path\":{},\"recursive\":false}}\n",
        serde_json::to_string(&dir.to_string_lossy().to_string()).unwrap()
    );
    client.write_all(request.as_bytes()).unwrap();
    let failed = read_line(&mut reader);
    assert!(failed.contains("\"directoryFailed\""), "{failed}");
    assert!(failed.contains("\"id\":10"), "{failed}");
    assert!(failed.contains("\"reason\":\"notEmpty\""), "{failed}");
    assert!(dir.exists(), "非空目录必须原样保留");

    // 递归删除：整棵子树消失
    let request = format!(
        "{{\"kind\":\"deleteDirectory\",\"id\":11,\"path\":{},\"recursive\":true}}\n",
        serde_json::to_string(&dir.to_string_lossy().to_string()).unwrap()
    );
    client.write_all(request.as_bytes()).unwrap();
    let removed = read_line(&mut reader);
    assert!(removed.contains("\"directoryDeleted\""), "{removed}");
    assert!(removed.contains("\"id\":11"), "{removed}");
    assert!(!dir.exists(), "递归删除应清掉整棵子树");

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
    let path = dir.join(daemon_state_file_name());
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
        .filter(|name| *name != daemon_state_file_name())
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
    let path = dir.join(daemon_state_file_name());
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
    let path = dir.join(daemon_state_file_name());
    assert_eq!(read_daemon_state_at(&path), None, "文件不存在时返回 None");
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(read_daemon_state_at(&path), None);
    std::fs::remove_dir_all(&dir).ok();
}

// ==================== token 取值 ====================

/// `--token` > token 文件里的 > 新随机；三种情况都把结果写回 token 文件。
#[test]
fn token_prefers_argument_then_file_then_random() {
    let dir = temp_dir("token");
    let path = dir.join(daemon_token_file_name());
    let mut options = RemoteOptions::default();

    // 都没有：新随机（32 位十六进制），并落盘
    let generated = resolve_token(&options, &path);
    assert!(is_hex(&generated), "应生成 32 位十六进制：{generated}");
    assert_eq!(read_token_file(&path).as_deref(), Some(generated.as_str()));

    // 已有 token 文件：复用文件里的（即使内容被手工改过）
    std::fs::write(&path, "from-file\n").unwrap();
    assert_eq!(resolve_token(&options, &path), "from-file");

    // 显式给了 --token：用它，并覆盖文件里的
    options.token = "from-arg".to_string();
    assert_eq!(resolve_token(&options, &path), "from-arg");
    assert_eq!(read_token_file(&path).as_deref(), Some("from-arg"));

    // 文件是空内容：视同没有，重新生成
    std::fs::write(&path, "   \n").unwrap();
    options.token = String::new();
    let regenerated = resolve_token(&options, &path);
    assert!(is_hex(&regenerated), "空文件应触发重新生成：{regenerated}");
    assert_eq!(read_token_file(&path).as_deref(), Some(regenerated.as_str()));

    std::fs::remove_dir_all(&dir).ok();
}

/// token 文件与状态文件分开：`kill` 删状态文件后 token 仍在，重启不必重新抄连接串。
#[test]
fn token_survives_state_file_removal() {
    let dir = temp_dir("token-survives");
    let token_path = dir.join(daemon_token_file_name());
    let state_path = dir.join(daemon_state_file_name());
    let options = RemoteOptions::default();

    let first = resolve_token(&options, &token_path);
    write_daemon_state(
        &state_path,
        &DaemonState {
            requested: "127.0.0.1:10975".to_string(),
            endpoint: "127.0.0.1:10975".to_string(),
            token: first.clone(),
        },
    )
    .unwrap();
    // kill 只删状态文件
    std::fs::remove_file(&state_path).unwrap();

    assert_eq!(resolve_token(&options, &token_path), first, "token 应跨 kill 保留");

    std::fs::remove_dir_all(&dir).ok();
}

// ==================== 启动器的复用判断 ====================

/// 状态文件缺失 / 端口连不上：都按「没有 daemon」处理（要拉起）。
#[test]
fn existing_daemon_is_none_without_a_live_listener() {
    let dir = temp_dir("existing-none");
    let path = dir.join(daemon_state_file_name());
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
    let path = dir.join(daemon_state_file_name());
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
    assert_eq!(stop_daemon(&state, STOP_TIMEOUT), StopOutcome::Stopped);
    assert_eq!(server.join().expect("server thread"), ChannelExit::Stop);
}

/// token 对不上：报「拒绝」，不假装停掉了（也不能把状态文件当成已清理）。
#[test]
fn stop_daemon_refuses_on_token_mismatch() {
    let (address, server) = start_server("secret");
    let state = DaemonState {
        requested: requested_key(&RemoteOptions::default()),
        endpoint: address.to_string(),
        token: "another".to_string(),
    };
    match stop_daemon(&state, STOP_TIMEOUT) {
        StopOutcome::Refused(error) => {
            assert!(error.contains("rejected the stored token"), "{error}");
        }
        outcome => panic!("token 不匹配应报 Refused，实际是 {outcome:?}"),
    }
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
    assert_eq!(stop_daemon(&state, STOP_TIMEOUT), StopOutcome::Unreachable);
}

/// 对端连得上但协议无应答（accept 循环被死连接占住的 wedged daemon）：
/// 报「无响应」，`kill` 据此走进程兜底，而不是把超时当成失败挂起。
#[test]
fn stop_daemon_reports_unresponsive_when_the_server_never_answers() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    // 假 daemon：只 accept，从不读——写进来的 auth 永远没人处理
    let holder = thread::spawn(move || {
        let (_stream, _) = listener.accept().expect("accept");
        thread::sleep(Duration::from_secs(10));
    });
    let state = DaemonState {
        requested: requested_key(&RemoteOptions::default()),
        endpoint: address.to_string(),
        token: "secret".to_string(),
    };
    assert_eq!(
        stop_daemon(&state, Duration::from_millis(300)),
        StopOutcome::Unresponsive
    );
    holder.join().expect("holder thread");
}

/// 兜底强杀只匹配「本可执行文件 + `start-daemon`」的进程，其它一律放过。
#[test]
fn find_daemon_pids_matches_only_the_start_daemon_cmdline() {
    let root = temp_dir("proc");
    let exe = std::env::current_exe().unwrap();
    let exe_text = exe.to_string_lossy().to_string();
    let nul = char::from_u32(0).unwrap();
    let write = |pid: &str, argv: &[&str]| {
        let dir = root.join(pid);
        std::fs::create_dir_all(&dir).unwrap();
        let joined: Vec<String> = argv.iter().map(|arg| arg.to_string()).collect();
        std::fs::write(dir.join("cmdline"), joined.join(&nul.to_string())).unwrap();
    };
    write("101", &[&exe_text, "start-daemon", "--host", "127.0.0.1"]);
    write("102", &[&exe_text, "kill"]);
    write("103", &["/bin/other", "start-daemon"]);
    write("104", &[&exe_text, "start"]);
    // 自己的 pid 即使 cmdline 匹配也必须跳过
    let self_pid = std::process::id().to_string();
    write(&self_pid, &[&exe_text, "start-daemon"]);

    let pids = find_daemon_pids(&root, &exe);
    assert_eq!(pids, vec![101], "只该匹配 101 号进程，实际 {pids:?}");
    std::fs::remove_dir_all(&root).ok();
}

// ==================== 鉴权超时与心跳（端到端）====================

/// 连接后不发 `auth` 的探活连接 / 端口扫描不能长期占住 accept 循环：
/// auth 超时后服务端关闭连接（客户端读到 EOF），daemon 回到 accept。
#[test]
fn silent_connection_is_dropped_after_auth_timeout() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let address = listener.local_addr().expect("addr");
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        serve_connection(
            stream,
            "secret",
            DaemonOptions {
                auth_timeout: Duration::from_millis(200),
                ..remote_daemon_options()
            },
            system_spawner(),
            detached_events(),
        )
    });
    let client = TcpStream::connect(address).expect("connect");
    client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    // 什么都不发：超时后服务端关闭连接，读到 EOF
    let mut reader = BufReader::new(client.try_clone().unwrap());
    let mut line = String::new();
    let read = reader.read_line(&mut line).expect("read after auth timeout");
    assert_eq!(read, 0, "探活连接应在超时后被关闭");
    assert_eq!(server.join().expect("server thread"), ChannelExit::Continue);
}

/// 心跳端到端：`ping` 之后沉默，daemon 在心跳超时后按断开处理（回到 accept）。
#[test]
fn heartbeat_silence_ends_the_connection() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let address = listener.local_addr().expect("addr");
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        serve_connection(
            stream,
            "secret",
            DaemonOptions {
                heartbeat_timeout: Some(Duration::from_millis(300)),
                ..remote_daemon_options()
            },
            system_spawner(),
            detached_events(),
        )
    });
    let mut client = TcpStream::connect(address).expect("connect");
    client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(client.try_clone().unwrap());
    client
        .write_all(b"{\"kind\":\"auth\",\"token\":\"secret\"}\n")
        .unwrap();
    assert!(read_line(&mut reader).contains("\"authOk\""));
    client.write_all(b"{\"kind\":\"ping\"}\n").unwrap();
    // daemon 对 ping 回 pong（Host 靠它武装沉默判定）；此后沉默：心跳超时（300ms）
    // 后 daemon 关闭连接，读到 EOF
    let pong = read_line(&mut reader);
    assert!(pong.contains("\"pong\""), "ping 应得到 pong 应答");
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .expect("read after heartbeat timeout");
    assert_eq!(read, 0, "心跳沉默后连接应被 daemon 关闭");
    assert_eq!(server.join().expect("server thread"), ChannelExit::Continue);
}

/// 状态文件只在内容仍是自己那份时才删（新 daemon 可能已经覆盖过它）。
#[test]
fn state_file_is_removed_only_when_unchanged() {
    let dir = temp_dir("remove-state");
    let path = dir.join(daemon_state_file_name());
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

// ==================== 多客户端并发 ====================

/// 假 Core 进程：记录收到的行与 kill（与 `daemon_tests` 的同名夹具同形）
#[derive(Default)]
struct FakeChild {
    /// 收到的内层帧行（不含换行）
    lines: Mutex<Vec<String>>,
    killed: AtomicBool,
}

struct FakeHandle {
    child: Arc<FakeChild>,
}

impl daemon::CoreProcessHandle for FakeHandle {
    fn send_line(&self, line: &str) -> std::io::Result<()> {
        self.child.lines.lock().unwrap().push(line.to_string());
        Ok(())
    }

    fn kill(&self) {
        self.child.killed.store(true, Ordering::SeqCst);
    }
}

/// 假 Core 进程工厂：每次 spawn 记一个新孩子（多客户端用例不依赖真实可执行文件）
#[derive(Default)]
struct FakeSpawner {
    children: Mutex<Vec<Arc<FakeChild>>>,
    spawns: AtomicUsize,
}

impl CoreSpawner for FakeSpawner {
    fn spawn(
        &self,
        _channel: u64,
        _sink: Arc<dyn daemon::CoreEventSink>,
    ) -> std::io::Result<Box<dyn daemon::CoreProcessHandle>> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let child = Arc::new(FakeChild::default());
        self.children.lock().unwrap().push(Arc::clone(&child));
        Ok(Box::new(FakeHandle { child }))
    }
}

/// 常驻 daemon 夹具：真实 TCP listener + `accept_loop` 线程 + 假 Core 工厂。
///
/// `run_start_daemon` 的主线程角色（等停机、等收尾）由用例自己扮演
/// （`expect_stop_and_drain`）；真实入口里它等的是同一组运行时方法。
struct TestDaemon {
    address: std::net::SocketAddr,
    runtime: Arc<DaemonRuntime>,
    spawner: Arc<FakeSpawner>,
}

impl TestDaemon {
    fn start(token: &str, options: DaemonOptions) -> TestDaemon {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let address = listener.local_addr().expect("addr");
        let runtime = Arc::new(DaemonRuntime::new());
        let spawner: Arc<FakeSpawner> = Arc::new(FakeSpawner::default());
        {
            let runtime = Arc::clone(&runtime);
            let spawner = Arc::clone(&spawner) as Arc<dyn CoreSpawner>;
            let token = token.to_string();
            thread::spawn(move || accept_loop(listener, &token, options, runtime, spawner));
        }
        TestDaemon {
            address,
            runtime,
            spawner,
        }
    }

    /// 建链并鉴权，返回可继续操作的客户端
    fn connect(&self, token: &str) -> TestClient {
        TestClient::connect(self.address, token)
    }

    /// 第 index 次 spawn 出的假 Core 进程
    fn child(&self, index: usize) -> Arc<FakeChild> {
        self.spawner.children.lock().unwrap()[index].clone()
    }

    fn spawn_count(&self) -> usize {
        self.spawner.spawns.load(Ordering::SeqCst)
    }

    /// 轮询直到第 index 个孩子收到 `expected` 行（或超时）
    fn wait_for_lines(&self, index: usize, expected: usize) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let lines = self.child(index).lines.lock().unwrap().clone();
            if lines.len() >= expected {
                return lines;
            }
            assert!(Instant::now() < deadline, "core did not receive frames in time");
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// 轮询直到第 index 个孩子被 kill
    fn wait_killed(&self, index: usize) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.child(index).killed.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "core was not killed in time");
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// 扮演 `run_start_daemon` 的主线程：等停机置位、等全部连接收尾（返回即
    /// 全部连接的 Core 已被各自的会话关闭，进程此刻会退出）。
    fn expect_stop_and_drain(&self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.runtime.is_stopping() {
            assert!(
                Instant::now() < deadline,
                "shutdown was not requested in time"
            );
            thread::sleep(Duration::from_millis(5));
        }
        self.runtime.wait_until_drained(Duration::from_secs(2));
    }
}

impl Drop for TestDaemon {
    fn drop(&mut self) {
        // 用例结束即停机：掐断全部连接与 accept 线程，不留悬挂线程到下一个用例
        self.runtime.begin_stop();
    }
}

/// 测试客户端：一条已鉴权的控制连接
struct TestClient {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
}

impl TestClient {
    fn connect(address: std::net::SocketAddr, token: &str) -> TestClient {
        let mut stream = TcpStream::connect(address).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let request = format!(
            "{{\"kind\":\"auth\",\"token\":{}}}\n",
            serde_json::to_string(token).unwrap()
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let line = read_line(&mut reader);
        assert!(line.contains("\"authOk\""), "鉴权应通过：{line}");
        TestClient { stream, reader }
    }

    fn send(&mut self, value: &serde_json::Value) {
        self.stream
            .write_all(format!("{value}\n").as_bytes())
            .expect("send frame");
    }

    fn next_frame(&mut self) -> serde_json::Value {
        let line = read_line(&mut self.reader);
        serde_json::from_str(line.trim_end()).expect("valid daemon frame")
    }

    /// 打开一个工作区，返回 daemon 分配的 channel
    fn open_workspace(&mut self, id: u64, path: &str) -> u64 {
        self.send(&json!({
            "kind": "openWorkspace",
            "id": id,
            "workspaceRef": { "scheme": "file", "path": path, "endpoint": null },
        }));
        let opened = self.next_frame();
        assert_eq!(opened["kind"], "workspaceOpened", "{opened}");
        assert_eq!(opened["id"], id, "{opened}");
        opened["channel"].as_u64().expect("channel id")
    }

    /// 断言 `duration` 内没有任何入站帧（channel 不 reset、Core 不重启的观察面）
    fn assert_no_frame_within(&mut self, duration: Duration) {
        // 超时必须设到真正执行读的句柄上：Windows 上克隆 socket 句柄各自持有选项
        // 快照，改原句柄不影响已建克隆的读
        self.reader.get_ref().set_read_timeout(Some(duration)).unwrap();
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            other => panic!("expected silence, got {other:?} / {line:?}"),
        }
        self.reader
            .get_ref()
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
    }
}

/// 两条并发连接各自鉴权、各自得到自己的应答：客户端身份是鉴权成功的连接，
/// 同一时刻可同时服务多条。
#[test]
fn two_connections_serve_concurrently() {
    let daemon = TestDaemon::start("secret", remote_daemon_options());
    let dir = temp_dir("multi");
    std::fs::create_dir_all(dir.join("alpha")).unwrap();
    std::fs::create_dir_all(dir.join("beta")).unwrap();

    let mut first = daemon.connect("secret");
    let mut second = daemon.connect("secret");

    // 各自列自己的目录：应答只回各自的连接（id 相同也不串线）
    for (client, id, marker) in [
        (&mut first, 1u64, "alpha"),
        (&mut second, 2u64, "beta"),
    ] {
        let request = json!({
            "kind": "listDirectories",
            "id": id,
            "path": dir.to_string_lossy(),
        });
        client.send(&request);
        let listed = client.next_frame();
        assert_eq!(listed["kind"], "directoriesListed", "{listed}");
        assert_eq!(listed["id"], id, "{listed}");
        let text = listed.to_string();
        assert!(text.contains(marker), "应列出本连接请求的目录：{text}");
    }

    drop(first);
    drop(second);
    std::fs::remove_dir_all(&dir).ok();
}

/// 两条连接各自 openWorkspace：channel id 按连接独立分配，两个 Core 进程互相独立，
/// 内层帧各走各的进程。
#[test]
fn two_connections_get_independent_channels_and_cores() {
    let daemon = TestDaemon::start("secret", remote_daemon_options());
    let mut first = daemon.connect("secret");
    let mut second = daemon.connect("secret");

    // 同一个工作区路径：两个客户端各得一个独立 Core（对齐本地多窗口语义）
    let channel_a = first.open_workspace(1, "D:/repo/shared");
    let channel_b = second.open_workspace(1, "D:/repo/shared");
    assert_eq!(channel_a, 1, "channel id 按连接独立分配，从 1 起");
    assert_eq!(channel_b, 1);
    assert_eq!(daemon.spawn_count(), 2, "两个互相独立的 Core 进程");

    // 内层帧各走各的 Core
    first.send(&json!({
        "kind": "frame", "channel": channel_a,
        "frame": { "kind": "hello", "protocol": 2 },
    }));
    second.send(&json!({
        "kind": "frame", "channel": channel_b,
        "frame": { "kind": "hello", "protocol": 3 },
    }));
    assert_eq!(
        daemon.wait_for_lines(0, 1)[0],
        "{\"kind\":\"hello\",\"protocol\":2}"
    );
    assert_eq!(
        daemon.wait_for_lines(1, 1)[0],
        "{\"kind\":\"hello\",\"protocol\":3}"
    );
}

/// 一端断开：它的 Core 收到 shutdown 并被关闭；另一端的 channel 不 reset、
/// Core 不重启、连接继续可用。
#[test]
fn disconnecting_one_connection_leaves_the_other_untouched() {
    let daemon = TestDaemon::start("secret", remote_daemon_options());
    let mut first = daemon.connect("secret");
    let mut second = daemon.connect("secret");
    let channel_a = first.open_workspace(1, "D:/repo/a");
    let channel_b = second.open_workspace(2, "D:/repo/b");
    assert_eq!(channel_a, 1);
    assert_eq!(channel_b, 1);
    assert_eq!(daemon.spawn_count(), 2);

    // 一端断开：它的 Core 收到 shutdown 行并被 kill
    drop(first);
    daemon.wait_killed(0);
    let lines = daemon.child(0).lines.lock().unwrap().clone();
    assert_eq!(
        lines.last().map(String::as_str),
        Some("{\"kind\":\"shutdown\"}"),
        "断开应收尾关闭该连接的 Core：{lines:?}"
    );

    // 另一端不受影响：没有 channelReset / workspaceClosed，Core 不重启
    assert_eq!(daemon.spawn_count(), 2, "另一端的 Core 不得重启");
    assert!(!daemon.child(1).killed.load(Ordering::SeqCst));
    second.assert_no_frame_within(Duration::from_millis(300));
    // 且还能继续服务
    second.send(&json!({ "kind": "ping" }));
    let pong = second.next_frame();
    assert_eq!(pong["kind"], "pong", "{pong}");
}

/// 任一连接发 `shutdown` → 结束整个 daemon：全部连接的 Core 都被关闭，收尾后退出。
#[test]
fn shutdown_from_one_connection_ends_the_whole_daemon() {
    let daemon = TestDaemon::start("secret", remote_daemon_options());
    let mut first = daemon.connect("secret");
    let mut second = daemon.connect("secret");
    first.open_workspace(1, "D:/repo/a");
    second.open_workspace(2, "D:/repo/b");
    assert_eq!(daemon.spawn_count(), 2);

    // shutdown 是全局生效的 kill 语义：另一条连接的 Core 也一并关闭
    first.send(&json!({ "kind": "shutdown" }));
    daemon.expect_stop_and_drain();

    // 两端 Core 都被各自的会话收尾关闭（第二连接经停机广播 → Host 断开路径）
    daemon.wait_killed(0);
    daemon.wait_killed(1);
}

/// 连上后不发 `auth` 的探活连接不再阻塞后续接入：第二条连接在第一条的鉴权
/// 超时窗口（默认 10s）内就能完成鉴权并得到服务。
#[test]
fn probe_connection_does_not_block_the_next_one() {
    let daemon = TestDaemon::start("secret", remote_daemon_options());
    // 探活：连上后什么都不发
    let _probe = TcpStream::connect(daemon.address).expect("probe connect");
    let connected_at = Instant::now();

    // 第二条连接立刻接入并完成鉴权（远在第一条的 10s 鉴权超时窗口之内）
    let mut second = daemon.connect("secret");
    assert!(
        connected_at.elapsed() < Duration::from_secs(9),
        "第二条应在第一条的鉴权超时窗口内完成鉴权"
    );
    // daemon 已在并发服务第二条连接
    second.send(&json!({ "kind": "ping" }));
    let pong = second.next_frame();
    assert_eq!(pong["kind"], "pong", "{pong}");

    // 探活连接自己的超时回收由 `silent_connection_is_dropped_after_auth_timeout`
    // 覆盖（短上限版），这里不等 10s。
}

// ==================== 空闲退出（`--idle-exit`，`docs/core-daemon.md` 第 12.5 节）====================
//
// 客户端异常退出（crash / 断电）后远端不留常驻进程：daemon 在没有任何控制连接持续
// `--idle-exit` 秒后自行退出。这里直接测 `wait_for_stop_or_idle` 的时序语义。

use std::sync::Arc;

/// 造一个可登记的连接登记项（事件通道的 rx 即刻丢弃：广播 send 失败无需处理）
fn idle_entry() -> ConnectionEntry {
    let (events, _rx) = mpsc::channel::<DaemonEvent>();
    ConnectionEntry {
        events,
        socket: None,
    }
}

#[test]
fn idle_exit_fires_when_no_connection_ever_arrives() {
    let runtime = Arc::new(DaemonRuntime::new());
    let (done_tx, done_rx) = mpsc::channel();
    {
        let runtime = Arc::clone(&runtime);
        std::thread::spawn(move || {
            let _ = done_tx.send(runtime.wait_for_stop_or_idle(Some(Duration::from_millis(80))));
        });
    }
    // 启动后一直没有连接：死线从启动起算，到期走空闲退出（返回 false = 非 shutdown）
    let stopped = done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("idle waiter should return at the deadline");
    assert!(!stopped, "到期应报空闲退出，而不是 shutdown");
    // 收尾置停机位后，迟到的连接被拒绝，不会接在一个将死的 daemon 上
    runtime.begin_stop();
    assert!(runtime.register(idle_entry()).is_none(), "停机位应拒绝新连接");
}

#[test]
fn idle_exit_counts_from_the_last_connection_drop() {
    let runtime = Arc::new(DaemonRuntime::new());
    let (done_tx, done_rx) = mpsc::channel();
    {
        let runtime = Arc::clone(&runtime);
        std::thread::spawn(move || {
            let _ = done_tx.send(runtime.wait_for_stop_or_idle(Some(Duration::from_millis(120))));
        });
    }
    // 有连接期间不计时：等过整个 idle 窗口再加余量，等待者必须还活着
    let id = runtime
        .register(idle_entry())
        .expect("register while not stopping");
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        done_rx.try_recv().is_err(),
        "有连接时空闲退出不应触发"
    );
    // 最后一条连接断开：死线从断开时刻重新起算
    let started = std::time::Instant::now();
    runtime.unregister(id);
    let stopped = done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("idle waiter should return after the disconnect");
    assert!(!stopped);
    assert!(
        started.elapsed() >= Duration::from_millis(100),
        "idle 应从最后一条连接断开起算（实际 {:?}）",
        started.elapsed()
    );
}

#[test]
fn shutdown_wins_over_idle_exit() {
    let runtime = Arc::new(DaemonRuntime::new());
    let (done_tx, done_rx) = mpsc::channel();
    {
        let runtime = Arc::clone(&runtime);
        std::thread::spawn(move || {
            // idle 远未到期：shutdown 必须先行
            let _ = done_tx.send(runtime.wait_for_stop_or_idle(Some(Duration::from_secs(30))));
        });
    }
    std::thread::sleep(Duration::from_millis(50));
    runtime.begin_stop();
    let stopped = done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("waiter should return on shutdown");
    assert!(stopped, "shutdown 先到应报停机，而不是空闲退出");
}
