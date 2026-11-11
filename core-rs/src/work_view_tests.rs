//! 对话工作视图（specs/043）的用例。
//!
//! 每条用例都在 `fork` 出的单线程子进程里跑：`unshare(CLONE_NEWUSER)` 要求调用者
//! `mm_users == 1`，而测试进程是多线程的（cargo test 默认并行）。父进程只负责建沙箱
//! 与收结果，子进程进入命名空间后执行断言。
//!
//! 串行由 `Sandbox::new` 内部持有的全局闸门保证。

use crate::test_support::Sandbox;

/// 测试用的内核接口：与实现同口径，直接声明 FFI 而不引 `libc` 依赖
/// （新增直接依赖会改变 cargo 依赖图指纹，让 Windows 目标重编 `ring`）。
mod sys {
    pub type CInt = i32;
    extern "C" {
        pub fn pipe(fds: *mut CInt) -> CInt;
        pub fn fork() -> CInt;
        pub fn close(fd: CInt) -> CInt;
        pub fn read(fd: CInt, buf: *mut std::os::raw::c_void, count: usize) -> isize;
        pub fn waitpid(pid: CInt, status: *mut CInt, options: CInt) -> CInt;
        pub fn _exit(code: CInt) -> !;
    }
}

/// 在 fork 出的子进程里跑 `body`；非零退出即失败。
fn in_namespace(name: &str, body: fn(&Sandbox)) {
    let sandbox = Sandbox::new(name);
    sandbox.write_file("existing.txt", "from-workspace\n");
    std::fs::create_dir_all(sandbox.workspace.join("node_modules")).unwrap();
    std::fs::write(sandbox.workspace.join("node_modules/dep.js"), "dep\n").unwrap();

    let mut fds = [0i32; 2];
    assert_eq!(unsafe { sys::pipe(fds.as_mut_ptr()) }, 0, "pipe failed");
    let (read_fd, write_fd) = (fds[0], fds[1]);

    let pid = unsafe { sys::fork() };
    assert!(pid >= 0, "fork failed");
    if pid == 0 {
        unsafe { sys::close(read_fd) };
        crate::work_view::enter();
        if crate::work_view::capabilities().isolated_work_view {
            // 子进程里的断言失败必须变成非零退出码：`fork` 之后 panic 只会在子进程里
            // unwind 到底，父进程看不到，测试会误报 ok（实测过：Write 没写进视图，
            // 子进程 panic 了，父进程仍判通过）。捕获 panic 后按 1 退出。
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                body(&sandbox);
            }));
            let code = if result.is_ok() { 0 } else { 1 };
            unsafe { sys::_exit(code) };
        }
        // 能力不可用（CI 容器禁 namespaces）：子进程以 77 退出，父进程登记为跳过
        unsafe { sys::_exit(77) };
    }

    unsafe { sys::close(write_fd) };
    let mut buffer = vec![0u8; 8192];
    let mut text = String::new();
    loop {
        let read = unsafe { sys::read(read_fd, buffer.as_mut_ptr() as *mut _, buffer.len()) };
        if read <= 0 {
            break;
        }
        text.push_str(&String::from_utf8_lossy(&buffer[..read as usize]));
    }
    let mut status = 0;
    unsafe { sys::waitpid(pid, &mut status, 0) };
    unsafe { sys::close(read_fd) };

    let code = (status >> 8) & 0xff;
    if code == 77 {
        eprintln!("{name}: 跳过（本机不支持用户命名空间 / overlayfs）");
        return;
    }
    assert_eq!(code, 0, "{name} 失败：{text}");
}

/// 视图建立后能列出工作区已有文件，且写入只落上层（specs/043 FR-002 / FR-003）。
#[test]
fn work_view_mounts_overlay_over_workspace() {
    in_namespace("work-view-mounts", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-mounts";
        let mut view = crate::work_view::WorkView::register(&workspace, session)
            .expect("登记视图");
        view.ensure_mounted().expect("挂载视图");
        let mount = view.mount_point().expect("挂载点");

        let existing = std::fs::read_to_string(mount.join("existing.txt")).expect("读基线文件");
        assert_eq!(existing, "from-workspace\n");
        let dep =
            std::fs::read_to_string(mount.join("node_modules/dep.js")).expect("读 node_modules");
        assert_eq!(dep, "dep\n");

        std::fs::write(mount.join("existing.txt"), "changed\n").expect("写视图");
        std::fs::write(mount.join("created.txt"), "new\n").expect("新建");
        assert_eq!(
            std::fs::read_to_string(mount.join("existing.txt")).unwrap(),
            "changed\n"
        );
        assert_eq!(
            std::fs::read_to_string(sandbox.workspace.join("existing.txt")).unwrap(),
            "from-workspace\n",
            "磁盘上的原文件必须不变"
        );
        assert!(
            !sandbox.workspace.join("created.txt").exists(),
            "新建文件不得出现在磁盘上"
        );
    });
}

/// 两个会话各自一份上层，互不可见（specs/043 FR-004）。
#[test]
fn work_view_isolates_two_sessions() {
    in_namespace("work-view-isolates", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let mut a = crate::work_view::WorkView::register(&workspace, "sess-a").expect("A");
        let mut b = crate::work_view::WorkView::register(&workspace, "sess-b").expect("B");
        a.ensure_mounted().expect("挂 A");
        b.ensure_mounted().expect("挂 B");
        let mount_a = a.mount_point().expect("A mount");
        let mount_b = b.mount_point().expect("B mount");

        std::fs::write(mount_a.join("a-only.txt"), "a\n").expect("A 写");
        std::fs::write(mount_a.join("existing.txt"), "a-changed\n").expect("A 改");

        assert!(
            !mount_b.join("a-only.txt").exists(),
            "A 新建的文件不得出现在 B 里"
        );
        assert_eq!(
            std::fs::read_to_string(mount_b.join("existing.txt")).unwrap(),
            "from-workspace\n",
            "B 必须看到磁盘原内容，不是 A 的改动"
        );
    });
}

/// 删除文件与目录在视图内生效、磁盘不变（specs/043 FR-005）。
#[test]
fn work_view_delete_keeps_baseline() {
    in_namespace("work-view-delete", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let mut view = crate::work_view::WorkView::register(&workspace, "sess-delete")
            .expect("登记");
        view.ensure_mounted().expect("挂载");
        let mount = view.mount_point().expect("挂载点");

        std::fs::remove_file(mount.join("existing.txt")).expect("删除文件");
        assert!(!mount.join("existing.txt").exists(), "视图内必须不可见");
        assert!(
            sandbox.workspace.join("existing.txt").exists(),
            "磁盘上的文件必须还在"
        );

        std::fs::remove_dir_all(mount.join("node_modules")).expect("删除目录");
        assert!(
            !mount.join("node_modules").exists(),
            "视图内目录必须不可见"
        );
        assert!(
            sandbox.workspace.join("node_modules/dep.js").exists(),
            "磁盘上的目录必须还在"
        );
    });
}

/// 释放保留上层、回收删除目录（specs/043 FR-006）。
#[test]
fn work_view_release_and_remove() {
    in_namespace("work-view-release", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-release";
        let mut view =
            crate::work_view::WorkView::register(&workspace, session).expect("登记");
        view.ensure_mounted().expect("挂载");
        let mount = view.mount_point().expect("挂载点");
        std::fs::write(mount.join("kept.txt"), "kept\n").expect("写");
        let root = crate::work_view::WorkView::root_of(&workspace, session).expect("根");

        crate::work_view::release(&workspace, session);
        assert!(
            root.join("upper/kept.txt").exists(),
            "释放必须保留上层改动"
        );

        crate::work_view::remove(&workspace, session).expect("回收");
        assert!(!root.exists(), "回收必须删掉整个视图目录");
    });
}

/// 句柄只在挂载后可用，且路径映射双向一致（specs/043 FR-002）。
#[test]
fn work_view_handle_maps_paths() {
    in_namespace("work-view-handle", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-handle";
        let mut view =
            crate::work_view::WorkView::register(&workspace, session).expect("登记");
        assert!(
            crate::work_view::WorkViewHandle::of(session).is_none(),
            "登记但未挂载时不该给出句柄"
        );
        view.ensure_mounted().expect("挂载");
        let handle = crate::work_view::WorkViewHandle::of(session).expect("句柄");

        let real = sandbox.workspace.join("existing.txt");
        let in_view = handle.to_view_path(&real).expect("映射进视图");
        assert!(in_view.starts_with(&sandbox.root));
        assert_eq!(handle.to_real_path(&in_view).expect("映射回真实"), real);
        assert_eq!(
            std::fs::read_to_string(&in_view).unwrap(),
            "from-workspace\n"
        );
    });
}

/// 真实工具链路：Write 写进视图、Read 读回来、Bash 看到同一份内容，磁盘全程不变
/// （specs/043 FR-002 / FR-003）。
///
/// 这条走 `tools::execute` 而不是直接 `std::fs`，验证的是「工具与 Bash 对视图透明」。
#[test]
fn work_view_tools_and_bash_share_the_overlay() {
    in_namespace("work-view-tools", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-tools";
        let mut view =
            crate::work_view::WorkView::register(&workspace, session).expect("登记");
        view.ensure_mounted().expect("挂载");
        let handle = crate::work_view::WorkViewHandle::of(session).expect("句柄");

        let context = crate::tools::ToolContext {
            session_id: session.to_string(),
            cwd: workspace.clone(),
            tool_use_id: None,
            on_progress: None,
            cancel: None,
            pause: None,
            user_choice: None,
            background: None,
            subagent: None,
            transfer: None,
            work_view: Some(handle),
        };

        // Write 一个磁盘上不存在的新文件
        let write = crate::tools::execute(
            "Write",
            &serde_json::json!({
                "file_path": format!("{workspace}/written.txt"),
                "content": "hello-from-view\n",
            }),
            &context,
        );
        assert!(
            matches!(write, crate::tools::ToolOutcome::SuccessWithMeta { .. }),
            "Write 必须成功：{write:?}"
        );
        // 视图内可见、磁盘上不存在
        let in_view = format!("{}/written.txt", view.mount_point().unwrap().display());
        assert_eq!(std::fs::read_to_string(&in_view).unwrap(), "hello-from-view\n");
        assert!(
            !sandbox.workspace.join("written.txt").exists(),
            "Write 不得写到磁盘"
        );

        // Read 能读回同一份内容（工具之间共享同一视图）
        let read = crate::tools::execute(
            "Read",
            &serde_json::json!({ "file_path": format!("{workspace}/written.txt") }),
            &context,
        );
        assert!(
            format!("{read:?}").contains("hello-from-view"),
            "Read 必须从视图读到刚写的内容：{read:?}"
        );

        // Bash 里同样能看到（私有挂载命名空间把视图 bind 到真实工作区路径）
        let bash = crate::tools::execute(
            "Bash",
            &serde_json::json!({
                "command": format!("cat '{workspace}/written.txt' && cat '{workspace}/node_modules/dep.js'"),
            }),
            &context,
        );
        let bash_text = format!("{bash:?}");
        assert!(
            bash_text.contains("hello-from-view"),
            "Bash 必须看到视图里的新文件：{bash_text}"
        );
        assert!(
            bash_text.contains("dep"),
            "Bash 必须能读到磁盘上的 node_modules：{bash_text}"
        );

        // 磁盘全程未被写入
        assert!(
            !sandbox.workspace.join("written.txt").exists(),
            "整轮工具调用不得在磁盘上留下文件"
        );
    });
}

/// Bash **写文件**必须落在视图上层：`gcc -o main` 这类编译产物正是这条路径。
///
/// 上面那条用例只验证 Bash 能**读到**视图内容（读走 lowerdir 也能读到）；写才区分
/// 「视图」与「真实磁盘」——`pre_exec` 的 bind 没生效时写入直接落到工作区，磁盘上
/// 出现产物而 `upper` 始终为空。
#[test]
fn work_view_bash_writes_stay_in_the_upper_layer() {
    in_namespace("work-view-bash-writes", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-bash-writes";
        let mut view =
            crate::work_view::WorkView::register(&workspace, session).expect("登记");
        view.ensure_mounted().expect("挂载");
        let handle = crate::work_view::WorkViewHandle::of(session).expect("句柄");

        let context = crate::tools::ToolContext {
            session_id: session.to_string(),
            cwd: workspace.clone(),
            tool_use_id: None,
            on_progress: None,
            cancel: None,
            pause: None,
            user_choice: None,
            background: None,
            subagent: None,
            transfer: None,
            work_view: Some(handle),
        };

        let bash = crate::tools::execute(
            "Bash",
            &serde_json::json!({
                "command": "echo built > built-by-bash.txt; cat built-by-bash.txt",
            }),
            &context,
        );
        let text = format!("{bash:?}");
        assert!(text.contains("built"), "Bash 必须读回自己写的文件：{text}");

        // 关键断言：产物在视图上层，磁盘上没有
        // `upper` 与 `mount` 同级，都在视图根目录下
        let upper = view
            .mount_point()
            .expect("挂载点")
            .parent()
            .expect("视图根目录")
            .join("upper")
            .join("built-by-bash.txt");
        assert!(
            upper.exists(),
            "Bash 写入必须落在视图上层：{} 不存在（磁盘上是否存在={}）",
            upper.display(),
            sandbox.workspace.join("built-by-bash.txt").exists()
        );
        assert!(
            !sandbox.workspace.join("built-by-bash.txt").exists(),
            "Bash 写入不得落到真实磁盘"
        );
    });
}

// ==================== 并发建立 / 注销 ====================
//
// 用例对应 `specs/defects/work-view-concurrent-first-use-double-mounts.md`。

/// 视图挂载点在 `/proc/self/mountinfo` 里出现几次。
///
/// 叠加挂载会在同一个挂载点留下多条记录，而 `mount()` 返回 0 时从返回值看不出来——这正是
/// 本组用例要盯的事实。
fn mount_entries(mount: &std::path::Path) -> usize {
    let text = mount.to_string_lossy();
    std::fs::read_to_string("/proc/self/mountinfo")
        .unwrap_or_default()
        .lines()
        .filter(|line| line.split_whitespace().nth(4) == Some(text.as_ref()))
        .count()
}

/// 首次取句柄：登记；已被别的线程登记过就取回已有记录。与 `Core::ensure_work_view` 同构。
fn open_view(workspace: &str, session: &str) -> Result<crate::work_view::WorkView, String> {
    match crate::work_view::WorkView::register(workspace, session) {
        Ok(view) => Ok(view),
        Err(reason) if reason.contains("已有工作视图") => {
            crate::work_view::WorkView::reopen(workspace, session)
        }
        Err(reason) => Err(reason),
    }
}

/// 同一会话的并发首次工具调用只能挂一层（RT-1）。
///
/// 并行工具批里 `Read` / `Grep` / `Glob` 各占一个线程，都会走到 `ensure_work_view`。
/// 建立过程没有互斥时每个线程都看到「尚未挂载」，于是同一份 `upper` 被叠加挂两次——
/// `mount(2)` 不报错，登记表也只记一层，后续 `release` 只卸得掉一层。
#[test]
fn work_view_concurrent_first_use_mounts_once() {
    in_namespace("work-view-concurrent-first-use", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-concurrent-first-use";
        let root = crate::work_view::WorkView::root_of(&workspace, session).expect("根");
        let mount = root.join("mount");

        // 两个线程同时开始：`Barrier` 保证它们都还没进 `ensure_mounted` 就被一起放行，
        // 否则「先到的挂完、后到的看到 mounted」这条正常路径会让用例假绿。
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let workspace = workspace.clone();
            let session = session.to_string();
            let barrier = std::sync::Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                let mut view = open_view(&workspace, &session)?;
                view.ensure_mounted()?;
                crate::work_view::WorkViewHandle::of(&session)
                    .map(|_| ())
                    .ok_or_else(|| "并发建立后取不到视图句柄".to_string())
            }));
        }
        for handle in handles {
            let result = handle.join().expect("线程不得 panic");
            assert!(result.is_ok(), "并发首次建立必须都成功：{result:?}");
        }

        assert_eq!(
            mount_entries(&mount),
            1,
            "同一视图只能挂一层：{} 在 mountinfo 里出现 {} 次",
            mount.display(),
            mount_entries(&mount)
        );
    });
}

/// 并发挂载之后注销与回收都要干净（RT-2）。
///
/// 叠加挂两层时 `release` 只卸一层，登记表却已清空；`remove` 因此跳过 `umount`，
/// 直接删一个仍有挂载的目录 → `EBUSY`，视图目录与挂载双双残留。
#[test]
fn work_view_release_and_remove_after_concurrent_first_use() {
    in_namespace("work-view-concurrent-release", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-concurrent-release";
        let root = crate::work_view::WorkView::root_of(&workspace, session).expect("根");
        let mount = root.join("mount");

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let workspace = workspace.clone();
            let session = session.to_string();
            let barrier = std::sync::Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                let mut view = open_view(&workspace, &session)?;
                view.ensure_mounted()
            }));
        }
        for handle in handles {
            let result = handle.join().expect("线程不得 panic");
            assert!(result.is_ok(), "并发首次建立必须都成功：{result:?}");
        }

        crate::work_view::release(&workspace, session);
        assert_eq!(
            mount_entries(&mount),
            0,
            "注销后不得残留挂载：{} 仍在 mountinfo 里",
            mount.display()
        );

        crate::work_view::remove(&workspace, session).expect("回收视图");
        assert!(!root.exists(), "回收必须删掉整个视图目录");
    });
}

/// 已注销的视图不得再挂载（RT-3）。
///
/// 对话在首次工具调用之前就关闭时，`release` 先注销登记项。之后若还有一次工具调用迟到
/// （注销与建立竞争），`ensure_mounted` 必须报错——否则会挂出一个登记表里没有、谁也回收
/// 不到的视图。
#[test]
fn work_view_mount_after_release_is_refused() {
    in_namespace("work-view-mount-after-release", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-mount-after-release";
        let root = crate::work_view::WorkView::root_of(&workspace, session).expect("根");
        let mount = root.join("mount");

        let view = crate::work_view::WorkView::register(&workspace, session).expect("登记");
        crate::work_view::release(&workspace, session);

        let mut late = view;
        assert!(late.ensure_mounted().is_err(), "已注销的视图不得再挂载");
        assert_eq!(
            mount_entries(&mount),
            0,
            "报错路径不得留下挂载：{} 在 mountinfo 里出现 {} 次",
            mount.display(),
            mount_entries(&mount)
        );
    });
}

// ==================== 列视图目录（specs/044）====================

/// 列出的条目名（按名字排序，方便断言）。
fn entry_names(entries: &[serde_json::Value]) -> Vec<String> {
    let mut names: Vec<String> = entries
        .iter()
        .filter_map(|entry| entry.get("name").and_then(|name| name.as_str()))
        .map(str::to_string)
        .collect();
    names.sort();
    names
}

/// 视图目录列出的是叠加结果：对话内新建的文件在，磁盘上的同目录没有它（specs/044 FR-002）。
#[test]
fn work_view_lists_overlay_directory() {
    in_namespace("work-view-lists", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-lists";
        let mut view = crate::work_view::WorkView::register(&workspace, session).expect("登记");
        view.ensure_mounted().expect("挂载");

        // 对话内新建（只落 upper，磁盘上没有）
        let in_view = view.mount_point().expect("挂载点").join("only-in-view.txt");
        std::fs::write(&in_view, "view\n").expect("写视图");

        let entries = crate::work_view::list_view_dir(session, "").expect("列视图根");
        let names = entry_names(&entries);
        assert!(
            names.contains(&"only-in-view.txt".to_string()),
            "对话内新建的文件必须列出：{names:?}"
        );
        assert!(
            names.contains(&"existing.txt".to_string()),
            "磁盘基线里的文件也必须列出：{names:?}"
        );
        assert!(
            !sandbox.workspace.join("only-in-view.txt").exists(),
            "该文件不得出现在真实磁盘上"
        );

        // 条目形态与本地 / SFTP 的 DirectoryEntry 一致
        let entry = entries
            .iter()
            .find(|entry| entry.get("name").and_then(|name| name.as_str()) == Some("only-in-view.txt"))
            .expect("条目");
        assert_eq!(entry.get("kind").and_then(|kind| kind.as_str()), Some("file"));
        assert!(
            entry.get("mtimeMs").map(|value| !value.is_null()).unwrap_or(false),
            "mtimeMs 必须给出（取不到时才用 null）：{entry:?}"
        );
    });
}

/// 子目录列举与越界拒绝（specs/044 FR-002 / 边界表）。
#[test]
fn work_view_lists_subdirectory_and_rejects_escape() {
    in_namespace("work-view-lists-sub", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-lists-sub";
        let mut view = crate::work_view::WorkView::register(&workspace, session).expect("登记");
        view.ensure_mounted().expect("挂载");

        // node_modules 来自 lowerdir：子目录列举必须能进去
        let entries = crate::work_view::list_view_dir(session, "node_modules").expect("列子目录");
        assert_eq!(entry_names(&entries), vec!["dep.js".to_string()]);

        for bad in ["..", "../etc", "/etc", "a/../../b"] {
            assert!(
                crate::work_view::list_view_dir(session, bad).is_err(),
                "越界路径 {bad} 必须被拒绝"
            );
        }
    });
}

/// 视图未建立（会话还没调用过工具）时列目录报错，不偷偷退回磁盘（specs/044 FR-004）。
#[test]
fn work_view_lists_nothing_when_view_not_mounted() {
    in_namespace("work-view-lists-unmounted", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-lists-unmounted";
        crate::work_view::WorkView::register(&workspace, session).expect("登记");

        let result = crate::work_view::list_view_dir(session, "");
        assert!(result.is_err(), "未挂载时不得返回磁盘内容：{result:?}");

        // 未登记过的会话同样报错
        assert!(crate::work_view::list_view_dir("sess-never-registered", "").is_err());
    });
}

/// 读视图文件：对话内新建的能读、磁盘上没有（specs/044 FR-003）。
#[test]
fn work_view_reads_file_from_overlay() {
    in_namespace("work-view-read-file", |sandbox| {
        let workspace = sandbox.workspace.to_string_lossy().to_string();
        let session = "sess-read-file";
        let mut view = crate::work_view::WorkView::register(&workspace, session).expect("登记");
        view.ensure_mounted().expect("挂载");

        // 对话内新建
        let in_view = view.mount_point().expect("挂载点").join("only-in-view.txt");
        std::fs::write(&in_view, "view-content\n").expect("写视图");
        assert_eq!(
            crate::work_view::read_view_file(session, "only-in-view.txt").expect("读"),
            "view-content\n"
        );
        assert!(!sandbox.workspace.join("only-in-view.txt").exists());

        // 磁盘基线里的文件也能读
        assert_eq!(
            crate::work_view::read_view_file(session, "existing.txt").expect("读基线"),
            "from-workspace\n"
        );

        // 越界 / 根目录 / 不存在的文件都报错
        assert!(crate::work_view::read_view_file(session, "../etc/passwd").is_err());
        assert!(crate::work_view::read_view_file(session, "/etc/passwd").is_err());
        assert!(crate::work_view::read_view_file(session, "").is_err());
        assert!(crate::work_view::read_view_file(session, "nope.txt").is_err());
        // 未挂载的会话
        assert!(crate::work_view::read_view_file("sess-never", "a.txt").is_err());
    });
}
