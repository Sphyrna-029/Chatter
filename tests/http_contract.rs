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

/// The member list a room switch reads, which used to be carved out of a full
/// `/sync`. Its shape is what the client renders the roster from, and it must
/// stay closed to anyone outside the room.
#[tokio::test]
async fn room_members_contract_shape_and_membership_gate() {
    let server = spawn_server().await;
    let client = Client::new();

    let (alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;
    let (bob_user_id, bob_token) = register_user(&client, &server.base_url, "bob", "pw").await;
    let (_carol_user_id, carol_token) =
        register_user(&client, &server.base_url, "carol", "pw").await;

    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "General",
        Some(vec![bob_user_id.clone()]),
        false,
    )
    .await;

    let members = client
        .get(format!("{}/api/rooms/{}/members", server.base_url, room_id))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(members.status(), StatusCode::OK);
    let body: Value = members.json().await.unwrap();
    assert_eq!(body["room_id"].as_str(), Some(room_id.as_str()));

    let listed = body["members"].as_array().unwrap();
    assert_eq!(listed.len(), 2);

    let alice = listed
        .iter()
        .find(|m| m["user_id"].as_str() == Some(alice_user_id.as_str()))
        .expect("the creator is in the list");
    // The creator is the owner, and a display name is always present: a member
    // with none set falls back to the local part of their id rather than
    // rendering as an empty row.
    assert_eq!(alice["role"].as_str(), Some("owner"));
    assert_eq!(alice["display_name"].as_str(), Some("alice"));

    let bob = listed
        .iter()
        .find(|m| m["user_id"].as_str() == Some(bob_user_id.as_str()))
        .expect("the invitee is in the list");
    assert_eq!(bob["role"].as_str(), Some("member"));

    // Bob is in the room and sees the same list.
    let bob_view = client
        .get(format!("{}/api/rooms/{}/members", server.base_url, room_id))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(bob_view.status(), StatusCode::OK);

    // Carol is not, and a member list names everyone in the room.
    let carol_view = client
        .get(format!("{}/api/rooms/{}/members", server.base_url, room_id))
        .header("authorization", bearer(&carol_token))
        .send()
        .await
        .unwrap();
    assert_eq!(carol_view.status(), StatusCode::FORBIDDEN);

    let anonymous = client
        .get(format!("{}/api/rooms/{}/members", server.base_url, room_id))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
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

#[tokio::test]
async fn appearance_contract_round_trip_and_validation() {
    let server = spawn_server().await;
    let client = Client::new();
    let (_, token) = register_user(&client, &server.base_url, "painter", "pw").await;

    // An account that has never saved answers with nulls, not a 404: "nothing
    // stored" is the normal first-visit state.
    let empty: Value = client
        .get(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(empty["theme_id"].is_null());
    assert!(empty["custom_themes"].is_null());
    assert!(empty["display"].is_null());

    let settings = json!({
        "theme_id": "custom-abc123",
        "custom_themes": [{
            "id": "custom-abc123",
            "name": "Parchment",
            "mode": "light",
            "colors": {
                "background": "#FDFAF6",
                "card": "#f1ece4",
                "accent": "#c2410c",
                "primary": "#1c1917",
            },
            "advanced": { "sidebar": "#EEE8E0", "borderStrength": 0.55 },
        }],
        "display": {
            "font_scale": 1.15,
            "radius": 0.25,
            "density": "compact",
            "motion": "reduce",
        },
    });

    let saved = client
        .put(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .json(&settings)
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);

    let stored: Value = client
        .get(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stored["theme_id"], "custom-abc123");
    assert_eq!(stored["display"]["font_scale"], 1.15);
    assert_eq!(stored["display"]["density"], "compact");
    assert_eq!(stored["custom_themes"][0]["name"], "Parchment");
    assert_eq!(stored["custom_themes"][0]["mode"], "light");
    // Colours are stored lowercased so two spellings of one theme compare equal.
    assert_eq!(
        stored["custom_themes"][0]["colors"]["background"],
        "#fdfaf6"
    );
    assert_eq!(stored["custom_themes"][0]["advanced"]["sidebar"], "#eee8e0");
    assert_eq!(
        stored["custom_themes"][0]["advanced"]["borderStrength"],
        0.55
    );
    // An override that was not set stays unset rather than being stored at its
    // derived value, so a later change to the derivation still reaches it.
    assert!(stored["custom_themes"][0]["advanced"]["mention"].is_null());

    // Overrides are colours too, and are checked the same way.
    let bad_override = client
        .put(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .json(&json!({
            "theme_id": "dark",
            "custom_themes": [{
                "id": "custom-xyz",
                "name": "Bad",
                "mode": "dark",
                "colors": {
                    "background": "#111111", "card": "#222222",
                    "accent": "#333333", "primary": "#eeeeee",
                },
                "advanced": { "mention": "red" },
            }],
            "display": {
                "font_scale": 1.0, "radius": 0.875,
                "density": "comfortable", "motion": "system",
            },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_override.status(), StatusCode::BAD_REQUEST);

    let bad_strength = client
        .put(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .json(&json!({
            "theme_id": "dark",
            "custom_themes": [{
                "id": "custom-xyz",
                "name": "Bad",
                "mode": "dark",
                "colors": {
                    "background": "#111111", "card": "#222222",
                    "accent": "#333333", "primary": "#eeeeee",
                },
                "advanced": { "borderStrength": 5.0 },
            }],
            "display": {
                "font_scale": 1.0, "radius": 0.875,
                "density": "comfortable", "motion": "system",
            },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_strength.status(), StatusCode::BAD_REQUEST);

    // A theme id is interpolated into a CSS attribute selector by the client,
    // so anything that could end that string is refused here too.
    let injected = client
        .put(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .json(&json!({
            "theme_id": "x\"] { display: none } html[data-theme=\"x",
            "custom_themes": [],
            "display": {
                "font_scale": 1.0, "radius": 0.875,
                "density": "comfortable", "motion": "system",
            },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(injected.status(), StatusCode::BAD_REQUEST);

    // Colours become custom properties, so they are constrained to hex.
    let bad_colour = client
        .put(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .json(&json!({
            "theme_id": "dark",
            "custom_themes": [{
                "id": "custom-xyz",
                "name": "Bad",
                "mode": "dark",
                "colors": {
                    "background": "url(https://example.com)",
                    "card": "#111111",
                    "accent": "#222222",
                    "primary": "#eeeeee",
                },
            }],
            "display": {
                "font_scale": 1.0, "radius": 0.875,
                "density": "comfortable", "motion": "system",
            },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_colour.status(), StatusCode::BAD_REQUEST);

    let bad_display = client
        .put(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .json(&json!({
            "theme_id": "dark",
            "custom_themes": [],
            "display": {
                "font_scale": 40.0, "radius": 0.875,
                "density": "comfortable", "motion": "system",
            },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_display.status(), StatusCode::BAD_REQUEST);

    // A rejected write leaves what was already stored alone.
    let unchanged: Value = client
        .get(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(unchanged["theme_id"], "custom-abc123");

    // Appearance is per-user and nobody else's business.
    let anonymous = client
        .get(format!("{}/api/appearance", server.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);

    let (_, other_token) = register_user(&client, &server.base_url, "stranger", "pw").await;
    let theirs: Value = client
        .get(format!("{}/api/appearance", server.base_url))
        .header("authorization", bearer(&other_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(theirs["theme_id"].is_null());
}

#[tokio::test]
async fn room_suggested_theme_contract() {
    let server = spawn_server().await;
    let client = Client::new();
    let (_, owner_token) = register_user(&client, &server.base_url, "host", "pw").await;
    let (_, member_token) = register_user(&client, &server.base_url, "guest", "pw").await;
    let room_id = create_room(
        &client,
        &server.base_url,
        &owner_token,
        "Study",
        None,
        false,
    )
    .await;

    let settings_url = format!(
        "{}/_matrix/client/r0/rooms/{}/state/m.room.settings",
        server.base_url, room_id
    );
    let code = "ct1_WyJQYXJjaG1lbnQiLCJsaWdodCIsImZkZmFmNiIsImYxZWNlNCIsImMyNDEwYyIsIjFjMTkxNyJd";

    let set = client
        .put(&settings_url)
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "suggested_theme": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(set.status(), StatusCode::OK);

    // The suggestion reaches members through room state, like the sound pack.
    let sync: Value = client
        .get(format!("{}/_matrix/client/r0/sync", server.base_url))
        .header("authorization", bearer(&owner_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = sync["rooms"]["join"][&room_id]["state"]["events"]
        .as_array()
        .unwrap();
    let theme_event = events
        .iter()
        .find(|e| e["type"] == "m.room.theme")
        .expect("room state carries m.room.theme");
    assert_eq!(theme_event["content"]["suggested_theme"], code);

    // Shape is checked even though the payload is opaque here: an unbounded
    // string would be broadcast to every member of the room.
    for bad in ["not-a-code", "ct1_has spaces", "ct2_WyJQIl0"] {
        let rejected = client
            .put(&settings_url)
            .header("authorization", bearer(&owner_token))
            .json(&json!({ "suggested_theme": bad }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            rejected.status(),
            StatusCode::BAD_REQUEST,
            "expected {bad} to be refused"
        );
    }

    let too_long = format!("ct1_{}", "a".repeat(600));
    let rejected = client
        .put(&settings_url)
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "suggested_theme": too_long }))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);

    // Suggesting a theme is a room setting, so it needs the permission that
    // covers room settings — a member cannot repaint everyone else's app.
    client
        .post(format!(
            "{}/_matrix/client/r0/rooms/{}/join",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&member_token))
        .send()
        .await
        .unwrap();
    let forbidden = client
        .put(&settings_url)
        .header("authorization", bearer(&member_token))
        .json(&json!({ "suggested_theme": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    // Clearing is an empty string, not a separate route.
    let cleared = client
        .put(&settings_url)
        .header("authorization", bearer(&owner_token))
        .json(&json!({ "suggested_theme": "" }))
        .send()
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);

    let after: Value = client
        .get(format!("{}/_matrix/client/r0/sync", server.base_url))
        .header("authorization", bearer(&owner_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let theme_event = after["rooms"]["join"][&room_id]["state"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["type"] == "m.room.theme")
        .unwrap();
    assert_eq!(theme_event["content"]["suggested_theme"], "");
}

#[tokio::test]
async fn a_deleted_thread_reply_stops_being_counted() {
    // A redaction keeps the row and marks it, so everything that counted
    // replies counted the deleted ones too — and the stored count on the
    // thread record had never had anything taken off it at all. A thread that
    // had had two replies and lost one went on advertising two, in the badge
    // on its root message and in the thread list.
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;
    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "Threads",
        None,
        false,
    )
    .await;

    let send = |body: &str| {
        let client = client.clone();
        let base = server.base_url.clone();
        let token = alice_token.clone();
        let room = room_id.clone();
        let body = body.to_string();
        async move {
            let txn = format!("t{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0));
            let res = client
                .put(format!(
                    "{base}/_matrix/client/r0/rooms/{room}/send/m.room.message/{txn}"
                ))
                .header("authorization", bearer(&token))
                .json(&json!({"msgtype": "m.text", "body": body}))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::OK);
            let value: Value = res.json().await.unwrap();
            value["event_id"].as_str().unwrap().to_string()
        }
    };

    let root_id = send("the root").await;

    let reply = |body: &str, root: String| {
        let client = client.clone();
        let base = server.base_url.clone();
        let token = alice_token.clone();
        let room = room_id.clone();
        let body = body.to_string();
        async move {
            let txn = format!("r{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0));
            let res = client
                .put(format!("{base}/api/rooms/{room}/threads/{root}/{txn}"))
                .header("authorization", bearer(&token))
                .json(&json!({"msgtype": "m.text", "body": body}))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::OK);
            let value: Value = res.json().await.unwrap();
            value["event_id"].as_str().unwrap().to_string()
        }
    };

    let first_reply = reply("one", root_id.clone()).await;
    let _second_reply = reply("two", root_id.clone()).await;

    let listed_count = |token: String| {
        let client = client.clone();
        let base = server.base_url.clone();
        let room = room_id.clone();
        let root = root_id.clone();
        async move {
            let res = client
                .get(format!("{base}/api/rooms/{room}/threads"))
                .header("authorization", bearer(&token))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::OK);
            let body: Value = res.json().await.unwrap();
            body["threads"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["event_id"] == root.as_str())
                .expect("the thread is listed")["thread_reply_count"]
                .as_i64()
                .unwrap()
        }
    };

    assert_eq!(listed_count(alice_token.clone()).await, 2);

    let deleted = client
        .delete(format!(
            "{}/_matrix/client/r0/rooms/{}/redact/{}/d1",
            server.base_url, room_id, first_reply
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);

    // The stored count the thread list reads.
    assert_eq!(listed_count(alice_token.clone()).await, 1);

    // And the live count the badge on the root message is drawn from, which is
    // computed separately and has to agree with it.
    let messages = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{}/messages",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    let body: Value = messages.json().await.unwrap();
    let root = body["chunk"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["event_id"] == root_id.as_str())
        .expect("the root message is in the timeline");
    assert_eq!(root["thread_reply_count"], 1);
}

#[tokio::test]
async fn chunked_upload_reports_what_it_holds_and_can_be_abandoned_on_purpose() {
    // An interrupted upload used to be unfinishable: the chunks it had already
    // sent sat in a staging dir addressed by an id nothing could ask about, so
    // the only way forward was to send the whole file again and leave the old
    // dir for the sweeper. `GET` answers what is already there; `DELETE` gives
    // a cancelled upload a way out that is not a 24-hour wait.
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;
    let (_bob_user_id, bob_token) = register_user(&client, &server.base_url, "bob", "pw").await;

    let payload = vec![b'q'; 100];
    let init = client
        .post(format!("{}/api/upload/init", server.base_url))
        .header("authorization", bearer(&alice_token))
        .json(&json!({"filename": "resume.bin", "fileSize": payload.len()}))
        .send()
        .await
        .unwrap();
    assert_eq!(init.status(), StatusCode::OK);
    let init_body: Value = init.json().await.unwrap();
    let upload_id = init_body["uploadId"].as_str().unwrap().to_string();

    let status_url = format!("{}/api/upload/{}", server.base_url, upload_id);
    let status_of = |token: String| {
        let client = client.clone();
        let status_url = status_url.clone();
        async move {
            client
                .get(&status_url)
                .header("authorization", bearer(&token))
                .send()
                .await
                .unwrap()
        }
    };

    // Nothing sent yet, but the file's shape is already known.
    let fresh = status_of(alice_token.clone()).await;
    assert_eq!(fresh.status(), StatusCode::OK);
    let fresh_body: Value = fresh.json().await.unwrap();
    assert_eq!(fresh_body["fileSize"], 100);
    assert_eq!(fresh_body["chunkCount"], 1);
    assert_eq!(fresh_body["filename"], "resume.bin");
    assert_eq!(fresh_body["received"].as_array().unwrap().len(), 0);
    assert_eq!(fresh_body["receivedBytes"], 0);
    assert!(fresh_body["chunkSize"].as_u64().unwrap() > 0);

    // A chunk file that is the wrong length is a torn write, not an arrival.
    // Reported as received it would be skipped on resume and concatenated into
    // a corrupt file — the one thing this endpoint must not get wrong.
    let chunk_path = format!("external/.chunks/{upload_id}/0");
    std::fs::write(&chunk_path, &payload[..50]).unwrap();
    let torn = status_of(alice_token.clone()).await;
    let torn_body: Value = torn.json().await.unwrap();
    assert_eq!(torn_body["received"].as_array().unwrap().len(), 0);
    std::fs::remove_file(&chunk_path).unwrap();

    // The real chunk, through the API, is.
    let form = multipart::Form::new()
        .text("uploadId", upload_id.clone())
        .text("chunkIndex", "0")
        .part(
            "file",
            multipart::Part::bytes(payload.clone()).file_name("resume.bin"),
        );
    let accepted = client
        .post(format!("{}/api/upload/chunk", server.base_url))
        .header("authorization", bearer(&alice_token))
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);

    let landed = status_of(alice_token.clone()).await;
    let landed_body: Value = landed.json().await.unwrap();
    assert_eq!(landed_body["received"], json!([0]));
    assert_eq!(landed_body["receivedBytes"], 100);

    // Someone else's upload is not readable, abortable, or even confirmable.
    assert_eq!(
        status_of(bob_token.clone()).await.status(),
        StatusCode::FORBIDDEN
    );
    let bob_abort = client
        .delete(&status_url)
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(bob_abort.status(), StatusCode::FORBIDDEN);
    assert!(std::path::Path::new(&format!("external/.chunks/{upload_id}")).exists());

    let unknown = client
        .get(format!("{}/api/upload/{}", server.base_url, "f".repeat(32)))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

    // An id that could never have been minted is refused before it reaches a
    // path — 32 hex characters cannot hold a separator or a `..`.
    let malformed = client
        .get(format!("{}/api/upload/not-an-id", server.base_url))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);

    // Cancelling takes the staging dir now rather than in 24 hours, and says
    // the same thing the second time so a client can retry it blind.
    for _ in 0..2 {
        let aborted = client
            .delete(&status_url)
            .header("authorization", bearer(&alice_token))
            .send()
            .await
            .unwrap();
        assert_eq!(aborted.status(), StatusCode::OK);
        let aborted_body: Value = aborted.json().await.unwrap();
        assert_eq!(aborted_body["aborted"], true);
    }
    assert!(!std::path::Path::new(&format!("external/.chunks/{upload_id}")).exists());

    // An upload that is gone reads as one that never was: a resuming client
    // starts over in both cases.
    assert_eq!(status_of(alice_token).await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn chunked_upload_verifies_each_chunk_before_assembling() {
    // Nothing used to look at a chunk's contents at all: `upload_chunk` wrote
    // whatever arrived, and `upload_complete` asked only whether each chunk
    // file *existed* before concatenating them. A short chunk — a proxy cutting
    // a request, or a client slicing to a different chunk size than this server
    // assembles with — became a corrupt stretch of the finished file and was
    // reported as a successful upload.
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "alice", "pw").await;

    // Small enough to be a single chunk, so the whole file is the remainder
    // case: `min(CHUNK_SIZE, file_size - offset)`.
    let payload = vec![b'z'; 100];
    let init = client
        .post(format!("{}/api/upload/init", server.base_url))
        .header("authorization", bearer(&alice_token))
        .json(&json!({"filename": "parts.bin", "fileSize": payload.len()}))
        .send()
        .await
        .unwrap();
    assert_eq!(init.status(), StatusCode::OK);
    let init_body: Value = init.json().await.unwrap();
    let upload_id = init_body["uploadId"].as_str().unwrap().to_string();
    assert!(init_body["chunkSize"].as_u64().unwrap() > 0);

    let chunk_url = format!("{}/api/upload/chunk", server.base_url);
    let checksum = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(&payload))
    };

    // A chunk that is not the length this index must be is refused.
    let truncated = multipart::Form::new()
        .text("uploadId", upload_id.clone())
        .text("chunkIndex", "0")
        .part(
            "file",
            multipart::Part::bytes(payload[..50].to_vec()).file_name("parts.bin"),
        );
    let short_chunk = client
        .post(&chunk_url)
        .header("authorization", bearer(&alice_token))
        .multipart(truncated)
        .send()
        .await
        .unwrap();
    assert_eq!(short_chunk.status(), StatusCode::BAD_REQUEST);
    let short_body: Value = short_chunk.json().await.unwrap();
    assert_eq!(short_body["error"], "Chunk 0 is 50 bytes, expected 100");

    // The right length carrying the wrong bytes is refused too, when the
    // client was able to hash it.
    let corrupted = multipart::Form::new()
        .text("uploadId", upload_id.clone())
        .text("chunkIndex", "0")
        .text("checksum", "0".repeat(64))
        .part(
            "file",
            multipart::Part::bytes(payload.clone()).file_name("parts.bin"),
        );
    let bad_checksum = client
        .post(&chunk_url)
        .header("authorization", bearer(&alice_token))
        .multipart(corrupted)
        .send()
        .await
        .unwrap();
    assert_eq!(bad_checksum.status(), StatusCode::BAD_REQUEST);
    let bad_body: Value = bad_checksum.json().await.unwrap();
    assert_eq!(bad_body["error"], "Chunk 0 failed its checksum");

    // And the real thing goes through.
    let good = multipart::Form::new()
        .text("uploadId", upload_id.clone())
        .text("chunkIndex", "0")
        .text("checksum", checksum)
        .part(
            "file",
            multipart::Part::bytes(payload.clone()).file_name("parts.bin"),
        );
    let accepted = client
        .post(&chunk_url)
        .header("authorization", bearer(&alice_token))
        .multipart(good)
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);

    let complete = client
        .post(format!("{}/api/upload/complete", server.base_url))
        .header("authorization", bearer(&alice_token))
        .json(&json!({"uploadId": upload_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    let complete_body: Value = complete.json().await.unwrap();
    let url = complete_body["url"].as_str().unwrap().to_string();

    // The assembled file is the size that was declared at init — the check
    // that makes a lost or duplicated whole chunk a failure rather than a 200.
    // The URL is absolute, so the disk path is what follows `/external/`.
    let rel = url
        .split("/external/")
        .nth(1)
        .expect("an upload url points into /external/");
    let local_path = format!("external/{rel}");
    let assembled = std::fs::read(&local_path).expect("the assembled file should be on disk");
    assert_eq!(assembled, payload);

    // The chunks are gone, but the staging dir stays: it now holds the answer.
    let staging = format!("external/.chunks/{upload_id}");
    assert!(std::path::Path::new(&staging).exists());
    assert!(!std::path::Path::new(&format!("{staging}/0")).exists());

    // Asking again gets the same URL rather than a second assembly. A remux
    // can run past the client's wait on `complete`, and a client that gave up
    // used to have no way to learn the URL of a file already finished on disk
    // — so it uploaded the whole thing again and left the first one behind
    // with nothing referring to it.
    let again = client
        .post(format!("{}/api/upload/complete", server.base_url))
        .header("authorization", bearer(&alice_token))
        .json(&json!({"uploadId": upload_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), StatusCode::OK);
    let again_body: Value = again.json().await.unwrap();
    assert_eq!(again_body["url"], url);

    // And a client resuming one of these is told to stop rather than to send
    // every chunk again into a dir that is only waiting to be swept.
    let status = client
        .get(format!("{}/api/upload/{}", server.base_url, upload_id))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    let status_body: Value = status.json().await.unwrap();
    assert_eq!(status_body["status"], "done");
    assert_eq!(status_body["resultUrl"], url);

    // Leave nothing behind: `external/` is a tracked directory.
    if let Some(dir) = std::path::Path::new(&local_path).parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_dir_all(&staging);
}

#[tokio::test]
async fn poll_contract_vote_change_withdraw_and_close_posts_results() {
    // A poll is a message with a record behind it. This walks the whole life
    // of one: the message it posts, a vote, a vote changed, a vote withdrawn,
    // and the results message that lands in the same channel when it ends.
    let server = spawn_server().await;
    let client = Client::new();

    let (alice_id, alice_token) = register_user(&client, &server.base_url, "alice", "pw").await;
    let (bob_id, bob_token) = register_user(&client, &server.base_url, "bob", "pw").await;
    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "Polls",
        None,
        false,
    )
    .await;
    let join = client
        .post(format!(
            "{}/_matrix/client/r0/rooms/{room_id}/join",
            server.base_url
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(join.status(), StatusCode::OK);

    let created = client
        .post(format!("{}/api/rooms/{room_id}/polls", server.base_url))
        .header("authorization", bearer(&alice_token))
        .json(&json!({
            "question": "Lunch on Friday?",
            "options": ["Tacos", "Ramen", "Salad"],
            "duration_minutes": 1,
            "multi_select": false,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created: Value = created.json().await.unwrap();
    let poll_id = created["event_id"].as_str().unwrap().to_string();
    // Every option has a slot from the start, including the ones nobody has
    // picked — the card draws a bar per option and reads its length from here.
    assert_eq!(created["poll"]["voters"].as_array().unwrap().len(), 3);
    assert_eq!(created["poll"]["total_voters"], 0);
    assert_eq!(created["poll"]["closed"], false);

    // The poll arrives in the timeline as an ordinary message, and its body
    // repeats the question: search, push and the channel preview read that and
    // nothing else.
    let page: Value = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{room_id}/messages?limit=50",
            server.base_url
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let posted = page["chunk"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["event_id"] == poll_id.as_str())
        .expect("the poll is in the timeline");
    assert_eq!(posted["content"]["msgtype"], "m.poll");
    assert!(posted["content"]["body"]
        .as_str()
        .unwrap()
        .contains("Lunch on Friday?"));
    // The page carries the live state, so a channel of polls costs one request
    // rather than one per card.
    assert_eq!(posted["poll"]["total_voters"], 0);

    let vote = |token: String, options: Vec<i64>| {
        let client = client.clone();
        let base = server.base_url.clone();
        let room = room_id.clone();
        let poll = poll_id.clone();
        async move {
            let res = client
                .put(format!("{base}/api/rooms/{room}/polls/{poll}/vote"))
                .header("authorization", bearer(&token))
                .json(&json!({ "options": options }))
                .send()
                .await
                .unwrap();
            let status = res.status();
            let body: Value = res.json().await.unwrap();
            (status, body)
        }
    };

    let (status, body) = vote(bob_token.clone(), vec![0]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["poll"]["voters"][0], json!([bob_id.clone()]));
    assert_eq!(body["poll"]["total_voters"], 1);

    // Changing a vote replaces it rather than adding a second one: the request
    // states the caller's whole selection.
    let (_, body) = vote(bob_token.clone(), vec![1]).await;
    assert_eq!(body["poll"]["voters"][0], json!([]));
    assert_eq!(body["poll"]["voters"][1], json!([bob_id.clone()]));
    assert_eq!(body["poll"]["total_voters"], 1);

    // Two answers on a single-answer poll is a refusal, not a silent truncation.
    let (status, _) = vote(bob_token.clone(), vec![0, 1]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // An answer that is not on the poll is refused too.
    let (status, _) = vote(bob_token.clone(), vec![9]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, body) = vote(alice_token.clone(), vec![1]).await;
    assert_eq!(body["poll"]["total_voters"], 2);

    // An empty selection is how a vote is taken back.
    let (_, body) = vote(alice_token.clone(), vec![]).await;
    assert_eq!(body["poll"]["total_voters"], 1);
    let (_, body) = vote(alice_token.clone(), vec![2]).await;
    assert_eq!(body["poll"]["total_voters"], 2);

    // A poll is minted by its own endpoint. Sent as an ordinary message it
    // would be a card with no record behind it, claiming whatever it liked.
    let forged = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{room_id}/send/m.room.message/forge1",
            server.base_url
        ))
        .header("authorization", bearer(&bob_token))
        .json(&json!({"msgtype": "m.poll", "body": "not a poll"}))
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status(), StatusCode::BAD_REQUEST);

    // Only the author — or someone who can manage messages — ends it early.
    let refused = client
        .post(format!(
            "{}/api/rooms/{room_id}/polls/{poll_id}/close",
            server.base_url
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);

    let closed = client
        .post(format!(
            "{}/api/rooms/{room_id}/polls/{poll_id}/close",
            server.base_url
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(closed.status(), StatusCode::OK);
    let closed: Value = closed.json().await.unwrap();
    assert_eq!(closed["poll"]["closed"], true);

    // Ending it twice is a refusal rather than a second results message.
    let again = client
        .post(format!(
            "{}/api/rooms/{room_id}/polls/{poll_id}/close",
            server.base_url
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), StatusCode::CONFLICT);

    // A closed poll takes no more votes.
    let (status, _) = vote(bob_token.clone(), vec![0]).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // The results are posted into the channel the poll was asked in, and carry
    // the question, the answers and the numbers — it has to read correctly
    // with nothing else loaded, years later, in a search result.
    let page: Value = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{room_id}/messages?limit=50",
            server.base_url
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let results = page["chunk"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["content"]["msgtype"] == "m.poll_results")
        .expect("the results were posted into the channel");
    assert_eq!(results["content"]["poll_id"], poll_id.as_str());
    assert_eq!(results["content"]["question"], "Lunch on Friday?");
    assert_eq!(results["content"]["counts"], json!([0, 1, 1]));
    assert_eq!(results["content"]["total_voters"], 2);
    // Who voted rides the results message, because the record that knew is
    // deleted with the poll — the card's disclosure has nothing else to read.
    assert_eq!(
        results["content"]["voters"],
        json!([[], [bob_id.clone()], [alice_id.clone()]])
    );
    assert!(results["content"]["body"]
        .as_str()
        .unwrap()
        .contains("tied"));
    assert_eq!(results["sender"], alice_id.as_str());

    // Deleting a poll's message is deleting the poll: nothing is left to vote
    // in, and nothing is left for the scheduler to find.
    let redact = client
        .delete(format!(
            "{}/_matrix/client/r0/rooms/{room_id}/redact/{poll_id}/rd1",
            server.base_url
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(redact.status(), StatusCode::OK);
    let gone = client
        .get(format!(
            "{}/api/rooms/{room_id}/polls/{poll_id}",
            server.base_url
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_poll_is_only_as_visible_as_the_channel_it_was_asked_in() {
    // Every refusal answers the same 404: which polls exist in a channel
    // somebody cannot open is itself something they should not learn.
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_id, alice_token) = register_user(&client, &server.base_url, "alice", "pw").await;
    let (_mallory_id, mallory_token) =
        register_user(&client, &server.base_url, "mallory", "pw").await;
    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "Private",
        None,
        false,
    )
    .await;

    let created: Value = client
        .post(format!("{}/api/rooms/{room_id}/polls", server.base_url))
        .header("authorization", bearer(&alice_token))
        .json(&json!({
            "question": "Who is coming?",
            "options": ["Yes", "No"],
            "duration_minutes": 60,
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let poll_id = created["event_id"].as_str().unwrap().to_string();

    // A non-member is told nothing, and cannot vote.
    let read = client
        .get(format!(
            "{}/api/rooms/{room_id}/polls/{poll_id}",
            server.base_url
        ))
        .header("authorization", bearer(&mallory_token))
        .send()
        .await
        .unwrap();
    assert_eq!(read.status(), StatusCode::NOT_FOUND);

    let voted = client
        .put(format!(
            "{}/api/rooms/{room_id}/polls/{poll_id}/vote",
            server.base_url
        ))
        .header("authorization", bearer(&mallory_token))
        .json(&json!({ "options": [0] }))
        .send()
        .await
        .unwrap();
    assert_eq!(voted.status(), StatusCode::NOT_FOUND);

    // A poll that does not exist answers the same way, so holding an id
    // reveals nothing either.
    let missing = client
        .get(format!(
            "{}/api/rooms/{room_id}/polls/$nope",
            server.base_url
        ))
        .header("authorization", bearer(&alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deleting_a_message_takes_its_upload_only_when_asked() {
    // Deleting a message used to take the files it carried with it, always.
    // A file can outlive the message that posted it — it is still the
    // uploader's, still listed under their files, still theirs to post again —
    // so the delete asks, and this is the two answers.
    let server = spawn_server().await;
    let client = Client::new();

    let (_alice_user_id, alice_token) =
        register_user(&client, &server.base_url, "attachalice", "pw").await;
    let room_id = create_room(
        &client,
        &server.base_url,
        &alice_token,
        "Attachments",
        None,
        false,
    )
    .await;

    async fn upload(client: &Client, base_url: &str, token: &str, filename: &str) -> String {
        let form = multipart::Form::new()
            .text("filename", filename.to_string())
            .part(
                "file",
                multipart::Part::bytes(b"payload".to_vec()).file_name(filename.to_string()),
            );
        let response = client
            .post(format!("{}/api/upload", base_url))
            .header("authorization", bearer(token))
            .multipart(form)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        body["url"].as_str().unwrap().to_string()
    }

    async fn post(
        client: &Client,
        base_url: &str,
        token: &str,
        room_id: &str,
        body: &str,
        txn: &str,
    ) -> String {
        let response = client
            .put(format!(
                "{}/_matrix/client/r0/rooms/{}/send/m.room.message/{}",
                base_url, room_id, txn
            ))
            .header("authorization", bearer(token))
            .json(&json!({"msgtype": "m.text", "body": body}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let sent: Value = response.json().await.unwrap();
        sent["event_id"].as_str().unwrap().to_string()
    }

    async fn my_files(client: &Client, base_url: &str, token: &str) -> Vec<String> {
        let response = client
            .get(format!("{}/api/uploads", base_url))
            .header("authorization", bearer(token))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        body["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["url"].as_str().unwrap().to_string())
            .collect()
    }

    let kept_url = upload(&client, &server.base_url, &alice_token, "kept.bin").await;
    let purged_url = upload(&client, &server.base_url, &alice_token, "purged.bin").await;

    let kept_event = post(
        &client,
        &server.base_url,
        &alice_token,
        &room_id,
        &format!("keep this {kept_url}"),
        "attach-txn1",
    )
    .await;
    let purged_event = post(
        &client,
        &server.base_url,
        &alice_token,
        &room_id,
        &format!("lose this {purged_url}"),
        "attach-txn2",
    )
    .await;

    for (event_id, delete_files, txn) in [
        (&kept_event, "false", "attach-txn3"),
        (&purged_event, "true", "attach-txn4"),
    ] {
        let redacted = client
            .delete(format!(
                "{}/_matrix/client/r0/rooms/{}/redact/{}/{}?delete_files={}",
                server.base_url, room_id, event_id, txn, delete_files
            ))
            .header("authorization", bearer(&alice_token))
            .send()
            .await
            .unwrap();
        assert_eq!(redacted.status(), StatusCode::OK);
    }

    // The purge runs off the request path, so the file that was asked for is
    // gone some time after the answer rather than with it.
    let mut files = my_files(&client, &server.base_url, &alice_token).await;
    for _ in 0..50 {
        if !files.contains(&purged_url) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        files = my_files(&client, &server.base_url, &alice_token).await;
    }

    assert!(
        !files.contains(&purged_url),
        "a delete that asked for the file should not leave it behind"
    );
    assert!(
        files.contains(&kept_url),
        "a delete that declined should leave the file under My Files"
    );
}
