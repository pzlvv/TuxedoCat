//! provider 的测试：发布 / 定位 / 整包读出往返、first-wins 败方、计数行与 id 分配。

use std::sync::Arc;

use layerfs::port::{
    ObjectKey, ObjectLocation, ObjectPersistence, PackDomain, PackInfo, Publication, PublishedPack,
    Reserve,
};
use layerfs::ObjectRole;

use crate::test_support::{chunk_object, TempStore};

fn publication(
    handles: &crate::Handles,
    payloads: &[&[u8]],
) -> (Publication, Vec<layerfs::ObjectId>) {
    let reserved = handles
        .storage
        .reserve(Reserve {
            packs: payloads.len(),
        })
        .expect("reserve");
    let mut batch = Publication::default();
    let mut ids = Vec::new();
    for (offset, payload) in payloads.iter().enumerate() {
        let object = chunk_object(payload);
        let canonical = object.canonical().to_vec();
        let pack_id = reserved.first_pack_id + offset as i64;
        batch.packs.push(PublishedPack {
            info: PackInfo {
                pack_id,
                domain: PackDomain::Payload,
                key: ObjectKey::for_bytes(&canonical),
                length: canonical.len(),
            },
            body: Arc::new(canonical.clone()),
        });
        batch.objects.push(ObjectLocation {
            object_id: object.id(),
            role: ObjectRole::Chunk,
            canonical_length: canonical.len(),
            pack_id,
            group_number: 0,
            record_number: 0,
        });
        ids.push(object.id());
    }
    (batch, ids)
}

#[test]
fn publish_locate_read_packs_round_trip() {
    let temp = TempStore::new("provider");
    let handles = temp.create();
    let (batch, ids) = publication(&handles, &[b"one", b"two"]);
    let published = handles.storage.publish(&batch).expect("publish");
    assert!(published.lost.is_empty());

    let mut located = Vec::new();
    handles.storage.locate(&ids, &mut located).expect("locate");
    assert_eq!(located.len(), 2);
    for (entry, row) in located.iter().zip(&batch.objects) {
        assert_eq!(entry.location, *row);
        assert_eq!(entry.pack.pack_id, row.pack_id);
    }
    let mut packs = Vec::new();
    handles
        .storage
        .read_packs(
            &[located[0].pack.pack_id, located[1].pack.pack_id],
            &mut packs,
        )
        .expect("read packs");
    assert_eq!(packs.len(), 2);
    for pack in &packs {
        pack.authenticate().expect("authenticated");
    }
    // 缺席的 id / pack 被省略而不是报错。
    let mut none = Vec::new();
    handles
        .storage
        .locate(&[layerfs::ObjectId::for_bytes(b"ghost")], &mut none)
        .expect("locate");
    assert!(none.is_empty());
    let mut missing_packs = Vec::new();
    handles
        .storage
        .read_packs(&[999], &mut missing_packs)
        .expect("read packs");
    assert!(missing_packs.is_empty());
}

#[test]
fn first_wins_reports_losers_and_keeps_winner_row() {
    let temp = TempStore::new("first-wins");
    let handles = temp.create();
    let (first, ids) = publication(&handles, &[b"dup"]);
    handles.storage.publish(&first).expect("publish");
    let (second, same_ids) = publication(&handles, &[b"dup"]);
    assert_eq!(ids, same_ids);
    let published = handles.storage.publish(&second).expect("publish");
    assert_eq!(published.lost, ids);
    // 胜方定位行保持原 pack。
    let mut located = Vec::new();
    handles.storage.locate(&ids, &mut located).expect("locate");
    assert_eq!(located[0].location.pack_id, first.objects[0].pack_id);
}

#[test]
fn reserve_allocates_consecutive_ids() {
    let temp = TempStore::new("reserve");
    let handles = temp.create();
    let a = handles
        .storage
        .reserve(Reserve { packs: 3 })
        .expect("reserve");
    let b = handles
        .storage
        .reserve(Reserve { packs: 2 })
        .expect("reserve");
    assert_eq!(a.first_pack_id, 1);
    assert_eq!(b.first_pack_id, 4);
}

#[test]
fn totals_accumulate_only_for_inserted_rows() {
    let temp = TempStore::new("totals");
    let handles = temp.create();
    let (batch, _) = publication(&handles, &[b"count me"]);
    handles.storage.publish(&batch).expect("publish");
    let (again, _) = publication(&handles, &[b"count me"]);
    handles.storage.publish(&again).expect("publish");
    let connection = rusqlite::Connection::open(temp.file()).expect("open");
    let (canonical, stored): (i64, i64) = connection
        .query_row(
            "SELECT canonical,stored FROM store_totals WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("totals");
    let length = batch.objects[0].canonical_length as i64;
    // 规范字节只记胜方一次；pack 字节两次都写入（孤儿 pack 容忍）。
    assert_eq!(canonical, length);
    assert_eq!(stored, 2 * length);
}
