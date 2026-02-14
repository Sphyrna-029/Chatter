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
