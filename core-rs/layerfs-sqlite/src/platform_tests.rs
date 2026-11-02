//! StorePath 规范化的测试（AC-15）。

use std::path::Path;

use super::*;
use crate::test_support::{store_chunks, TempStore};
use crate::Handles;

#[test]
fn equivalent_spellings_normalize_to_one_path() {
    let base = Path::new("/var/lib/demo/project.layerfs");
    let redundant = Path::new("/var//lib/./demo/./project.layerfs");
    let a = StorePath::from_os(base).expect("path");
    let b = StorePath::from_os(redundant).expect("path");
    assert_eq!(a, b);
    assert_eq!(a.as_path(), Path::new("/var/lib/demo/project.layerfs"));
    assert_eq!(a.parent_dir(), Path::new("/var/lib/demo"));
    // 裸文件名的父目录是 `.`。
    assert_eq!(
        StorePath::from_os(Path::new("store.layerfs"))
            .expect("path")
            .parent_dir(),
        Path::new(".")
    );
}

#[test]
fn empty_or_directory_like_paths_are_refused() {
    assert!(StorePath::from_os(Path::new("")).is_err());
    assert!(StorePath::from_os(Path::new("/")).is_err());
}

#[test]
fn two_spellings_open_the_same_store() {
    let temp = TempStore::new("platform");
    let handles = temp.create();
    let ids = store_chunks(&handles, &[b"same store"]);
    drop(handles);
    // 冗余分隔符 + `.` 段的写法指向同一个文件。
    let spelled = std::path::PathBuf::from(format!("{}//./store.layerfs", temp.dir().display()));
    let config = crate::PersistenceConfig::sqlite(
        StorePath::from_os(&spelled).expect("path"),
        crate::SqlitePersistenceProfile::Disposable,
    );
    assert_eq!(config.path, temp.path());
    let reopened = Handles::open_writable(config).expect("open");
    let read = crate::test_support::read_objects(&reopened, &ids).expect("read");
    assert_eq!(read.len(), 1);
}
