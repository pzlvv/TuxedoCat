//! 对话级 overlay 工作视图的 Linux 实现（specs/045 + specs/051）。
//!
//! ## 视图由常驻代理持有
//!
//! Core 自身**不**进命名空间、不 `unshare`、不 `mount`（ADR-0018）。一个隔离会话对应
//! 一个常驻挂载代理：它在降权之前建好挂载命名空间、挂上 overlay、把视图 bind 到真实
//! 工作区路径上，之后持有这份命名空间并 `fork` 出工具进程（
//! `docs/core/mount-proxy.md`）。
//!
//! 因此本模块只剩三件事：
//!
//! 1. **登记**会话 → 视图目录（`upper` / `work` / `mount` 落在真实磁盘，跨重启保留）；
//! 2. **拉起**该会话的代理（`mount_proxy::session_proxy`）并在登记表里持有句柄；
//! 3. 把工具与视图取数的 IO **转发**给代理（`ToolContext` 与三个 `workView*` 请求）。
//!
//! 路径不做任何映射：代理已经把视图 bind 到真实工作区路径上，工具看到真实路径就是
//! 叠加结果（specs/045「视图对工具透明」）。这比旧的 `mount/` 路径映射更强——脚本里
//! 写死的绝对路径、`$PWD`、`cd` 全部照常工作。
//!
//! ## 失败是 fail-closed
//!
//! 代理拉不起来时，隔离会话的工具调用**报错**而不是退回真实磁盘（FR-010）。「该会话
//! 不是隔离归属」与「隔离归属但视图不可用」是两件事，前者正常走磁盘，后者必须暴露。

use super::Capabilities;
use crate::mount_proxy;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// 已登记的工作视图：`sessionId` → 视图。
fn views() -> &'static Mutex<HashMap<String, WorkView>> {
    static VIEWS: OnceLock<Mutex<HashMap<String, WorkView>>> = OnceLock::new();
    VIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 能力探测（specs/051 FR-001）。
///
/// 能力的唯一 owner 是 Core，判据来自**常驻代理**：Core 自身不 `unshare`、不进任何
/// 命名空间，因此「代理能挂起一个视图」是唯一可能的 true 来源。失败只回 `absent` 并
/// 带上原因，不 panic、不影响帧通道（AC-28）。
pub fn capabilities() -> Capabilities {
    crate::mount_proxy::capabilities_from(&crate::mount_proxy::probe_capabilities())
}

/// 一个对话的工作视图。
pub struct WorkView {
    /// 会话 id（登记表的键）。
    session_id: String,
    /// 真实工作区路径（lowerdir，也是工具看到的路径）。
    workspace: PathBuf,
    /// 视图根目录（`upper` / `work` / `mount` 的父目录）。
    root: PathBuf,
    /// 挂载点（merged）。Core 读它是空的——真正的挂载在代理的命名空间里；
    /// 它只作为代理的挂载目标与诊断信息存在。
    mount: PathBuf,
    /// 该会话的常驻代理；`None` = 还没拉起。
    ///
    /// 惰性：登记发生在会话创建时，而「用户真的让工具读文件」可能永远不发生。用户从不
    /// 使用 Overlay 对话时不产生任何代理进程（FR-007「代理按需拉起」）。
    proxy: Option<Arc<mount_proxy::SessionProxy>>,
}

impl WorkView {
    /// 视图根目录：`<configHome>/work-views/<key>/`。
    pub fn root_of(workspace: &str, session_id: &str) -> Result<PathBuf, String> {
        Ok(crate::config::config_home()?
            .join("work-views")
            .join(session_key(workspace, session_id)))
    }

    /// 登记一个对话的视图（不拉起代理，首次使用时才拉）。
    ///
    /// 重复登记报错：调用方要么取回已有视图（`reopen`），要么说明接线错了。
    pub fn register(workspace: &str, session_id: &str) -> Result<Self, String> {
        let mut views = views()
            .lock()
            .map_err(|error| format!("视图登记表损坏：{error}"))?;
        if views.contains_key(session_id) {
            return Err(format!("会话 {session_id} 已有工作视图"));
        }
        let root = Self::root_of(workspace, session_id)?;
        let view = WorkView {
            session_id: session_id.to_string(),
            workspace: PathBuf::from(workspace),
            mount: root.join("mount"),
            root,
            proxy: None,
        };
        views.insert(session_id.to_string(), view.snapshot());
        Ok(view)
    }

    /// 取回已登记的视图（会话重开时用；未登记则报错）。
    pub fn reopen(workspace: &str, session_id: &str) -> Result<Self, String> {
        let views = views()
            .lock()
            .map_err(|error| format!("视图登记表损坏：{error}"))?;
        let view = views
            .get(session_id)
            .ok_or_else(|| format!("会话 {session_id} 尚未登记工作视图"))?;
        let _ = workspace;
        Ok(view.snapshot())
    }

    /// 供登记表存一份快照（`WorkView` 不实现 Clone：它持有代理句柄，复制句柄会误导）
    fn snapshot(&self) -> Self {
        Self {
            session_id: self.session_id.clone(),
            workspace: self.workspace.clone(),
            root: self.root.clone(),
            mount: self.mount.clone(),
            proxy: self.proxy.as_ref().map(Arc::clone),
        }
    }

    /// 确保该会话的代理已拉起（幂等）。
    ///
    /// 这是「需要视图」的唯一入口：工具批与三个 `workView*` 请求都先调它。并发首次调用
    /// 由登记表的锁串行——`mount_proxy::session_proxy` 自己按会话去重（
    /// `specs/defects/work-view-concurrent-first-use-double-mounts.md` 的形态不会出现）。
    pub fn ensure_mounted(&mut self) -> Result<(), String> {
        // 视图根目录的父链由 Core 建：代理的 `make_dir` 只做单层 `mkdir(2)`（它要精确
        // 报 errno，不做递归），`<configHome>/work-views/<key>/` 这串在首次使用时不
        // 存在。旧形态由 Core 在挂载前自己 `create_dir_all`，改成代执行后这一步没人做，
        // 代理会以「父目录不存在」失败——随后工具侧 fail-closed 报错（或更早的版本直接
        // 退回真实磁盘，那正是「overlay 里创建的文件磁盘上也能看到」）。
        for dir in [
            &self.root,
            &self.root.join("upper"),
            &self.root.join("work"),
            &self.mount,
        ] {
            std::fs::create_dir_all(dir)
                .map_err(|error| format!("建视图目录 {} 失败：{error}", dir.display()))?;
        }
        let paths = mount_proxy::View {
            lower: self.workspace.clone(),
            upper: self.root.join("upper"),
            work: self.root.join("work"),
            merged: self.mount.clone(),
            // bind 的目标就是真实工作区路径：工具不需要任何路径映射
            workspace: self.workspace.clone(),
        };
        let proxy = mount_proxy::session_proxy(&self.session_id, paths)?;
        self.proxy = Some(proxy);
        // 登记表里也更新一份，`WorkViewHandle::of` 才能拿到代理
        if let Ok(mut views) = views().lock() {
            if let Some(entry) = views.get_mut(&self.session_id) {
                entry.proxy = self.proxy.as_ref().map(Arc::clone);
            }
        }
        Ok(())
    }

    /// 视图挂载点（诊断与文档用）
    pub fn mount_point(&self) -> Option<PathBuf> {
        self.proxy.as_ref().map(|_| self.mount.clone())
    }

    /// 真实工作区路径
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    /// 视图根目录（`upper` / `work` 的父目录）
    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// 工具与视图取数持有的句柄（`ToolContext.work_view`）。
///
/// 只暴露「代理是谁」与「工作区是哪」：文件读写一律经代理代执行（`ToolContext` 的
/// `read_file` / `write_file` / …），Core 自己**不** `open()` 视图里的路径——它看不到
/// 那些挂载。
#[derive(Clone)]
pub struct WorkViewHandle {
    /// **视图所有者**的会话 id（诊断用）：`isolated` 的本地子代理拿到的是发起对话的 id
    /// （specs/058 FR-002——父子共用同一份视图，使用者不单独登记）。
    session_id: String,
    /// 真实工作区路径
    workspace: PathBuf,
    /// 视图根目录（`<configHome>/work-views/<key>`；scratch 放在它的兄弟位置）
    root: PathBuf,
    /// 该会话的常驻代理
    proxy: Arc<mount_proxy::SessionProxy>,
}

impl WorkViewHandle {
    /// 取某会话的句柄；没有已拉起的代理时 `None`。
    ///
    /// 调用前应经 `Engine::ensure_work_view` 拉起代理：`None` 在这里的含义是「该会话
    /// 没有视图」，而不是「视图坏了」。
    pub fn of(session_id: &str) -> Option<Self> {
        let views = views().lock().ok()?;
        let view = views.get(session_id)?;
        let proxy = view.proxy.as_ref()?;
        Some(Self {
            session_id: session_id.to_string(),
            workspace: view.workspace.clone(),
            root: view.root.clone(),
            proxy: Arc::clone(proxy),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 该会话的常驻代理（工具代执行的唯一通道）
    pub fn proxy(&self) -> &Arc<mount_proxy::SessionProxy> {
        &self.proxy
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    /// 视图根目录（`upper` / `work` 的父目录）。
    ///
    /// 父子共用一份视图的判据取自它：`isolated` 的本地子代理解析到所有者后拿到的是
    /// **同一个**根目录（specs/058 FR-002）。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 把真实路径映射成「工具该用的路径」。
    ///
    /// 代理已把视图 bind 到真实工作区路径上，因此映射是恒等——但它仍然校验路径在
    /// 工作区内：越界说明接线错了（`cwd` 与视图的工作区不一致），静默放行会让工具
    /// 读到视图之外的东西。
    pub fn map_into_view(&self, real: &Path) -> Result<PathBuf, String> {
        if !real.starts_with(&self.workspace) {
            return Err(format!(
                "路径 {} 不在工作区 {} 内",
                real.display(),
                self.workspace.display()
            ));
        }
        Ok(real.to_path_buf())
    }

    /// 视图外的临时目录（git 取数的索引副本放这里，保证取数不写视图）。
    ///
    /// 落在视图根目录的**兄弟**位置（`<configHome>/work-views/.scratch/<session>`）：
    /// 既不在 overlay 的 upper 里（否则会被当成对话改动），也不在工作区里（旧实现写成
    /// `<工作区>/../.tc-view-scratch`，会往用户的目录外层丢文件）。
    pub fn scratch_dir(&self) -> Result<PathBuf, String> {
        let dir = match self.root.parent() {
            Some(views) => views.join(".scratch").join(&self.session_id),
            None => self.root.join(".scratch"),
        };
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("建取数临时目录 {} 失败：{error}", dir.display()))?;
        Ok(dir)
    }
}

/// 列某个 Overlay 对话的叠加视图目录（specs/046 FR-002）。
///
/// 经代理代执行：视图挂载在代理的命名空间里，Core 自己 `read_dir` 只能看到空目录
/// （`docs/core/conversation-work-view.md` 第 4 节）。
///
/// 调用前必须经 `Core::ensure_work_view` 把视图备好：本函数只做取数，`None` 在这里
/// 的含义是「这份视图没有登记」，不替调用方决定怎么补救。
///
/// `owner` 是**视图所有者**的会话 id（specs/058 FR-002）：`isolated` 的本地子代理与发起
/// 对话共用同一份视图，调用方（`main.rs` 的请求分支）已按 `Core::work_view_owner` 解析过。
///
/// **不降级**（`docs/architecture/principles.md` 铁律 4.1）：视图取不到时回 `Err` 而不是
/// 偷偷列磁盘——那是两个不同的事实，由宿主决定怎么呈现。
pub fn list_view_dir(owner: &str, dir: &str) -> Result<Vec<serde_json::Value>, String> {
    let handle = WorkViewHandle::of(owner)
        .ok_or_else(|| format!("会话 {owner} 没有已挂载的 Overlay 视图"))?;
    let relative = sanitize_view_relative(dir)?;
    let target = handle.workspace().join(&relative);
    let entries = handle.proxy.list_dir(&target)?;
    let mut out = Vec::new();
    for (name, is_dir) in entries {
        out.push(serde_json::json!({
            "name": name,
            "kind": if is_dir { "directory" } else { "file" },
            // 代理不回 stat 的 mtime（列表不做它需要的额外系统调用），界面按缺省处理
            "mtimeMs": serde_json::Value::Null,
        }));
    }
    Ok(out)
}

/// 把 `'/'` 分隔的相对路径解析成可安全拼到工作区上的相对路径。
///
/// 判据只有一份：`super::check_view_relative`（请求分支在建立视图之前也调它）。
/// 这里只把校验过的字符串转成 `PathBuf` 并丢掉空段与 `.`。
fn sanitize_view_relative(dir: &str) -> Result<PathBuf, String> {
    super::check_view_relative(dir)?;
    let mut relative = PathBuf::new();
    for segment in dir.split('/') {
        // 空串来自 '//'；'.' 是无操作
        if segment.is_empty() || segment == "." {
            continue;
        }
        relative.push(segment);
    }
    Ok(relative)
}

/// 释放某会话的视图（会话关闭时调用）：丢弃代理，**保留**上层目录——改动要跨 Core
/// 重启保留（specs/045 FR-006）。
///
/// `owner` 是视图所有者（specs/058 FR-003）：使用者（本地子代理）关闭时**不**走这里，
/// 否则会把所有者还在用的常驻代理一起丢掉（`main.rs` 的 `release_owned_work_view`）。
pub fn release(_workspace: &str, owner: &str) {
    let removed = views()
        .lock()
        .map(|mut views| views.remove(owner))
        .ok()
        .flatten();
    // 丢弃句柄 = 关闭 socketpair = 代理读到 EOF 自行退出
    drop(removed);
    crate::mount_proxy::release_session(owner);
}

/// 回收某会话的视图（会话删除时调用）：丢弃代理并删掉整个视图目录。
///
/// 失败只记日志不阻塞删除——残留目录可以事后清理，但删除对话本身不能因此失败。
///
/// `owner` 是视图所有者（specs/058 FR-003）：只有所有者被删除时上层目录才整体回收；
/// 删除子代理会话时上层里可能有它写过的内容，必须留在原处。
pub fn remove(workspace: &str, owner: &str) -> Result<(), String> {
    let removed = views()
        .lock()
        .map_err(|error| format!("视图登记表损坏：{error}"))?
        .remove(owner);
    drop(removed);
    crate::mount_proxy::release_session(owner);
    let root = WorkView::root_of(workspace, owner)?;
    if root.exists() {
        std::fs::remove_dir_all(&root)
            .map_err(|error| format!("回收视图目录 {} 失败：{error}", root.display()))?;
    }
    Ok(())
}

/// 视图里的 git 取数（specs/047 FR-001 / FR-004）。
///
/// 命令由代理代执行：git 必须在视图里跑（`changes` 用 `--work-tree` 指向真实工作区，
/// 而真实工作区在 Core 侧就是磁盘）。临时索引放在视图外的 scratch 目录，避免取数污染
/// `upper`（理由见 `work_view_changes.rs`）。
///
/// 与 `list_view_dir` 同一前提：调用前经 `Core::ensure_work_view` 备好视图。
pub fn changes(owner: &str, scope: &str) -> Result<super::ChangesOutcome, String> {
    let handle = WorkViewHandle::of(owner)
        .ok_or_else(|| format!("会话 {owner} 没有已挂载的 Overlay 视图"))?;
    let scope = super::ChangeScope::parse(scope)?;
    let scratch = handle.scratch_dir()?;
    let view = super::GitView {
        workspace: handle.workspace(),
        proxy: &handle.proxy,
        scratch: scratch.as_path(),
    };
    view.changes(scope)
}

/// 取视图里某个文件的两侧原文（specs/047 FR-004）。`path` 不能是视图根。
pub fn file_diff(owner: &str, path: &str) -> Result<super::FileDiffOutcome, String> {
    let handle = WorkViewHandle::of(owner)
        .ok_or_else(|| format!("会话 {owner} 没有已挂载的 Overlay 视图"))?;
    let relative = sanitize_view_relative(path)?;
    if relative.as_os_str().is_empty() {
        return Err("取文件两侧原文时 path 不能是视图根".to_string());
    }
    let rel = relative.to_string_lossy().to_string();
    let scratch = handle.scratch_dir()?;
    let view = super::GitView {
        workspace: handle.workspace(),
        proxy: &handle.proxy,
        scratch: scratch.as_path(),
    };
    view.file_diff(&rel)
}

/// 视图目录名：工作区 + 会话 id 的稳定短哈希，跨 Core 重启一致。
///
/// 只用 sessionId 不够：同一会话 id 在不同工作区下必须落到不同目录（工作区各自有基线）。
fn session_key(workspace: &str, session_id: &str) -> String {
    let mut safe = String::with_capacity(session_id.len());
    for ch in session_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
            safe.push(ch);
        } else {
            safe.push('-');
        }
    }
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(workspace.as_bytes());
        hasher.update([0u8]);
        hasher.update(session_id.as_bytes());
        hasher.finalize()
    };
    let hash: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{hash}-{}", &safe[..safe.len().min(48)])
}

/// 历史遗留符号：旧形态由 Core 在子进程里 `unshare` + bind，新形态由代理在特权阶段
/// 完成（见 `mount-proxy-rs/src/privilege.rs`），因此这里没有对应实现。
///
/// 保留常量式的文档说明而不是空实现，避免调用点悄悄编译通过后又静默不生效。
pub fn bind_view_onto_workspace(_mount_point: &Path, _workspace: &Path) -> Result<(), String> {
    Err("Core 不再自己 bind 视图：视图的 bind 由常驻挂载代理在特权阶段完成".to_string())
}

/// 历史遗留符号：旧形态由 Core 在启动早期 `unshare`，新形态不存在这一步。
pub fn enter() {}

// ==================== 视图文件 IO（specs/056 FR-002 / FR-003）====================
//
// 跨工作区传输的一端可能是本对话的叠加视图。视图挂载在 Core 的私有命名空间里，宿主进程
// 读挂载点得到空目录（`docs/core/conversation-work-view.md` 第 4 节），因此**字节必须经
// Core 转交代理**：`UiRequest.workViewFileIoRequested` 的每个 op 落到下面这一组入口，
// 路径 = 该会话工作区 + 相对路径。
//
// 所有入口的前提与 `list_view_dir` 相同：调用前经 `Core::ensure_work_view` 备好视图。
// 视图取不到时回 `Err`，由请求分支翻成 `{ ok: false, error }`——不退回真实磁盘。

/// 取某会话视图里的路径（相对路径已由 `check_view_relative` 校验过）。
fn view_target(
    owner: &str,
    relative: &str,
) -> Result<(PathBuf, Arc<mount_proxy::SessionProxy>), String> {
    let handle = WorkViewHandle::of(owner)
        .ok_or_else(|| format!("会话 {owner} 没有已挂载的 Overlay 视图"))?;
    let relative = sanitize_view_relative(relative)?;
    let target = handle.workspace().join(&relative);
    Ok((target, Arc::clone(handle.proxy())))
}

/// 视图里一个路径的事实（`UiRequest.workViewFileIoRequested` 的 `stat`）。
pub fn view_stat(owner: &str, relative: &str) -> Result<super::ViewPathFacts, String> {
    let (target, proxy) = view_target(owner, relative)?;
    let facts = proxy.stat(&target)?;
    Ok(super::ViewPathFacts {
        exists: facts.exists,
        is_file: facts.is_file,
        is_dir: facts.is_dir,
        is_symlink: facts.is_symlink,
        size: facts.size,
    })
}

/// 列视图目录（`list`）：只回名称与类型，与传输端点需要的最小面一致。
pub fn view_list(owner: &str, relative: &str) -> Result<Vec<(String, bool)>, String> {
    let (target, proxy) = view_target(owner, relative)?;
    proxy.list_dir(&target)
}

/// 递归建目录（`mkdirAll`）。
pub fn view_mkdir_all(owner: &str, relative: &str) -> Result<(), String> {
    let (target, proxy) = view_target(owner, relative)?;
    proxy.mkdir_all(&target)
}

/// 改名（`rename`）：目标已存在时按覆盖语义处理。
///
/// 两端必须在**同一个视图**里，因此只取一次句柄、两条路径都拼在它的工作区上。
pub fn view_rename(owner: &str, from: &str, to: &str) -> Result<(), String> {
    let handle = WorkViewHandle::of(owner)
        .ok_or_else(|| format!("会话 {owner} 没有已挂载的 Overlay 视图"))?;
    let from_path = handle.workspace().join(sanitize_view_relative(from)?);
    let to_path = handle.workspace().join(sanitize_view_relative(to)?);
    handle.proxy().rename_path(&from_path, &to_path)
}

/// 删一个文件（`unlink`）：清理传输的暂存件，目标不存在算成功。
pub fn view_unlink(owner: &str, relative: &str) -> Result<(), String> {
    let (target, proxy) = view_target(owner, relative)?;
    proxy.unlink_path(&target)
}

/// 定向读（`read`）：返回 `(bytes, eof)`。
pub fn view_read_chunk(
    owner: &str,
    relative: &str,
    offset: u64,
    length: u64,
) -> Result<(Vec<u8>, bool), String> {
    let (target, proxy) = view_target(owner, relative)?;
    proxy.read_range(&target, offset, length)
}

/// 定向写（`write`）：返回写入后的文件长度。
pub fn view_write_chunk(
    owner: &str,
    relative: &str,
    offset: u64,
    bytes: &[u8],
) -> Result<u64, String> {
    let (target, proxy) = view_target(owner, relative)?;
    proxy.write_range(&target, offset, bytes)
}
