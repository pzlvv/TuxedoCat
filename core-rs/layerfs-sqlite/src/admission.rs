//! 进程内每会话的 FIFO 连接准入：一次 SQL 尝试之前先排到自己的轮次。
//!
//! 排队的调用方无时限等待自己的轮次：等待是就绪而不是重试，正确的排队工作绝不因
//! 等待而被拒绝。每个排队条目是一个阻塞线程，队列由进程能跑的线程数而非计数上界。
//! 等待者只以具名出口提前离开：`Closed`（`close` 在其轮次前被调用）、`Unknown`
//! （持有者 panic 让队列互斥量中毒）、`Integrity`（本线程已持有轮次，再等就自锁）。
//! 持有者 unwind 仍释放轮次（`Turn` 的 Drop）。与上游 admission.rs 同语义。

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::thread::ThreadId;

use crate::error::BackendError;

#[derive(Default)]
struct Queue {
    next: u64,
    /// 轮次进行中的线程。
    active: Option<ThreadId>,
    /// 由 `close` 置位一次；此后排队与后续条目都报 `Closed`。
    closed: bool,
    /// 到达序的等待票；队首下一个被准入。
    pending: VecDeque<u64>,
}

#[derive(Default)]
pub(crate) struct Admission {
    queue: Mutex<Queue>,
    changed: Condvar,
}

/// 一个被准入的轮次；Drop 即释放并唤醒队列。
pub(crate) struct Turn<'a> {
    admission: &'a Admission,
}

impl Admission {
    /// 先到先服务地等待本连接的轮次。
    pub(crate) fn enter(&self) -> Result<Turn<'_>, BackendError> {
        let mut queue = self.queue.lock().map_err(|_| BackendError::Unknown)?;
        let thread = std::thread::current().id();
        if queue.closed {
            return Err(BackendError::Closed);
        }
        if queue.active == Some(thread) {
            return Err(BackendError::Integrity);
        }
        if queue.active.is_none() && queue.pending.is_empty() {
            queue.active = Some(thread);
            return Ok(Turn { admission: self });
        }
        let ticket = queue.next;
        queue.next = queue.next.wrapping_add(1);
        queue.pending.push_back(ticket);
        loop {
            if queue.closed {
                queue.pending.retain(|value| *value != ticket);
                return Err(BackendError::Closed);
            }
            if queue.active.is_none() && queue.pending.front() == Some(&ticket) {
                queue.pending.pop_front();
                queue.active = Some(thread);
                return Ok(Turn { admission: self });
            }
            queue = self
                .changed
                .wait(queue)
                .map_err(|_| BackendError::Unknown)?;
        }
    }

    /// 以 `Closed` 拒绝每个排队与后续条目并唤醒队列。进行中的轮次跑到完成。
    pub(crate) fn close(&self) {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        queue.closed = true;
        self.changed.notify_all();
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        // 本操作绝不在调用 SQL 时持有该互斥量；中毒的队列同样释放，后续准入仍拒绝。
        let mut queue = self
            .admission
            .queue
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        queue.active = None;
        self.admission.changed.notify_all();
    }
}
