//! 车道的测试：进程内并发发布串行化且无 Busy、排队中 `close` 得 `Closed`、隔离语义。

use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use layerfs::{ObjectPersistence, PersistenceError, Storage};

use crate::test_support::{chunk_object, read_objects, TempStore};

#[test]
fn in_process_concurrent_saves_serialize_without_busy() {
    let temp = TempStore::new("lane-concurrent");
    let handles = Arc::new(temp.create());
    let mut workers = Vec::new();
    for worker in 0..4_u8 {
        let handles = Arc::clone(&handles);
        workers.push(thread::spawn(move || {
            let storage = Storage::new(Arc::clone(&handles.storage) as Arc<dyn ObjectPersistence>)
                .expect("storage");
            let save = storage.begin_save().expect("save");
            let mut ids = Vec::new();
            for i in 0..50_u8 {
                let object = chunk_object(&[worker, i, i.wrapping_mul(3)]);
                ids.push(object.id());
                save.accept(object).expect("accept");
            }
            save.finish().expect("finish");
            ids
        }));
    }
    let mut all = Vec::new();
    for worker in workers {
        all.extend(worker.join().expect("worker"));
    }
    let read = read_objects(&handles, &all).expect("read");
    assert_eq!(read.len(), 200);
}

#[test]
fn close_wakes_queued_caller_with_closed() {
    let temp = TempStore::new("lane-close");
    let handles = Arc::new(temp.create());
    let (entered, entered_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel::<()>();
    // 持有者：在一次写事务体内停住，占住会话轮次。
    let holder = {
        let handles = Arc::clone(&handles);
        thread::spawn(move || {
            handles
                .storage
                .session
                .run(true, |_| {
                    entered.send(()).expect("entered");
                    release_rx.recv().expect("release");
                    Ok(())
                })
                .expect("holder transaction");
        })
    };
    entered_rx.recv().expect("holder entered");
    // 排队者：对同一会话发起写操作，进入 FIFO 等待。
    let queued = {
        let handles = Arc::clone(&handles);
        thread::spawn(move || handles.storage.reserve(layerfs::Reserve { packs: 1 }))
    };
    thread::sleep(Duration::from_millis(100));
    // 关闭会话：排队者以 Closed 返回，持有者跑到完成。
    handles.close();
    let queued_result = queued.join().expect("queued thread");
    assert!(matches!(queued_result, Err(PersistenceError::Closed)));
    release.send(()).expect("release holder");
    holder.join().expect("holder thread");
    // 后续调用同样 Closed。
    assert!(matches!(
        handles.storage.reserve(layerfs::Reserve { packs: 1 }),
        Err(PersistenceError::Closed)
    ));
}

#[test]
fn same_thread_reentry_is_refused_not_deadlocked() {
    let temp = TempStore::new("lane-reentry");
    let handles = temp.create();
    let result = handles.storage.session.run(false, |_| {
        // 轮次已被本线程持有：再进即自锁，必须以 Integrity 拒绝而不是挂死。
        match handles.storage.session.admission.enter() {
            Err(crate::error::BackendError::Integrity) => Ok(()),
            other => {
                drop(other);
                Err(crate::error::BackendError::Capacity)
            }
        }
    });
    assert!(result.is_ok());
}
