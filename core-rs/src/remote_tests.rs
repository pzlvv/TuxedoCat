//! 远程监听模式用例（`docs/core-daemon.md` 第 12 节）：
//! token 生成与定长比较、连接串、命令行解析、目录列举，以及一条真实 TCP
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

/// `--token` > token 文件里的 > 新随机；三种情况都把结果写回 token 文件。
#[test]
fn token_prefers_argument_then_file_then_random() {
    let dir = temp_dir("token");
    let path = dir.join(DAEMON_TOKEN_FILE_NAME);
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
    let token_path = dir.join(DAEMON_TOKEN_FILE_NAME);
    let state_path = dir.join(DAEMON_STATE_FILE_NAME);
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
