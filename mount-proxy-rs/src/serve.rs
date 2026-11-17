//! 常驻形态（specs/051 FR-007b 与 FR-007「代执行协议」）。
//!
//! B 是服务本体：挂载命名空间已由 `privilege::establish` 在 fork 之前建好，A / B 共享
//! 同一份挂载表。本模块在 `fd` 上收发 Core 的帧。
//!
//! **阶段一的范围**：只实现「建立 / 探测 / 卸载挂载」这一类请求（`ping` /
//! `probeOverlay` / `mountOverlay` / `unmountOverlay` / `version`）。工具代执行
//! （`spawn` / `readFile` / `writeFile` / `listDir` / `mkdirAll` / `gitShow`）是阶段二，
//! 本模块收到这些请求时明确回「未实现」而不是静默成功——阶段二的 Core 会据此报错而
//! 不是拿到空结果当成成功。
//!
//! **挂载经 A 转发**：B 降权到真实 uid 之后没有 `CAP_SYS_ADMIN`，`mount(2)` 会被内核
//! 拒绝。`mountOverlay` / `unmountOverlay` 因此不自己 mount，而是把请求写给 A（特权
//! 挂载器），由 A 执行后回结果（见 `privilege::establish` 的进程图）。
//!
//! **视图目录在真实磁盘上**：不再有私有 tmpfs。视图内容（`upper`）必须跨重启保留，
//! 用户的修改才恢复得回来；tmpfs 随命名空间销毁而消失，不满足这一点。
//!
//! 回收靠 **socketpair EOF**：Core 死 → 它持有的 socket 端关闭 → 本进程读到 EOF →
//! 退出 → A 的 `waitpid` 返回 → A 退出。这条链不依赖进程父子关系，因此覆盖 Core 被
//! `SIGKILL` 的情形（FR-007b「回收靠 socketpair EOF，不靠 PDEATHSIG」）。

use crate::protocol::{Frame, Value, IPC_PROTOCOL_VERSION};
use crate::remote_fd::FdStream;
use crate::sys;
use std::path::{Path, PathBuf};

/// 挂载器通道：B 把 mount / umount 请求写给 A（特权挂载器），拿回结果。
///
/// 为什么不是 B 自己挂：B 已降权到真实 uid，`mount(2)` 需要 `CAP_SYS_ADMIN`，内核直接
/// 拒绝（实测 `Operation not permitted`）。特权只留在 A，B 只持有这条通道。
struct MountRequester {
    stream: FdStream,
}

impl MountRequester {
    fn new(fd: i32) -> Self {
        Self {
            stream: FdStream::new(fd),
        }
    }

    /// 请求 A 把 overlay 挂到 `merged`，返回 A 回报的挂载点。
    fn mount(
        &mut self,
        lower: &Path,
        upper: &Path,
        work: &Path,
        merged: &Path,
    ) -> Result<PathBuf, String> {
        let request = Frame::new("mount")
            .with("lower", Value::Str(lower.to_string_lossy().into_owned()))
            .with("upper", Value::Str(upper.to_string_lossy().into_owned()))
            .with("work", Value::Str(work.to_string_lossy().into_owned()))
            .with("merged", Value::Str(merged.to_string_lossy().into_owned()));
        let reply = self.exchange(request)?;
        Ok(PathBuf::from(reply.str_field("merged")?))
    }

    fn umount(&mut self, merged: &Path) -> Result<(), String> {
        let request =
            Frame::new("umount").with("merged", Value::Str(merged.to_string_lossy().into_owned()));
        let _ = self.exchange(request)?;
        Ok(())
    }

    /// 发一帧、收一帧。`ok` 之外的应答一律当错误抛出（不静默降级）。
    fn exchange(&mut self, request: Frame) -> Result<Frame, String> {
        request
            .write_to(&mut self.stream)
            .map_err(|reason| format!("向挂载器写请求失败（{reason}）"))?;
        let reply = Frame::read_from(&mut self.stream)
            .map_err(|reason| format!("读挂载器应答失败（{reason}）"))?
            .ok_or_else(|| "挂载器通道已关闭".to_string())?;
        if reply.op != "ok" {
            return Err(match reply.str_field("message") {
                Ok(message) => message.to_string(),
                Err(_) => "挂载器返回了错误但没有 message".to_string(),
            });
        }
        Ok(reply)
    }
}

/// 已挂载的 overlay 视图登记表。
///
/// 只记自己挂的：`unmountOverlay` 要能判断「这个挂载点是我挂的吗」，不该卸载别人挂的
/// 东西。代理的 mountinfo 是唯一事实来源（`mounted_at`），这张表只在串行互斥里用。
#[derive(Default)]
struct MountTable {
    mounted: Vec<PathBuf>,
}

impl MountTable {
    fn note_mounted(&mut self, merged: &Path) {
        if !self.mounted.iter().any(|existing| existing == merged) {
            self.mounted.push(merged.to_path_buf());
        }
    }

    fn note_unmounted(&mut self, merged: &Path) {
        self.mounted.retain(|existing| existing != merged);
    }
}

/// B 成为常驻代理本体：在 `fd` 上服务 Core 的请求，挂载请求经 `mounter_fd` 交给 A。
///
/// **永不返回**（进入循环或 `_exit`）。`fd` / `mounter_fd` 都只来自内部传递：
/// 本进程按 FR-006「不读任何环境变量」。
pub fn run_as_resident(fd: i32, mounter_fd: i32) -> ! {
    serve_loop(fd, mounter_fd)
}

/// 帧循环：读一帧、处理、回一帧。
///
/// EOF（对端正常关闭）= 退出信号：这是 FR-007b 的回收主路径。
fn serve_loop(fd: i32, mounter_fd: i32) -> ! {
    let mut stream = FdStream::new(fd);
    let mut mounts = MountTable::default();
    let mut requester = MountRequester::new(mounter_fd);
    loop {
        let frame = match Frame::read_from(&mut stream) {
            Ok(Some(frame)) => frame,
            // EOF：Core 已退出（或被 SIGKILL），本进程跟着走
            Ok(None) => unsafe { sys::_exit(0) },
            Err(reason) => {
                eprintln!("[mount-proxy] 读帧失败：{reason}");
                unsafe { sys::_exit(75) };
            }
        };
        let reply = dispatch(&frame, &mut mounts, &mut requester);
        if let Err(reason) = reply.write_to(&mut stream) {
            eprintln!("[mount-proxy] 写应答失败：{reason}");
            unsafe { sys::_exit(76) };
        }
    }
}

/// 处理一条请求。
///
/// 每个请求恰好一条应答；未知 op 回错误而不是忽略——静默忽略会让 Core 侧永远等待
/// （`docs/architecture/principles.md` 铁律 4.1：接线缺失直接报错）。
fn dispatch(frame: &Frame, mounts: &mut MountTable, requester: &mut MountRequester) -> Frame {
    match frame.op.as_str() {
        "version" => Frame::new("version")
            .with("ipcVersion", Value::Num(IPC_PROTOCOL_VERSION as i64))
            .with("ok", Value::Bool(true)),
        "ping" => Frame::new("pong").with("ok", Value::Bool(true)),
        "probeOverlay" => match probe_overlay(requester) {
            Ok(()) => Frame::new("ok").with("ok", Value::Bool(true)),
            Err(reason) => Frame::new("error").with("message", Value::Str(reason)),
        },
        "mountOverlay" => match mount_overlay_request(frame, mounts, requester) {
            // 应答带上挂载点：Core 记它，`unmountOverlay` 原样传回来。
            // 这不是「可选字段」的语义——`ok` 时它必须存在，`error` 时不出现。
            Ok(merged) => Frame::new("ok")
                .with("ok", Value::Bool(true))
                .with("merged", Value::Str(merged.to_string_lossy().into_owned())),
            Err(reason) => Frame::new("error").with("message", Value::Str(reason)),
        },
        "unmountOverlay" => match unmount_overlay_request(frame, mounts, requester) {
            Ok(()) => Frame::new("ok").with("ok", Value::Bool(true)),
            Err(reason) => Frame::new("error").with("message", Value::Str(reason)),
        },
        // 阶段二才有：明确回「未实现」，不静默成功（否则工具会拿到空结果当成成功）
        "spawn" | "readFile" | "writeFile" | "listDir" | "mkdirAll" | "gitShow" => {
            Frame::new("error").with(
                "message",
                Value::Str(format!(
                    "{} 属于阶段二（工具代执行），本次实现未包含",
                    frame.op
                )),
            )
        }
        other => Frame::new("error").with("message", Value::Str(format!("未知请求 op：{other}"))),
    }
}

/// 实测一次 overlay 挂载是否可用（FR-001 的能力判据之一）。
///
/// **必须在代理里做**：Core 没有 `CAP_SYS_ADMIN`，自己挂必然失败；而且 Core 看不到
/// B 的 mountinfo。
///
/// 探测目录落在 B 自己的临时目录下（真实磁盘），挂完立刻卸掉再删：能挂上就说明
/// 「命名空间 + overlay + 视图目录」这条链整体可用，不只看 CapEff。
fn probe_overlay(requester: &mut MountRequester) -> Result<(), String> {
    // 固定路径、不读 `TMPDIR`：常驻形态不读任何环境变量（FR-006「请求收紧」），
    // 而且 `temp_dir()` 会把探测目录放到攻击者可控的位置。
    let root = Path::new("/tmp").join(format!("tc-probe-{}", std::process::id()));
    let lower = root.join("lower");
    let upper = root.join("upper");
    let work = root.join("work");
    let merged = root.join("merged");
    let result = (|| -> Result<(), String> {
        // `merged` 也由 B 建：A 是 euid 0 且 umask(077)，它建的目录 B 读不了
        for dir in [&root, &lower, &upper, &work, &merged] {
            sys::make_dir(dir)?;
        }
        requester.mount(&lower, &upper, &work, &merged)?;
        Ok(())
    })();
    // 挂上过就先卸再删：留下挂载点会让 remove_dir_all 报 EBUSY
    if mounted_at(&merged) {
        let _ = requester.umount(&merged);
    }
    let _ = std::fs::remove_dir_all(&root);
    result
}

/// 挂载一个 overlay 视图，并在**应答前**确认它恰好出现在自己的 mountinfo 里一次。
///
/// 视图目录直接用 Core 给的路径（`<配置目录>/work-views/<key>/{upper,work,mount}`）：
/// 它们本来就在真实磁盘上，跨重启保留，用户的修改因此可恢复。
///
/// 「同一 `upper` 不得叠挂两层」由这里串行（单线程循环 + `mounted_at` 预检）保证。
fn mount_overlay_request(
    frame: &Frame,
    mounts: &mut MountTable,
    requester: &mut MountRequester,
) -> Result<PathBuf, String> {
    let lower = PathBuf::from(frame.str_field("lower")?);
    let upper = PathBuf::from(frame.str_field("upper")?);
    let work = PathBuf::from(frame.str_field("work")?);
    let merged = PathBuf::from(frame.str_field("merged")?);

    // 已挂过就不叠第二层（并发首次调用的去重；Core 的登记表锁退化为会话级）
    if mounted_at(&merged) {
        let count = mount_count(&merged);
        if count != 1 {
            return Err(format!(
                "挂载点 {} 已出现 {count} 次（应为 1 次），拒绝叠挂",
                merged.display()
            ));
        }
        mounts.note_mounted(&merged);
        return Ok(merged);
    }

    // 视图目录**全部由 B（用户身份）建**，属主就是用户自己——A 挂载时不做 chown，
    // 用户在自己的视图里读写无需任何额外授权。
    //
    // `merged` 也必须在这里建，不能留给 A 去 `create_dir`：A 的 euid 是 0，且入口已
    // `umask(077)`，由它建出来的挂载点是 `root:root 0700`，降权后的 B 连 `listdir` 都
    // 拿不到（实测 `PermissionError(13)`，挂载成功但视图不可读）。
    for dir in [&upper, &work, &merged] {
        sys::make_dir(dir)?;
    }

    let mounted = requester.mount(&lower, &upper, &work, &merged)?;
    // 应答前自查：mount() 返回 0 不等于挂载生效，也看不出叠了几层
    let count = mount_count(&mounted);
    if count != 1 {
        let _ = requester.umount(&mounted);
        return Err(format!(
            "挂载后 {} 在 mountinfo 里出现 {count} 次（应为 1 次）",
            mounted.display()
        ));
    }
    // 应答前**由代理自己读一次叠加视图**：这是唯一能证明「挂载对代理可见」的判据。
    // Core 在宿主命名空间里看不见这个挂载（specs/051「不采用 setns」），所以宿主侧的
    // 目录内容不能作为挂载成功的证据；只有代理自己读得到才算数。
    // 读到的内容不返回给 Core（阶段一不回传文件内容），只用来判定这次挂载是否可用。
    if let Err(reason) = read_through_view(&mounted) {
        let _ = requester.umount(&mounted);
        return Err(reason);
    }

    mounts.note_mounted(&mounted);
    Ok(mounted)
}

/// 通过挂载点读一次，确认叠加视图对代理**真的可见**。
///
/// `mount(2)` 返回 0 只说明内核接受了请求；挂载点是否真的被覆盖、上层是否有内容，
/// 必须读一次才知道。这里读 `lower` 里应当可见的条目数（不依赖具体文件名），
/// 读不到就说明叠加没生效，直接判失败并卸载——**不静默继续**，否则后面所有代执行
/// 都会在一个空视图上工作（`docs/architecture/principles.md` 铁律 4.1）。
fn read_through_view(merged: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(merged)
        .map_err(|error| format!("读叠加视图 {} 失败（{error}）", merged.display()))?;
    let count = entries.filter_map(|entry| entry.ok()).count();
    if count == 0 {
        return Err(format!(
            "叠加视图 {} 为空：挂载未生效或 lower 为空",
            merged.display()
        ));
    }
    Ok(())
}

/// 卸载一个视图。
///
/// 单次 `umount` 只撤一层；层数与登记表不一致时单次卸载会留下一层谁也回收不到的挂载，
/// 随后 `remove_dir_all` 一个仍是挂载点的目录直接 `EBUSY`
/// （`specs/defects/work-view-concurrent-first-use-double-mounts.md`）。
///
/// 入参是 Core 记下的路径（`mountOverlay` 应答里的 `merged`），因此与挂载侧落在同一处。
fn unmount_overlay_request(
    frame: &Frame,
    mounts: &mut MountTable,
    requester: &mut MountRequester,
) -> Result<(), String> {
    let merged = PathBuf::from(frame.str_field("merged")?);
    for _ in 0..8 {
        if !mounted_at(&merged) {
            mounts.note_unmounted(&merged);
            return Ok(());
        }
        if let Err(reason) = requester.umount(&merged) {
            return Err(format!("卸载 {} 失败（{reason}）", merged.display()));
        }
    }
    if mounted_at(&merged) {
        return Err(format!("卸载 {} 后仍在 mountinfo 里", merged.display()));
    }
    mounts.note_unmounted(&merged);
    Ok(())
}

/// 自检用：经 A 挂一次 overlay（B 自己挂不了）。
pub fn mount_for_self_check(
    mounter_fd: i32,
    lower: &Path,
    upper: &Path,
    work: &Path,
    merged: &Path,
) -> Result<(), String> {
    let mut requester = MountRequester::new(mounter_fd);
    requester.mount(lower, upper, work, merged).map(|_| ())
}

/// 自检用：经 A 卸一次 overlay。失败不报错——自检的结论已经由前面的断言给出。
pub fn unmount_for_self_check(mounter_fd: i32, merged: &Path) {
    let mut requester = MountRequester::new(mounter_fd);
    let _ = requester.umount(merged);
}

/// 挂载点当前在 `/proc/self/mountinfo` 里出现几次
fn mount_count(mount: &Path) -> usize {
    let text = mount.to_string_lossy();
    std::fs::read_to_string("/proc/self/mountinfo")
        .unwrap_or_default()
        .lines()
        .filter(|line| line.split_whitespace().nth(4) == Some(text.as_ref()))
        .count()
}

fn mounted_at(mount: &Path) -> bool {
    mount_count(mount) > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用挂载器：真 socketpair 的对端，**不执行任何挂载**，只按 `reply_op` 回一帧。
    ///
    /// 用真 fd 而不是 mock trait：`MountRequester` 的协议（写一帧、读一帧）本身也要被测，
    /// 换成 trait 就把这一段排除在测试之外了。
    fn fake_mounter(reply_op: &'static str) -> MountRequester {
        let mut pair = [0i32; 2];
        sys::check(
            unsafe { sys::socketpair(sys::AF_UNIX, sys::SOCK_STREAM, 0, pair.as_mut_ptr()) },
            "测试用 socketpair",
        )
        .unwrap();
        std::thread::spawn(move || {
            let mut stream = FdStream::new(pair[1]);
            while let Ok(Some(request)) = Frame::read_from(&mut stream) {
                let reply = if reply_op == "ok" {
                    Frame::new("ok").with("ok", Value::Bool(true)).with(
                        "merged",
                        Value::Str(format!(
                            "/views/{}",
                            request.str_field("merged").unwrap_or("/views/x")
                        )),
                    )
                } else {
                    Frame::new("error").with("message", Value::Str("模拟挂载失败".into()))
                };
                if reply.write_to(&mut stream).is_err() {
                    break;
                }
            }
        });
        MountRequester::new(pair[0])
    }

    #[test]
    fn unknown_op_returns_error_not_silence() {
        let mut mounts = MountTable::default();
        let mut requester = fake_mounter("ok");
        let reply = dispatch(&Frame::new("nonsense"), &mut mounts, &mut requester);
        assert_eq!(reply.op, "error");
        assert!(reply.str_field("message").unwrap().contains("未知请求 op"));
    }

    #[test]
    fn stage_two_ops_say_not_implemented() {
        let mut mounts = MountTable::default();
        let mut requester = fake_mounter("ok");
        for op in [
            "spawn",
            "readFile",
            "writeFile",
            "listDir",
            "mkdirAll",
            "gitShow",
        ] {
            let reply = dispatch(&Frame::new(op), &mut mounts, &mut requester);
            assert_eq!(reply.op, "error", "{op} 应回错误");
            let message = reply.str_field("message").unwrap();
            assert!(
                message.contains("阶段二"),
                "{op} 的说明应点名阶段二：{message}"
            );
        }
    }

    #[test]
    fn version_reports_ipc_protocol() {
        let mut mounts = MountTable::default();
        let mut requester = fake_mounter("ok");
        let reply = dispatch(&Frame::new("version"), &mut mounts, &mut requester);
        assert_eq!(
            reply.num_field("ipcVersion").unwrap(),
            IPC_PROTOCOL_VERSION as i64
        );
    }

    #[test]
    fn ping_pongs() {
        let mut mounts = MountTable::default();
        let mut requester = fake_mounter("ok");
        let reply = dispatch(&Frame::new("ping"), &mut mounts, &mut requester);
        assert_eq!(reply.op, "pong");
    }

    #[test]
    fn mount_table_dedupes() {
        let mut mounts = MountTable::default();
        mounts.note_mounted(Path::new("/tmp/a"));
        mounts.note_mounted(Path::new("/tmp/a"));
        assert_eq!(mounts.mounted.len(), 1);
        mounts.note_unmounted(Path::new("/tmp/a"));
        assert!(mounts.mounted.is_empty());
    }
}
