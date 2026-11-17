//! 用 `std::fs::File` 包一个裸 fd 做读写（`Read` + `Write`）。
//!
//! 子进程继承来的 socketpair fd 在 `std` 里没有现成的 owner 类型；本 crate 零依赖，
//! 也不引 `libc`，因此自己造一个最小包装：不拥有 fd 的生命周期（`serve_loop` 用
//! `_exit` 结束进程，不靠 Drop 关闭）。

use std::io::{self, Read, Write};
use std::os::raw::c_void;

use crate::sys;

pub struct FdStream {
    fd: i32,
}

impl FdStream {
    pub fn new(fd: i32) -> Self {
        Self { fd }
    }
}

impl Read for FdStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let count = unsafe { sys::read(self.fd, buf.as_mut_ptr() as *mut c_void, buf.len()) };
            if count >= 0 {
                return Ok(count as usize);
            }
            let error = io::Error::last_os_error();
            // EINTR：信号打断读，重试（读帧的文法里没有任何东西已经消费掉）
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
    }
}

impl Write for FdStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        loop {
            let count = unsafe { sys::write(self.fd, buf.as_ptr() as *const c_void, buf.len()) };
            if count >= 0 {
                return Ok(count as usize);
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        // socketpair 无缓冲，无需 flush
        Ok(())
    }
}
