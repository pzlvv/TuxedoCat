-- LayerFS Store schema v1（docs/core/layerfs.md 第 5 节）。
-- 本系列自己的格式：与上游 Store 文件不互开，application_id / user_version 由 schema.rs 写入。
-- 036 的 pack 是单记录布局：每对象一个 pack，body = 原始规范字节（无帧、无压缩），
-- 定位行恒 group_number=0 / record_number=0；后续编码 spec 以 user_version 前向演进。
CREATE TABLE store_policy (
 id INTEGER PRIMARY KEY CHECK(id=1),
 format_profile INTEGER NOT NULL CHECK(format_profile=1),
 cdc_profile_id BLOB NOT NULL CHECK(length(cdc_profile_id)=32),
 small_file_threshold_bytes INTEGER NOT NULL CHECK(small_file_threshold_bytes BETWEEN 131072 AND 1048576),
 whole_file_delta_max_depth INTEGER NOT NULL CHECK(whole_file_delta_max_depth BETWEEN 0 AND 50),
 chunk_delta_max_depth INTEGER NOT NULL CHECK(chunk_delta_max_depth BETWEEN 0 AND 50),
 metadata_delta_max_depth INTEGER NOT NULL CHECK(metadata_delta_max_depth BETWEEN 0 AND 50),
 next_pack_id INTEGER NOT NULL DEFAULT 1 CHECK(next_pack_id>0)
) STRICT;
CREATE TABLE pack (
 pack_id INTEGER PRIMARY KEY CHECK(pack_id>0),
 domain INTEGER NOT NULL CHECK(domain IN(0,1)),
 digest BLOB NOT NULL CHECK(length(digest)=32),
 length INTEGER NOT NULL CHECK(length BETWEEN 13 AND 16781312),
 body BLOB NOT NULL CHECK(length(body)=length),
 CHECK(domain=1 OR length<=262144)
) STRICT;
CREATE TRIGGER pack_immutable_update BEFORE UPDATE ON pack BEGIN
 SELECT RAISE(ABORT,'published pack immutable'); END;
CREATE TRIGGER pack_immutable_delete BEFORE DELETE ON pack BEGIN
 SELECT RAISE(ABORT,'published pack immutable'); END;
CREATE TABLE object_location (
 object_id BLOB PRIMARY KEY CHECK(length(object_id)=32),
 role INTEGER NOT NULL CHECK(role BETWEEN 1 AND 13),
 canonical_length INTEGER NOT NULL CHECK(canonical_length BETWEEN 1 AND 16777216),
 pack_id INTEGER NOT NULL REFERENCES pack(pack_id),
 group_number INTEGER NOT NULL CHECK(group_number BETWEEN 0 AND 255),
 record_number INTEGER NOT NULL CHECK(record_number BETWEEN 0 AND 8190)
) STRICT, WITHOUT ROWID;
CREATE TABLE store_totals (
 id INTEGER PRIMARY KEY CHECK(id=1),
 canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical>=0),
 stored INTEGER NOT NULL DEFAULT 0 CHECK(stored>=0),
 metadata INTEGER NOT NULL DEFAULT 0 CHECK(metadata>=0)
) STRICT;
