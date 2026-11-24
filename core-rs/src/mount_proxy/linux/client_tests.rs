//! Core ↔ 常驻挂载代理的帧契约对拍（specs/051 FR-007）。
//!
//! ## 为什么单独一个文件
//!
//! 构建指纹的守卫扫描 `core-rs/` 里每个会进产物的源文件，发现 `include*!` 指向
//! `fixtures/` 之外的路径就报错（`scripts/build-core.mjs` 的 `assertIncludesAreHashed`）。
//! 它是**文本扫描**，分不清 `#[cfg(test)]` —— 因此契约 fixture 不能和产品代码写在同一
//! 个文件里。文件名以 `_tests.rs` 结尾的文件由 `isProductSourceFile` 整体排除在指纹
//! 输入集之外，放这里既能让 `include_str!` 通过守卫，也不让测试内容影响远端槽位。
//!
//! ## 为什么 fixture 在 `mount-proxy-rs/`
//!
//! 契约是两侧共用的，但两侧各读一份就会各自腐烂。放在代理 crate 里、Core 侧用相对
//! 路径引用同一个文件，才谈得上「一份事实只有一个写入点」。反过来不行：`core-rs/fixtures/`
//! 不在指纹输入集里，代理侧引用它会让改 fixture 不触发 Core 重编。
//!
//! ## 这条对拍抓的是什么
//!
//! `specs/defects/mount-proxy-write-file-payload-type.md` 的形态：Core 发十六进制字符串，
//! 代理只认进程内枚举 `Value::Bytes`。两侧各自的单测都绿——Core 测「我发了个 Bytes」，
//! 代理测「我能解析 Bytes」——而线上一次都不通。契约 fixture 把「线上到底长什么样」
//! 变成两侧测试的同一个输入，任何一侧改编码，另一侧立刻红。

use super::*;

fn contract() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../mount-proxy-rs/fixtures/mountProxyProtocol.json"
    ))
    .expect("mountProxyProtocol.json 必须是合法 JSON")
}

fn cases() -> Vec<serde_json::Value> {
    contract()["cases"]
        .as_array()
        .expect("cases 必须是数组")
        .clone()
}

fn case_of(op: &str) -> serde_json::Value {
    cases()
        .into_iter()
        .find(|case| case["op"] == op)
        .unwrap_or_else(|| panic!("fixture 里没有 {op} 的用例"))
}

/// 帧在**线上**的字段集合：`op` 与 `fields` 合并。
///
/// `Frame` 把 `op` 单独存一个字段、只在 `encode()` 时才写进载荷对象，而 fixture 的
/// `request` 描述的是线上形态（含 `"op"`）。对拍必须按线上形态比，否则每条用例都会在
/// `op` 上报「缺字段」——那条断言测的是 `Frame` 的内部表示，不是契约。
fn wire_fields(frame: &Frame) -> serde_json::Map<String, serde_json::Value> {
    let mut all = serde_json::Map::new();
    all.insert(
        "op".to_string(),
        serde_json::Value::String(frame.op.clone()),
    );
    for (key, value) in &frame.fields {
        all.insert(key.clone(), value.clone());
    }
    all
}

/// 断言本模块实际发出的帧**字段集合**与 fixture 声明的一致。
///
/// 只比字段名与 JSON 类型，不比具体值：值由调用方给（路径 / 内容都是动态的），而
/// 「字段叫什么、编码成什么类型」正是两端最容易漂的那部分。
fn assert_request_shape(op: &str, actual: &Frame) {
    // 先落成具名值：直接索引表达式产生的是临时值，借用会在语句结束就失效
    let case = case_of(op);
    let expected = case["request"].as_object().expect("request 必须是对象");
    let actual = wire_fields(actual);
    for (key, want) in expected {
        let got = actual
            .get(key)
            .unwrap_or_else(|| panic!("{op} 的请求缺字段 {key}（Core 没发，或 fixture 过期）"));
        let same_kind = matches!(
            (want, got),
            (serde_json::Value::String(_), serde_json::Value::String(_))
                | (serde_json::Value::Number(_), serde_json::Value::Number(_))
                | (serde_json::Value::Bool(_), serde_json::Value::Bool(_))
                | (serde_json::Value::Array(_), serde_json::Value::Array(_))
        );
        assert!(
            same_kind,
            "{op}.{key} 的类型漂了：fixture 声明 {}，Core 实际发 {}",
            want, got
        );
    }
    // 反向：Core 多发的字段 fixture 里也要有，否则代理侧的解析用例看不到它
    for key in actual.keys() {
        assert!(
            expected.contains_key(key),
            "{op} 发了 fixture 未声明的字段 {key}：先更新 mountProxyProtocol.json"
        );
    }
}

#[test]
fn contract_protocol_version_matches() {
    assert_eq!(
        contract()["ipcProtocolVersion"].as_u64().unwrap(),
        IPC_PROTOCOL_VERSION as u64,
        "fixture 与 Core 的运行期协议版本必须一致"
    );
}

/// 对拍不是「永远绿」：画面多一个 fixture 未声明的字段必须红。
///
/// 反向用例存在的理由与正向用例相同——`wire_fields` 把 `op` 合进合集之后，如果某个环节
/// 退化成只比交集，正向的四条会照样绿。
#[test]
#[should_panic(expected = "fixture 未声明的字段")]
fn request_shape_rejects_undeclared_field() {
    let frame = Frame::new("ping")
        .with_id(1)
        .with("surprise", serde_json::Value::from(1u64));
    assert_request_shape("ping", &frame);
}

/// 另一半：fixture 声明了而 Core 没发，必须红（契约漏发字段）。
#[test]
#[should_panic(expected = "缺字段")]
fn request_shape_rejects_missing_field() {
    // readFile 的契约要求 `path` 与 `maxBytes` 都在
    let frame = Frame::new("readFile")
        .with_id(4)
        .with("path", serde_json::Value::String("/w/a.txt".into()));
    assert_request_shape("readFile", &frame);
}

/// `writeFile` 的 `bytes` 是**十六进制字符串**——问题 1 的 Core 侧对拍点。
#[test]
fn write_file_sends_hex_string_bytes() {
    let frame = Frame::new("writeFile")
        .with_id(5)
        .with("path", serde_json::Value::String("/w/a.txt".into()))
        .with("bytes", serde_json::Value::String(encode_hex(b"hello")));
    assert_request_shape("writeFile", &frame);
    // 明确锁住编码形态：不是数组、不是 base64、就是小写十六进制
    assert_eq!(
        frame.fields.get("bytes").unwrap().as_str().unwrap(),
        "68656c6c6f"
    );
}

#[test]
fn read_file_request_shape_matches_contract() {
    let frame = Frame::new("readFile")
        .with_id(4)
        .with("path", serde_json::Value::String("/w/a.txt".into()))
        .with("maxBytes", serde_json::Value::from(4u64));
    assert_request_shape("readFile", &frame);
}

#[test]
fn spawn_request_shape_matches_contract() {
    let frame = Frame::new("spawn")
        .with_id(10)
        .with(
            "argv",
            serde_json::Value::Array(vec![
                serde_json::Value::String("/bin/sh".into()),
                serde_json::Value::String("-c".into()),
                serde_json::Value::String("echo hi".into()),
            ]),
        )
        .with("cwd", serde_json::Value::String("/w".into()))
        .with(
            "env",
            serde_json::Value::Array(vec![serde_json::Value::String("PATH=/usr/bin:/bin".into())]),
        )
        .with("stdin", serde_json::Value::String(encode_hex(b"hi")));
    assert_request_shape("spawn", &frame);
}

#[test]
fn kill_request_shape_matches_contract() {
    let frame = Frame::new("kill")
        .with_id(11)
        .with("target", serde_json::Value::from(10u64));
    assert_request_shape("kill", &frame);
}

/// specs/056 的三个新 op：视图端传输的改名 / 清理 / 分块读（字段集合与 fixture 对齐）。
#[test]
fn view_io_request_shapes_match_contract() {
    let rename = Frame::new("renamePath")
        .with_id(12)
        .with(
            "from",
            serde_json::Value::String("/w/a.txt.tuxedo-transfer-tmp".into()),
        )
        .with("to", serde_json::Value::String("/w/a.txt".into()));
    assert_request_shape("renamePath", &rename);

    let unlink = Frame::new("unlinkPath").with_id(13).with(
        "path",
        serde_json::Value::String("/w/a.txt.tuxedo-transfer-tmp".into()),
    );
    assert_request_shape("unlinkPath", &unlink);

    let read = Frame::new("readRange")
        .with_id(14)
        .with("path", serde_json::Value::String("/w/big.bin".into()))
        .with("offset", serde_json::Value::from(1_048_576u64))
        .with("length", serde_json::Value::from(1_048_576u64));
    assert_request_shape("readRange", &read);
}

/// 定向写的帧形态（specs/056 FR-003）：`offset` 是**可选**字段，给了才走分块写。
///
/// 这条不对 fixture 做整帧比对（fixture 的 `writeFile` 用例是老语义的整文件写），而是锁
/// 「同样的 op 名 + 多两个字段」——代理侧 `serve.rs` 按字段存在与否分流，名字漂了两端就不通。
#[test]
fn write_file_offset_fields_are_optional() {
    let ranged = Frame::new("writeFile")
        .with_id(5)
        .with("path", serde_json::Value::String("/w/a.txt".into()))
        .with("bytes", serde_json::Value::String(encode_hex(b"hello")))
        .with("offset", serde_json::Value::from(0u64));
    let wire = wire_fields(&ranged);
    assert_eq!(wire.get("offset").and_then(|v| v.as_u64()), Some(0));
    assert_eq!(wire.get("path").and_then(|v| v.as_str()), Some("/w/a.txt"));
}

/// 代理回给 Core 的应答形状：Core 侧的读线程按这些字段名取值，改名会静默变默认值。
#[test]
fn response_shapes_match_contract() {
    // listDir 的 entries 元素字段必须落在 Core 的解析白名单内
    let list_case = case_of("listDir");
    let entry = &list_case["expect"]["entries"][0];
    for key in entry.as_object().unwrap().keys() {
        assert!(
            matches!(key.as_str(), "name" | "isDir" | "size" | "isSymlink"),
            "listDir 目录项字段 {key} 不在 Core 的解析白名单里"
        );
    }
    // stat 的字段
    let stat_case = case_of("stat");
    let stat = stat_case["expect"].as_object().unwrap();
    for key in ["exists", "isFile", "isDir", "isSymlink", "size"] {
        assert!(stat.contains_key(key), "stat 应答缺 {key}");
    }
    // spawn 的流式应答必须带同一个 id
    let spawn_case = case_of("spawn");
    let streams = spawn_case["expect"]["streams"].as_array().unwrap();
    for stream in streams {
        assert_eq!(
            stream["id"], spawn_case["expect"]["id"],
            "spawn 的流式片段必须与 exit 同 id"
        );
    }
}
