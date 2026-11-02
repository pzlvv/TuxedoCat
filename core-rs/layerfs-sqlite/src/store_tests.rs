//! Store 级集成测试：seal 交付（AC-14 / AC-1）、真库往返（AC-5/6/7/9/10）、
//! 崩溃一致（AC-8）与多进程并发 / 排队（AC-11 / AC-12）。
//!
//! 多进程用例统一用测试自派生：`current_exe()` 以 `--exact <helper> --nocapture` 启动
//! 子进程，环境变量 `LAYERFS_TEST_ROLE` 选角色，stdout 行握手；全部跑在
//! `cargo test --workspace` 内，不新增二进制。

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use layerfs::{ObjectId, ObjectPersistence, PersistenceError, Storage, StorageError};

use crate::test_support::{chunk_object, read_objects, store_chunks, TempStore};
use crate::{Handles, PersistenceConfig, SqlitePersistenceProfile, StorePath};

const ROLE: &str = "LAYERFS_TEST_ROLE";
const STORE: &str = "LAYERFS_TEST_STORE";
const TAG: &str = "LAYERFS_TEST_TAG";

#[test]
fn seal_leaves_one_self_contained_file_and_reopens() {
    let temp = TempStore::new("seal");
    let handles = temp.create();
    let ids = store_chunks(&handles, &[b"sealed one", b"sealed two"]);
    let sealed = handles.seal().expect("seal");
    assert_eq!(sealed.path, temp.file());
    assert_eq!(sealed.profile, SqlitePersistenceProfile::Disposable);
    assert!(!sealed.sqlite_version.is_empty());
    assert!(sealed.bytes > 0);
    assert_eq!(
        sealed.bytes,
        std::fs::metadata(temp.file()).expect("metadata").len()
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !temp.path().sidecar(suffix).exists(),
            "sidecar {suffix} remains"
        );
    }
    // 目录里只剩主文件。
    let entries: Vec<_> = std::fs::read_dir(temp.dir())
        .expect("read dir")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(entries, vec![std::ffi::OsString::from("store.layerfs")]);
    let reopened = temp.open_writable();
    assert_eq!(read_objects(&reopened, &ids).expect("read").len(), 2);
}

#[test]
fn seal_with_live_references_is_busy() {
    let temp = TempStore::new("seal-busy");
    let handles = temp.create();
    let retained = Arc::clone(&handles.storage);
    let error = handles.seal().unwrap_err();
    assert!(matches!(error, PersistenceError::Busy));
    drop(retained);
}

#[test]
fn same_content_twice_is_reused_and_stored_once() {
    let temp = TempStore::new("dedup");
    let handles = temp.create();
    let storage =
        Storage::new(Arc::clone(&handles.storage) as Arc<dyn ObjectPersistence>).expect("storage");
    let object = chunk_object(b"dedup through sqlite");
    let id = object.id();
    let first = storage.begin_save().expect("save");
    first.accept(object.clone()).expect("accept");
    let first_outcome = first.finish().expect("finish");
    let second = storage.begin_save().expect("save");
    second.accept(object).expect("accept");
    let second_outcome = second.finish().expect("finish");
    assert_eq!(first_outcome.inserted, 1);
    assert_eq!(second_outcome.reused, 1);
    assert_eq!(second_outcome.packs, 0);
    let connection = rusqlite::Connection::open(temp.file()).expect("open");
    let packs: i64 = connection
        .query_row("SELECT count(*) FROM pack", [], |row| row.get(0))
        .expect("count");
    assert_eq!(packs, 1);
    assert_eq!(read_objects(&handles, &[id]).expect("read").len(), 1);
}

#[test]
fn finish_acknowledges_and_reads_in_order_with_missing_classified() {
    let temp = TempStore::new("roundtrip");
    let handles = temp.create();
    let ids = store_chunks(&handles, &[b"first", b"second", b"third"]);
    let read = read_objects(&handles, &[ids[2], ids[0], ids[1]]).expect("read");
    assert_eq!(ObjectId::for_bytes(&read[0]), ids[2]);
    assert_eq!(ObjectId::for_bytes(&read[1]), ids[0]);
    assert_eq!(ObjectId::for_bytes(&read[2]), ids[1]);
    let ghost = ObjectId::for_bytes(b"ghost");
    let error = read_objects(&handles, &[ids[0], ghost]).unwrap_err();
    let StorageError::ObjectMissing(missing) = error else {
        panic!("expected ObjectMissing, got {error:?}");
    };
    assert_eq!(missing, ghost);
}

#[test]
fn missing_dependency_leaves_no_effect_in_store() {
    let temp = TempStore::new("closure");
    let handles = temp.create();
    let storage =
        Storage::new(Arc::clone(&handles.storage) as Arc<dyn ObjectPersistence>).expect("storage");
    let child = chunk_object(b"closure child");
    let child_id = child.id();
    let dangling = chunk_object(b"dangling").with_references(vec![ObjectId::for_bytes(b"absent")]);
    let save = storage.begin_save().expect("save");
    save.accept(child).expect("accept");
    save.accept(dangling).expect("accept");
    assert!(matches!(
        save.finish().unwrap_err(),
        StorageError::MissingDependency { .. }
    ));
    let connection = rusqlite::Connection::open(temp.file()).expect("open");
    let rows: i64 = connection
        .query_row("SELECT count(*) FROM object_location", [], |row| row.get(0))
        .expect("count");
    assert_eq!(rows, 0);
    assert!(matches!(
        read_objects(&handles, &[child_id]).unwrap_err(),
        StorageError::ObjectMissing(_)
    ));
}

// ---- 多进程辅助 ----------------------------------------------------------------

fn spawn_child(role: &str, store: &PathBuf, tag: &str) -> Child {
    Command::new(std::env::current_exe().expect("current exe"))
        .args(["--exact", "seal::tests::child_role", "--nocapture"])
        .env(ROLE, role)
        .env(STORE, store)
        .env(TAG, tag)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn child")
}

/// 读到以 `prefix` 开头的握手行，返回其余部分；子进程提前退出即失败。
fn await_line(reader: &mut BufReader<std::process::ChildStdout>, prefix: &str) -> String {
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read child stdout");
        assert!(read != 0, "child exited before '{prefix}'");
        if let Some(rest) = line.trim_end().strip_prefix(prefix) {
            return rest.trim().to_owned();
        }
    }
}

fn child_config() -> PersistenceConfig {
    let path = PathBuf::from(std::env::var(STORE).expect("store env"));
    PersistenceConfig::sqlite(
        StorePath::from_os(&path).expect("store path"),
        SqlitePersistenceProfile::Disposable,
    )
}

/// 子进程角色入口：没有角色环境变量时是空测试。
#[test]
fn child_role() {
    let Ok(role) = std::env::var(ROLE) else {
        return;
    };
    let mut stdout = std::io::stdout();
    match role.as_str() {
        // 发布一个引用闭包波次（512 个）后把第 513 个留在批内，然后挂起等父进程杀。
        "publish_and_hang" => {
            let handles = Handles::open_writable(child_config()).expect("open");
            let storage = Storage::new(Arc::clone(&handles.storage) as Arc<dyn ObjectPersistence>)
                .expect("storage");
            let save = storage.begin_save().expect("save");
            let mut first = None;
            let mut last = None;
            for i in 0..=layerfs::policy::BATCH_OBJECT_LIMIT {
                let object = chunk_object(&[b'p', (i & 0xff) as u8, (i >> 8) as u8]);
                if i == 0 {
                    first = Some(object.id());
                }
                last = Some(object.id());
                save.accept(object).expect("accept");
            }
            writeln!(stdout, "PUBLISHED {}", first.expect("first")).expect("write");
            writeln!(stdout, "PENDING {}", last.expect("last")).expect("write");
            stdout.flush().expect("flush");
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        // 写一组带标签的对象并 finish；Busy 也是合法出口（非 Linux 无跨进程车道）。
        "write_set" => {
            let tag = std::env::var(TAG).expect("tag").into_bytes();
            let handles = Handles::open_writable(child_config()).expect("open");
            let storage = Storage::new(Arc::clone(&handles.storage) as Arc<dyn ObjectPersistence>)
                .expect("storage");
            let save = storage.begin_save().expect("save");
            let mut ids = Vec::new();
            for i in 0..600_u16 {
                let mut payload = tag.clone();
                payload.extend_from_slice(&i.to_be_bytes());
                let object = chunk_object(&payload);
                ids.push(object.id());
                if let Err(error) = save.accept(object) {
                    writeln!(stdout, "BUSY {error}").expect("write");
                    stdout.flush().expect("flush");
                    return;
                }
            }
            match save.finish() {
                Ok(_) => {
                    writeln!(stdout, "DONE {}", ids[0]).expect("write");
                }
                Err(error) => {
                    writeln!(stdout, "BUSY {error}").expect("write");
                }
            }
            stdout.flush().expect("flush");
        }
        // 持有一个写事务 1.5 秒后释放。
        "hold_write" => {
            let handles = Handles::open_writable(child_config()).expect("open");
            handles
                .storage
                .session
                .run(true, |_| {
                    writeln!(stdout, "HOLDING").expect("write");
                    stdout.flush().expect("flush");
                    std::thread::sleep(Duration::from_millis(1500));
                    Ok(())
                })
                .expect("hold transaction");
            writeln!(stdout, "RELEASED").expect("write");
            stdout.flush().expect("flush");
        }
        other => panic!("unknown child role {other}"),
    }
}

#[test]
fn published_batch_survives_process_kill_and_pending_does_not() {
    let temp = TempStore::new("crash");
    let handles = temp.create();
    drop(handles);
    let mut child = spawn_child("publish_and_hang", &temp.file(), "");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout"));
    let published: ObjectId = await_line(&mut reader, "PUBLISHED").parse().expect("id");
    let pending: ObjectId = await_line(&mut reader, "PENDING").parse().expect("id");
    child.kill().expect("kill");
    child.wait().expect("wait");
    let reopened = temp.open_writable();
    assert_eq!(
        read_objects(&reopened, &[published]).expect("read").len(),
        1
    );
    assert!(matches!(
        read_objects(&reopened, &[pending]).unwrap_err(),
        StorageError::ObjectMissing(id) if id == pending
    ));
}

#[test]
fn two_processes_write_concurrently() {
    let temp = TempStore::new("multi");
    let handles = temp.create();
    drop(handles);
    let mut a = spawn_child("write_set", &temp.file(), "alpha");
    let mut b = spawn_child("write_set", &temp.file(), "beta");
    let mut reader_a = BufReader::new(a.stdout.take().expect("stdout"));
    let mut reader_b = BufReader::new(b.stdout.take().expect("stdout"));
    let outcome_a = await_outcome(&mut reader_a);
    let outcome_b = await_outcome(&mut reader_b);
    assert!(a.wait().expect("wait").success());
    assert!(b.wait().expect("wait").success());
    let reopened = temp.open_writable();
    let mut done = 0;
    for outcome in [outcome_a, outcome_b] {
        match outcome {
            Outcome::Done(id) => {
                assert_eq!(read_objects(&reopened, &[id]).expect("read").len(), 1);
                done += 1;
            }
            Outcome::Busy => {
                // 非 Linux 没有跨进程写车道：并发写者得到精确 Busy 是文档化行为。
                assert!(
                    !cfg!(target_os = "linux"),
                    "Linux lane must queue, not Busy"
                );
            }
        }
    }
    if cfg!(target_os = "linux") {
        assert_eq!(done, 2);
    } else {
        assert!(done >= 1);
    }
}

enum Outcome {
    Done(ObjectId),
    Busy,
}

fn await_outcome(reader: &mut BufReader<std::process::ChildStdout>) -> Outcome {
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).expect("read child stdout");
        assert!(read != 0, "child exited before outcome");
        let line = line.trim_end();
        if let Some(id) = line.strip_prefix("DONE ") {
            return Outcome::Done(id.trim().parse().expect("id"));
        }
        if line.starts_with("BUSY ") {
            return Outcome::Busy;
        }
    }
}

#[test]
fn writer_in_another_process_queues_or_reports_busy() {
    let temp = TempStore::new("hold");
    let handles = temp.create();
    let mut child = spawn_child("hold_write", &temp.file(), "");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout"));
    await_line(&mut reader, "HOLDING");
    let started = Instant::now();
    let storage =
        Storage::new(Arc::clone(&handles.storage) as Arc<dyn ObjectPersistence>).expect("storage");
    let save = storage.begin_save().expect("save");
    let object = chunk_object(b"queued writer");
    let id = object.id();
    save.accept(object).expect("accept");
    let result = save.finish();
    let elapsed = started.elapsed();
    if cfg!(target_os = "linux") {
        // 父目录 flock：排队到子进程释放后完成写入，等待无时限。
        result.expect("queued write completes after release");
        assert!(
            elapsed >= Duration::from_millis(1000),
            "did not wait: {elapsed:?}"
        );
        assert_eq!(read_objects(&handles, &[id]).expect("read").len(), 1);
    } else {
        // 无跨进程车道的平台：SQLite 自身文件锁以精确 Busy 上报，一次尝试不重试。
        assert!(
            matches!(result, Err(StorageError::Busy)),
            "expected Busy, got {result:?}"
        );
        assert!(
            elapsed < Duration::from_millis(1000),
            "must not wait: {elapsed:?}"
        );
    }
    await_line(&mut reader, "RELEASED");
    assert!(child.wait().expect("wait").success());
}
