mod common;

use common::{
    bearer, create_room, recv_event_type, register_user, spawn_server, ws_connect_authenticated,
};
use reqwest::{multipart, Client, StatusCode};
use serde_json::{json, Value};

#[tokio::test]
async fn auth_contract_register_login_logout_and_failures() {
    let server = spawn_server().await;
    let client = Client::new();

    let register_response = client
        .post(format!("{}/_matrix/client/r0/register", server.base_url))
        .json(&json!({"username": "alice", "password": "pw", "device_id": "a1"}))
        .send()
        .await
        .unwrap();
    assert_eq!(register_response.status(), StatusCode::OK);
    let register_body: Value = register_response.json().await.unwrap();
    assert_eq!(register_body["user_id"], "@alice:localhost");
    let token = register_body["access_token"].as_str().unwrap().to_string();

    let duplicate_register = client
        .post(format!("{}/_matrix/client/r0/register", server.base_url))
        .json(&json!({"username": "alice", "password": "pw"}))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate_register.status(), StatusCode::BAD_REQUEST);

    let bad_login = client
        .post(format!("{}/_matrix/client/r0/login", server.base_url))
        .json(&json!({"username": "alice", "password": "wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_login.status(), StatusCode::FORBIDDEN);

    let login_response = client
        .post(format!("{}/_matrix/client/r0/login", server.base_url))
        .json(&json!({"username": "alice", "password": "pw", "device_id": "a2"}))
        .send()
        .await
        .unwrap();
    assert_eq!(login_response.status(), StatusCode::OK);
    let login_body: Value = login_response.json().await.unwrap();
    let login_token = login_body["access_token"].as_str().unwrap().to_string();
    assert_ne!(login_token, token);

    let logout_missing_token = client
        .post(format!("{}/_matrix/client/r0/logout", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(logout_missing_token.status(), StatusCode::UNAUTHORIZED);

    let logout_ok = client
        .post(format!("{}/_matrix/client/r0/logout", server.base_url))
        .header("authorization", bearer(&login_token))
        .send()
        .await
        .unwrap();
    assert_eq!(logout_ok.status(), StatusCode::OK);

    let joined_rooms_after_logout = client
        .get(format!(
            "{}/_matrix/client/r0/joined_rooms",
            server.base_url
        ))
        .header("authorization", bearer(&login_token))
        .send()
        .await
        .unwrap();
    assert_eq!(joined_rooms_after_logout.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn room_contract_join_leave_and_dm_dedup() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;
    let (bob_user_id, bob_token) = register_user(&client, &server.base_url, "bob", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "General",
        None,
        false,
    )
    .await;

    let bob_join = client
        .post(format!(
            "{}/_matrix/client/r0/rooms/{}/join",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(bob_join.status(), StatusCode::OK);

    let bob_joined_rooms = client
        .get(format!(
            "{}/_matrix/client/r0/joined_rooms",
            server.base_url
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(bob_joined_rooms.status(), StatusCode::OK);
    let joined_body: Value = bob_joined_rooms.json().await.unwrap();
    let joined = joined_body["joined_rooms"].as_array().unwrap();
    assert!(joined.iter().any(|entry| entry.as_str() == Some(&room_id)));

    let bob_leave = client
        .post(format!(
            "{}/_matrix/client/r0/rooms/{}/leave",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(bob_leave.status(), StatusCode::OK);

    let dm_1 = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "",
        Some(vec![bob_user_id.clone()]),
        true,
    )
    .await;
    let dm_2 = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "",
        Some(vec![bob_user_id.clone()]),
        true,
    )
    .await;
    assert_eq!(dm_1, dm_2);

    let self_dm = client
        .post(format!("{}/_matrix/client/r0/createRoom", server.base_url))
        .header("authorization", bearer(&alice_token))
        .json(&json!({
            "invite": ["@alice:localhost"],
            "is_direct": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(self_dm.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn message_contract_reply_redact_reaction_toggle_and_sync_shape() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;
    let (bob_user_id, bob_token) = register_user(&client, &server.base_url, "bob", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "General",
        Some(vec![bob_user_id]),
        false,
    )
    .await;

    let send_1 = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.room.message/txn1",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .json(&json!({"msgtype": "m.text", "body": "hello"}))
        .send()
        .await
        .unwrap();
    assert_eq!(send_1.status(), StatusCode::OK);
    let send_1_body: Value = send_1.json().await.unwrap();
    let first_event_id = send_1_body["event_id"].as_str().unwrap().to_string();

    let send_2 = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.room.message/txn2",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&bob_token))
        .json(&json!({
            "msgtype": "m.text",
            "body": "reply",
            "in_reply_to": first_event_id
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_2.status(), StatusCode::OK);
    let send_2_body: Value = send_2.json().await.unwrap();
    let second_event_id = send_2_body["event_id"].as_str().unwrap().to_string();

    let messages = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{}/messages?limit=20",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(messages.status(), StatusCode::OK);
    let messages_body: Value = messages.json().await.unwrap();
    let chunk = messages_body["chunk"].as_array().unwrap();
    assert!(chunk.len() >= 2);
    let reply_message = chunk
        .iter()
        .find(|event| event["event_id"].as_str() == Some(second_event_id.as_str()))
        .unwrap();
    assert_eq!(reply_message["content"]["in_reply_to"], first_event_id);
    assert_eq!(
        reply_message["content"]["reply_to_sender"],
        "@alice:localhost"
    );

    let unauthorized_redact = client
        .delete(format!(
            "{}/_matrix/client/r0/rooms/{}/redact/{}/txn3",
            server.base_url, room_id, first_event_id
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_redact.status(), StatusCode::FORBIDDEN);

    let redact_ok = client
        .delete(format!(
            "{}/_matrix/client/r0/rooms/{}/redact/{}/txn4",
            server.base_url, room_id, first_event_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(redact_ok.status(), StatusCode::OK);

    let messages_after_redact = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{}/messages?limit=20",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    let redacted_chunk: Value = messages_after_redact.json().await.unwrap();
    let redacted_event = redacted_chunk["chunk"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["event_id"].as_str() == Some(first_event_id.as_str()))
        .unwrap();
    assert_eq!(redacted_event["redacted"], true);
    assert_eq!(redacted_event["content"]["body"], "[deleted]");

    let reaction_add = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.reaction/{}",
            server.base_url, room_id, second_event_id
        ))
        .header("authorization", bearer(&bob_token))
        .json(&json!({"emoji": "👍"}))
        .send()
        .await
        .unwrap();
    assert_eq!(reaction_add.status(), StatusCode::OK);

    let reaction_remove = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.reaction/{}",
            server.base_url, room_id, second_event_id
        ))
        .header("authorization", bearer(&bob_token))
        .json(&json!({"emoji": "👍"}))
        .send()
        .await
        .unwrap();
    assert_eq!(reaction_remove.status(), StatusCode::OK);

    let reactions = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{}/event/{}/reactions",
            server.base_url, room_id, second_event_id
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(reactions.status(), StatusCode::OK);
    let reactions_body: Value = reactions.json().await.unwrap();
    assert_eq!(reactions_body["reactions"], json!({}));

    let sync_response = client
        .get(format!("{}/_matrix/client/r0/sync", server.base_url))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(sync_response.status(), StatusCode::OK);
    let sync_body: Value = sync_response.json().await.unwrap();

    let joined_room = &sync_body["rooms"]["join"][room_id.as_str()];
    assert!(joined_room.is_object());
    assert!(joined_room["state"]["events"].is_array());
    assert!(joined_room["timeline"]["events"].is_array());
}

#[tokio::test]
async fn topic_update_broadcast_payload_shape() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;
    let (bob_user_id, bob_token) = register_user(&client, &server.base_url, "bob", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "General",
        Some(vec![bob_user_id]),
        false,
    )
    .await;

    let mut bob_ws = ws_connect_authenticated(&server.ws_url, &bob_token).await;
    let _connected = recv_event_type(&mut bob_ws, "connected").await;

    let update = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/state/m.room.topic",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .json(&json!({"topic": "Engineering"}))
        .send()
        .await
        .unwrap();
    assert_eq!(update.status(), StatusCode::OK);

    let topic_event = recv_event_type(&mut bob_ws, "m.room.topic").await;
    assert_eq!(topic_event["room_id"], room_id);
    assert_eq!(topic_event["sender"], "@alice:localhost");
    assert_eq!(topic_event["content"]["topic"], "Engineering");
}

#[tokio::test]
async fn voice_presence_and_upload_contract_auth_and_size_checks() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "General",
        None,
        false,
    )
    .await;

    let unauthorized_voice = client
        .get(format!("{}/api/rooms/{}/voice", server.base_url, room_id))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_voice.status(), StatusCode::UNAUTHORIZED);

    let room_not_found_voice = client
        .get(format!(
            "{}/api/rooms/does-not-exist/voice",
            server.base_url
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(room_not_found_voice.status(), StatusCode::NOT_FOUND);

    let voice_ok = client
        .get(format!("{}/api/rooms/{}/voice", server.base_url, room_id))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(voice_ok.status(), StatusCode::OK);
    let voice_body: Value = voice_ok.json().await.unwrap();
    assert_eq!(voice_body["room_id"], room_id);
    assert_eq!(voice_body["voice_members"], json!([]));

    let presence_ok = client
        .get(format!(
            "{}/api/rooms/{}/presence",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(presence_ok.status(), StatusCode::OK);

    let missing_auth_form = multipart::Form::new().text("filename", "tiny.bin").part(
        "file",
        multipart::Part::bytes(vec![1_u8, 2_u8, 3_u8]).file_name("tiny.bin"),
    );
    let upload_without_auth = client
        .post(format!("{}/api/upload", server.base_url))
        .multipart(missing_auth_form)
        .send()
        .await
        .unwrap();
    assert_eq!(upload_without_auth.status(), StatusCode::UNAUTHORIZED);

    let oversized_file = vec![b'x'; 10 * 1024 * 1024 + 1];
    let form = multipart::Form::new().text("filename", "big.bin").part(
        "file",
        multipart::Part::bytes(oversized_file).file_name("big.bin"),
    );

    let oversized_upload = client
        .post(format!("{}/api/upload", server.base_url))
        .header("authorization", bearer(&alice_token))
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(oversized_upload.status(), StatusCode::BAD_REQUEST);

    let body: Value = oversized_upload.json().await.unwrap();
    assert_eq!(body["error"], "File too large (max 10MB)");
}

#[tokio::test]
async fn pin_contract_permissions_broadcast_and_redaction_cleanup() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;
    let (bob_user_id, bob_token) = register_user(&client, &server.base_url, "bob", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "Pins",
        Some(vec![bob_user_id]),
        false,
    )
    .await;

    let send = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.room.message/pin-txn1",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .json(&json!({"msgtype": "m.text", "body": "worth keeping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(send.status(), StatusCode::OK);
    let event_id = send.json::<Value>().await.unwrap()["event_id"]
        .as_str()
        .unwrap()
        .to_string();

    // The message landed in the room's default text channel; pins are scoped to it.
    let messages: Value = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{}/messages?limit=20",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let channel_id = messages["chunk"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["event_id"].as_str() == Some(event_id.as_str()))
        .and_then(|event| event["channel_id"].as_str())
        .unwrap_or("")
        .to_string();

    // A plain member cannot pin.
    let forbidden = client
        .post(format!(
            "{}/api/rooms/{}/pins/{}",
            server.base_url, room_id, event_id
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let mut bob_ws = ws_connect_authenticated(&server.ws_url, &bob_token).await;

    let pinned = client
        .post(format!(
            "{}/api/rooms/{}/pins/{}",
            server.base_url, room_id, event_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(pinned.status(), StatusCode::OK);

    let pin_event = recv_event_type(&mut bob_ws, "m.room.pinned").await;
    assert_eq!(pin_event["room_id"], room_id);
    assert_eq!(pin_event["event_id"], event_id);
    assert_eq!(pin_event["pinned_by"], "@alice:localhost");
    assert_eq!(pin_event["message"]["content"]["body"], "worth keeping");

    // Pinning twice is rejected.
    let duplicate = client
        .post(format!(
            "{}/api/rooms/{}/pins/{}",
            server.base_url, room_id, event_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);

    // Every member can read the pin list.
    let list: Value = client
        .get(format!(
            "{}/api/rooms/{}/pins?channel_id={}",
            server.base_url, room_id, channel_id
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pins = list["pins"].as_array().unwrap();
    assert_eq!(pins.len(), 1);
    assert_eq!(pins[0]["event_id"], event_id);
    assert_eq!(pins[0]["pinned_by"], "@alice:localhost");
    assert!(pins[0]["pinned_at"].as_i64().unwrap() > 0);

    // Deleting the message drops its pin and tells the room.
    let redact = client
        .delete(format!(
            "{}/_matrix/client/r0/rooms/{}/redact/{}/pin-txn2",
            server.base_url, room_id, event_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(redact.status(), StatusCode::OK);

    let unpin_event = recv_event_type(&mut bob_ws, "m.room.unpinned").await;
    assert_eq!(unpin_event["event_id"], event_id);

    let list_after: Value = client
        .get(format!(
            "{}/api/rooms/{}/pins?channel_id={}",
            server.base_url, room_id, channel_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list_after["pins"].as_array().unwrap().len(), 0);

    // The pin is gone, so unpinning again is a 404.
    let unpin_missing = client
        .delete(format!(
            "{}/api/rooms/{}/pins/{}",
            server.base_url, room_id, event_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(unpin_missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn pin_and_search_pagination_contract() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "Paging",
        None,
        false,
    )
    .await;

    // Five messages, all pinned, all matching the same search term.
    let mut event_ids = Vec::new();
    for i in 0..5 {
        let send = client
            .put(format!(
                "{}/_matrix/client/r0/rooms/{}/send/m.room.message/page-txn{}",
                server.base_url, room_id, i
            ))
            .header("authorization", bearer(&alice_token))
            .json(&json!({"msgtype": "m.text", "body": format!("needle {}", i)}))
            .send()
            .await
            .unwrap();
        assert_eq!(send.status(), StatusCode::OK);
        let event_id = send.json::<Value>().await.unwrap()["event_id"]
            .as_str()
            .unwrap()
            .to_string();

        let pinned = client
            .post(format!(
                "{}/api/rooms/{}/pins/{}",
                server.base_url, room_id, event_id
            ))
            .header("authorization", bearer(&alice_token))
            .send()
            .await
            .unwrap();
        assert_eq!(pinned.status(), StatusCode::OK);
        event_ids.push(event_id);
    }

    let channel_id = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{}/messages?limit=20",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["chunk"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["event_id"].as_str() == Some(event_ids[0].as_str()))
        .and_then(|event| event["channel_id"].as_str())
        .unwrap_or("")
        .to_string();

    // ── Pins page through, newest pin first, without repeating a row ──
    let fetch_pins = |offset: u64| {
        let client = client.clone();
        let base_url = server.base_url.clone();
        let room_id = room_id.clone();
        let channel_id = channel_id.clone();
        let token = alice_token.clone();
        async move {
            client
                .get(format!(
                    "{}/api/rooms/{}/pins?channel_id={}&limit=2&offset={}",
                    base_url, room_id, channel_id, offset
                ))
                .header("authorization", bearer(&token))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };

    let first = fetch_pins(0).await;
    assert_eq!(first["pins"].as_array().unwrap().len(), 2);
    assert_eq!(first["has_more"], true);
    assert_eq!(first["next_offset"], 2);
    // Newest pin first: the last message pinned leads the list.
    assert_eq!(first["pins"][0]["event_id"], event_ids[4]);

    let second = fetch_pins(first["next_offset"].as_u64().unwrap()).await;
    assert_eq!(second["pins"].as_array().unwrap().len(), 2);
    assert_eq!(second["has_more"], true);
    assert_eq!(second["pins"][0]["event_id"], event_ids[2]);

    let third = fetch_pins(second["next_offset"].as_u64().unwrap()).await;
    assert_eq!(third["pins"].as_array().unwrap().len(), 1);
    assert_eq!(third["has_more"], false);
    assert_eq!(third["pins"][0]["event_id"], event_ids[0]);

    // ── Search pages the same way ──
    let search_page = |offset: u64| {
        let client = client.clone();
        let base_url = server.base_url.clone();
        let room_id = room_id.clone();
        let token = alice_token.clone();
        async move {
            client
                .get(format!(
                    "{}/api/rooms/{}/search?q=needle&filter=all&limit=3&offset={}",
                    base_url, room_id, offset
                ))
                .header("authorization", bearer(&token))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };

    let page_one = search_page(0).await;
    assert_eq!(page_one["results"].as_array().unwrap().len(), 3);
    assert_eq!(page_one["has_more"], true);
    assert_eq!(page_one["next_offset"], 3);

    let page_two = search_page(3).await;
    assert_eq!(page_two["results"].as_array().unwrap().len(), 2);
    assert_eq!(page_two["has_more"], false);

    // The two pages must not overlap.
    let ids_one: Vec<&str> = page_one["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["event_id"].as_str().unwrap())
        .collect();
    for msg in page_two["results"].as_array().unwrap() {
        assert!(!ids_one.contains(&msg["event_id"].as_str().unwrap()));
    }
}

#[tokio::test]
async fn permission_contract_custom_roles_are_enforced() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_owner_id, owner_token) = register_user(&client, &server.base_url, "owner", "pw").await;
    let (member_id, member_token) = register_user(&client, &server.base_url, "member", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &owner_token,
        "Perms",
        Some(vec![member_id.clone()]),
        false,
    )
    .await;

    // A plain member starts with the baseline: can send, cannot moderate.
    let baseline: Value = client
        .get(format!(
            "{}/api/rooms/{}/permissions",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&member_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(baseline["permissions"]["send_messages"], true);
    assert_eq!(baseline["permissions"]["connect"], true);
    assert_eq!(baseline["permissions"]["kick_members"], false);
    assert_eq!(baseline["permissions"]["manage_roles"], false);

    // The owner holds everything.
    let owner_perms: Value = client
        .get(format!(
            "{}/api/rooms/{}/permissions",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&owner_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(owner_perms["permissions"]["kick_members"], true);
    assert_eq!(owner_perms["permissions"]["manage_roles"], true);

    // Without kick_members the member cannot kick, even though they are in the room.
    let kick_denied = client
        .delete(format!(
            "{}/api/rooms/{}/members/{}",
            server.base_url, room_id, "@owner:localhost"
        ))
        .header("authorization", bearer(&member_token))
        .send()
        .await
        .unwrap();
    assert_eq!(kick_denied.status(), StatusCode::FORBIDDEN);

    // A role that switches everything off is a working mute.
    let muted_role: Value = client
        .post(format!("{}/api/rooms/{}/roles", server.base_url, room_id))
        .header("authorization", bearer(&owner_token))
        .json(&json!({
            "name": "Muted",
            "permissions": {
                "send_messages": false,
                "attach_files": false,
                "embed_links": false,
                "add_reactions": false,
                "connect": false,
                "speak": false
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let role_id = muted_role["role_id"].as_str().unwrap().to_string();

    let assign = client
        .put(format!(
            "{}/api/rooms/{}/members/{}/custom-roles",
            server.base_url, room_id, member_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "role_ids": [role_id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(assign.status(), StatusCode::OK);

    let muted: Value = client
        .get(format!(
            "{}/api/rooms/{}/permissions",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&member_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(muted["permissions"]["send_messages"], false);
    assert_eq!(muted["permissions"]["add_reactions"], false);
    assert_eq!(muted["permissions"]["connect"], false);

    // And the server actually refuses the message, not just the button.
    let send_denied = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.room.message/perm-txn1",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&member_token))
        .json(&json!({"msgtype": "m.text", "body": "should not land"}))
        .send()
        .await
        .unwrap();
    assert_eq!(send_denied.status(), StatusCode::FORBIDDEN);

    // The owner is unaffected by the muted role existing.
    let owner_send = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.room.message/perm-txn2",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({"msgtype": "m.text", "body": "owner still speaks"}))
        .send()
        .await
        .unwrap();
    assert_eq!(owner_send.status(), StatusCode::OK);
    let event_id = owner_send.json::<Value>().await.unwrap()["event_id"]
        .as_str()
        .unwrap()
        .to_string();

    // Reactions are gated too.
    let react_denied = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.reaction/{}",
            server.base_url, room_id, event_id
        ))
        .header("authorization", bearer(&member_token))
        .json(&json!({"emoji": "👍"}))
        .send()
        .await
        .unwrap();
    assert_eq!(react_denied.status(), StatusCode::FORBIDDEN);

    // Granting a permission through a second role unions with the first.
    let mod_role: Value = client
        .post(format!("{}/api/rooms/{}/roles", server.base_url, room_id))
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "name": "Helper", "permissions": { "kick_members": true } }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mod_role_id = mod_role["role_id"].as_str().unwrap().to_string();

    let assign_both = client
        .put(format!(
            "{}/api/rooms/{}/members/{}/custom-roles",
            server.base_url, room_id, member_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "role_ids": [role_id, mod_role_id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(assign_both.status(), StatusCode::OK);

    let unioned: Value = client
        .get(format!(
            "{}/api/rooms/{}/permissions",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&member_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(unioned["permissions"]["kick_members"], true);
    // The Helper role leaves send_messages at its default of true, so the union
    // restores it — roles grant, they do not stack denials.
    assert_eq!(unioned["permissions"]["send_messages"], true);
}

#[tokio::test]
async fn channel_overwrite_contract_denies_allows_and_precedence() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_owner_id, owner_token) = register_user(&client, &server.base_url, "owner", "pw").await;
    let (member_id, member_token) = register_user(&client, &server.base_url, "member", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &owner_token,
        "Overwrites",
        Some(vec![member_id.clone()]),
        false,
    )
    .await;

    let channels: Value = client
        .get(format!(
            "{}/api/rooms/{}/channels",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&owner_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let channel_id = channels["channels"][0]["channel_id"]
        .as_str()
        .unwrap()
        .to_string();

    let perms_in_channel = |token: String, channel: String| {
        let client = client.clone();
        let base_url = server.base_url.clone();
        let room_id = room_id.clone();
        async move {
            client
                .get(format!(
                    "{}/api/rooms/{}/permissions?channel_id={}",
                    base_url, room_id, channel
                ))
                .header("authorization", bearer(&token))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()["permissions"]
                .clone()
        }
    };

    // Baseline: the member can post in the channel.
    let before = perms_in_channel(member_token.clone(), channel_id.clone()).await;
    assert_eq!(before["send_messages"], true);
    assert_eq!(before["view_channel"], true);

    // Deny send_messages to everyone in this channel.
    let set_everyone_deny = client
        .put(format!(
            "{}/api/rooms/{}/channels/{}",
            server.base_url, room_id, channel_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({
            "overwrites": [
                { "target_type": "everyone", "target_id": "", "allow": [], "deny": ["send_messages"] }
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(set_everyone_deny.status(), StatusCode::OK);

    let denied = perms_in_channel(member_token.clone(), channel_id.clone()).await;
    assert_eq!(denied["send_messages"], false);

    // The server refuses the message, not just the button.
    let send_denied = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.room.message/ow-txn1",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&member_token))
        .json(&json!({"msgtype": "m.text", "body": "blocked", "channel_id": channel_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(send_denied.status(), StatusCode::FORBIDDEN);

    // The owner bypasses overwrites entirely.
    let owner_perms = perms_in_channel(owner_token.clone(), channel_id.clone()).await;
    assert_eq!(owner_perms["send_messages"], true);

    // A user-specific allow beats the everyone deny — precedence is
    // everyone, then roles, then the member.
    let add_user_allow = client
        .put(format!(
            "{}/api/rooms/{}/channels/{}",
            server.base_url, room_id, channel_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({
            "overwrites": [
                { "target_type": "everyone", "target_id": "", "allow": [], "deny": ["send_messages"] },
                { "target_type": "user", "target_id": member_id, "allow": ["send_messages"], "deny": [] }
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(add_user_allow.status(), StatusCode::OK);

    let restored = perms_in_channel(member_token.clone(), channel_id.clone()).await;
    assert_eq!(restored["send_messages"], true);

    let send_allowed = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.room.message/ow-txn2",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&member_token))
        .json(&json!({"msgtype": "m.text", "body": "allowed again", "channel_id": channel_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(send_allowed.status(), StatusCode::OK);

    // Denying view_channel hides it from the channel listing.
    let hide = client
        .put(format!(
            "{}/api/rooms/{}/channels/{}",
            server.base_url, room_id, channel_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({
            "overwrites": [
                { "target_type": "everyone", "target_id": "", "allow": [], "deny": ["view_channel"] }
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(hide.status(), StatusCode::OK);

    let visible: Value = client
        .get(format!(
            "{}/api/rooms/{}/channels",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&member_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        !visible["channels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["channel_id"].as_str() == Some(channel_id.as_str())),
        "a channel denying view_channel must not appear in the member's listing"
    );

    // An unknown permission name is rejected rather than silently stored.
    let bad = client
        .put(format!(
            "{}/api/rooms/{}/channels/{}",
            server.base_url, room_id, channel_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({
            "overwrites": [
                { "target_type": "everyone", "target_id": "", "allow": ["fly"], "deny": [] }
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn role_hierarchy_contract_blocks_self_escalation() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_owner_id, owner_token) = register_user(&client, &server.base_url, "owner", "pw").await;
    let (member_id, member_token) = register_user(&client, &server.base_url, "member", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &owner_token,
        "Hierarchy",
        Some(vec![member_id.clone()]),
        false,
    )
    .await;

    let make_role = |name: &'static str, perms: Value| {
        let client = client.clone();
        let base_url = server.base_url.clone();
        let room_id = room_id.clone();
        let token = owner_token.clone();
        async move {
            client
                .post(format!("{}/api/rooms/{}/roles", base_url, room_id))
                .header("authorization", bearer(&token))
                .json(&json!({ "name": name, "permissions": perms }))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()["role_id"]
                .as_str()
                .unwrap()
                .to_string()
        }
    };

    // Created first, so it sits at position 0 — the strongest custom role.
    let senior = make_role("Senior", json!({ "ban_members": true })).await;
    // Created second: position 1, weaker, and holds manage_roles.
    let junior = make_role("Junior", json!({ "manage_roles": true })).await;

    let assign = client
        .put(format!(
            "{}/api/rooms/{}/members/{}/custom-roles",
            server.base_url, room_id, member_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "role_ids": [junior] }))
        .send()
        .await
        .unwrap();
    assert_eq!(assign.status(), StatusCode::OK);

    // manage_roles must not become a route to every other permission:
    // the holder cannot grant themselves something they do not hold.
    let escalate = client
        .post(format!("{}/api/rooms/{}/roles", server.base_url, room_id))
        .header("authorization", bearer(&member_token))
        .json(&json!({ "name": "Sneaky", "permissions": { "ban_members": true } }))
        .send()
        .await
        .unwrap();
    assert_eq!(escalate.status(), StatusCode::FORBIDDEN);

    // Nor edit a role above their own.
    let edit_senior = client
        .put(format!(
            "{}/api/rooms/{}/roles/{}",
            server.base_url, room_id, senior
        ))
        .header("authorization", bearer(&member_token))
        .json(&json!({ "name": "Hijacked" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit_senior.status(), StatusCode::FORBIDDEN);

    // Nor delete it.
    let delete_senior = client
        .delete(format!(
            "{}/api/rooms/{}/roles/{}",
            server.base_url, room_id, senior
        ))
        .header("authorization", bearer(&member_token))
        .send()
        .await
        .unwrap();
    assert_eq!(delete_senior.status(), StatusCode::FORBIDDEN);

    // Nor assign it to themselves.
    let grab_senior = client
        .put(format!(
            "{}/api/rooms/{}/members/{}/custom-roles",
            server.base_url, room_id, member_id
        ))
        .header("authorization", bearer(&member_token))
        .json(&json!({ "role_ids": [senior] }))
        .send()
        .await
        .unwrap();
    assert_eq!(grab_senior.status(), StatusCode::FORBIDDEN);

    // The owner outranks everything and is unaffected.
    let owner_edit = client
        .put(format!(
            "{}/api/rooms/{}/roles/{}",
            server.base_url, room_id, senior
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "name": "Senior Staff" }))
        .send()
        .await
        .unwrap();
    assert_eq!(owner_edit.status(), StatusCode::OK);
}

#[tokio::test]
async fn category_permissions_are_inherited_until_a_channel_opts_out() {
    let server = spawn_server().await;
    let client = Client::new();

    let (_owner_id, owner_token) = register_user(&client, &server.base_url, "owner", "pw").await;
    let (member_id, member_token) = register_user(&client, &server.base_url, "member", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &owner_token,
        "Categories",
        Some(vec![member_id.clone()]),
        false,
    )
    .await;

    let category_id = client
        .post(format!(
            "{}/api/rooms/{}/categories",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "name": "Staff" }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["category_id"]
        .as_str()
        .unwrap()
        .to_string();

    let channel_id = client
        .post(format!(
            "{}/api/rooms/{}/channels",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({
            "name": "staff-chat",
            "channel_type": "text",
            "category_id": category_id
        }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["channel_id"]
        .as_str()
        .unwrap()
        .to_string();

    let perms = |token: String, channel: String| {
        let client = client.clone();
        let base_url = server.base_url.clone();
        let room_id = room_id.clone();
        async move {
            client
                .get(format!(
                    "{}/api/rooms/{}/permissions?channel_id={}",
                    base_url, room_id, channel
                ))
                .header("authorization", bearer(&token))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()["permissions"]
                .clone()
        }
    };

    assert_eq!(
        perms(member_token.clone(), channel_id.clone()).await["send_messages"],
        true
    );

    // Deny on the category, and the channel inherits it.
    let deny_on_category = client
        .put(format!(
            "{}/api/rooms/{}/categories/{}",
            server.base_url, room_id, category_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({
            "overwrites": [
                { "target_type": "everyone", "target_id": "", "allow": [], "deny": ["send_messages"] }
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(deny_on_category.status(), StatusCode::OK);

    assert_eq!(
        perms(member_token.clone(), channel_id.clone()).await["send_messages"],
        false,
        "a channel should inherit its category's overwrites"
    );

    // The channel's own overwrite refines what it inherits.
    let allow_on_channel = client
        .put(format!(
            "{}/api/rooms/{}/channels/{}",
            server.base_url, room_id, channel_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({
            "overwrites": [
                { "target_type": "user", "target_id": member_id, "allow": ["send_messages"], "deny": [] }
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(allow_on_channel.status(), StatusCode::OK);

    assert_eq!(
        perms(member_token.clone(), channel_id.clone()).await["send_messages"],
        true,
        "the channel's own overwrite should win over the inherited one"
    );

    // Opting out drops the category rules entirely.
    let opt_out = client
        .put(format!(
            "{}/api/rooms/{}/channels/{}",
            server.base_url, room_id, channel_id
        ))
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "inherit_category_permissions": false, "overwrites": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(opt_out.status(), StatusCode::OK);

    assert_eq!(
        perms(member_token.clone(), channel_id.clone()).await["send_messages"],
        true,
        "opting out should ignore the category's deny"
    );

    // "View as" resolves for a role without assigning it to anyone.
    let role_id = client
        .post(format!("{}/api/rooms/{}/roles", server.base_url, room_id))
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "name": "Guest", "permissions": { "send_messages": false } }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["role_id"]
        .as_str()
        .unwrap()
        .to_string();

    let as_role: Value = client
        .get(format!(
            "{}/api/rooms/{}/permissions?channel_id={}&as_role={}",
            server.base_url, room_id, channel_id, role_id
        ))
        .header("authorization", bearer(&owner_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(as_role["permissions"]["send_messages"], false);

    // Inspecting someone else's access is itself gated.
    let peeking = client
        .get(format!(
            "{}/api/rooms/{}/permissions?as_user={}",
            server.base_url, room_id, "@owner:localhost"
        ))
        .header("authorization", bearer(&member_token))
        .send()
        .await
        .unwrap();
    assert_eq!(peeking.status(), StatusCode::FORBIDDEN);
}
