mod common;

use common::{
    bearer, create_room, recv_event_type, recv_matching, register_user, spawn_server,
    ws_connect_authenticated,
};
use futures_util::SinkExt;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
async fn websocket_requires_valid_auth_handshake() {
    let server = spawn_server().await;
    let (_alice_user_id, _alice_token) =
        register_user(&Client::new(), &server.base_url, "alice", "pw").await;

    let (mut socket, _) = connect_async(&server.ws_url).await.unwrap();
    socket
        .send(Message::Text(
            json!({"access_token": "invalid-token"}).to_string(),
        ))
        .await
        .unwrap();

    let error_msg = common::recv_json(&mut socket).await;
    assert_eq!(error_msg["error"], "Invalid token");
}

#[tokio::test]
async fn typing_and_voice_events_update_room_state() {
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

    let mut alice_ws = ws_connect_authenticated(&server.ws_url, &alice_token).await;
    let mut bob_ws = ws_connect_authenticated(&server.ws_url, &bob_token).await;

    let _ = recv_event_type(&mut alice_ws, "connected").await;
    let _ = recv_event_type(&mut bob_ws, "connected").await;

    alice_ws
        .send(Message::Text(
            json!({
                "type": "typing",
                "room_id": room_id
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let typing_event = recv_event_type(&mut bob_ws, "user_typing").await;
    assert_eq!(typing_event["room_id"], room_id);
    assert_eq!(typing_event["user_id"], "@alice:localhost");

    alice_ws
        .send(Message::Text(
            json!({
                "type": "voice_join",
                "room_id": room_id
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let joined_event = recv_event_type(&mut bob_ws, "voice_user_joined").await;
    assert_eq!(joined_event["room_id"], room_id);
    assert_eq!(joined_event["user_id"], "@alice:localhost");

    alice_ws
        .send(Message::Text(
            json!({
                "type": "voice_mute",
                "room_id": room_id,
                "muted": true
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let muted_event = recv_event_type(&mut bob_ws, "voice_user_muted").await;
    assert_eq!(muted_event["muted"], true);

    let voice_status = client
        .get(format!("{}/api/rooms/{}/voice", server.base_url, room_id))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(voice_status.status(), StatusCode::OK);
    let voice_body: Value = voice_status.json().await.unwrap();
    let alice_voice_entry = voice_body["voice_members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["user_id"] == "@alice:localhost")
        .unwrap();
    assert_eq!(alice_voice_entry["muted"], true);

    alice_ws
        .send(Message::Text(
            json!({
                "type": "voice_leave",
                "room_id": room_id
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let left_event = recv_event_type(&mut bob_ws, "voice_user_left").await;
    assert_eq!(left_event["room_id"], room_id);
    assert_eq!(left_event["user_id"], "@alice:localhost");

    let voice_status_after_leave = client
        .get(format!("{}/api/rooms/{}/voice", server.base_url, room_id))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    let after_leave_body: Value = voice_status_after_leave.json().await.unwrap();
    assert!(after_leave_body["voice_members"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["user_id"] != "@alice:localhost"));
}

#[tokio::test]
async fn presence_transitions_active_to_offline_on_connect_disconnect() {
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
    let _ = recv_event_type(&mut bob_ws, "connected").await;

    let mut alice_ws = ws_connect_authenticated(&server.ws_url, &alice_token).await;
    let _ = recv_event_type(&mut alice_ws, "connected").await;

    let active_presence = recv_matching(&mut bob_ws, |event| {
        event.get("type").and_then(Value::as_str) == Some("presence_update")
            && event.get("user_id").and_then(Value::as_str) == Some("@alice:localhost")
            && event.get("status").and_then(Value::as_str) == Some("active")
    })
    .await;
    assert_eq!(active_presence["status"], "active");

    alice_ws.close(None).await.unwrap();

    let offline_presence = recv_matching(&mut bob_ws, |event| {
        event.get("type").and_then(Value::as_str) == Some("presence_update")
            && event.get("user_id").and_then(Value::as_str) == Some("@alice:localhost")
            && event.get("status").and_then(Value::as_str) == Some("offline")
    })
    .await;

    assert_eq!(offline_presence["status"], "offline");
    assert_eq!(offline_presence["user_id"], "@alice:localhost");

    let presence_resp = client
        .get(format!(
            "{}/api/rooms/{}/presence",
            server.base_url, room_id
        ))
        .header("authorization", bearer(&bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(presence_resp.status(), StatusCode::OK);
    let presence_body: Value = presence_resp.json().await.unwrap();
    assert_eq!(
        presence_body["presence"]["@alice:localhost"]["status"],
        "offline"
    );
}

#[tokio::test]
async fn a_reconnecting_client_is_handed_the_whole_voice_picture() {
    // A voice event describes a change, so one sent while a socket was down
    // reaches nobody and leaves that client permanently wrong. The snapshot on
    // connect is what makes it right again without it knowing what it missed.
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

    let mut alice_ws = ws_connect_authenticated(&server.ws_url, &alice_token).await;
    let _ = recv_event_type(&mut alice_ws, "connected").await;

    alice_ws
        .send(Message::Text(
            json!({"type": "voice_join", "room_id": room_id}).to_string(),
        ))
        .await
        .unwrap();
    let _ = recv_event_type(&mut alice_ws, "voice_user_joined").await;

    alice_ws
        .send(Message::Text(
            json!({"type": "voice_mute", "room_id": room_id, "muted": true}).to_string(),
        ))
        .await
        .unwrap();
    let _ = recv_event_type(&mut alice_ws, "voice_user_muted").await;

    // Bob arrives after all of it, the way a reconnecting client does.
    let mut bob_ws = ws_connect_authenticated(&server.ws_url, &bob_token).await;
    let snapshot = recv_event_type(&mut bob_ws, "voice_state_sync").await;

    let channel = &snapshot["channels"][&room_id];
    assert_eq!(channel["room_id"], room_id);
    let alice = channel["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["user_id"] == "@alice:localhost")
        .expect("alice should be in the snapshot");
    // The mute happened before Bob had a socket at all.
    assert_eq!(alice["muted"], true);
    assert_eq!(alice["deafened"], false);

    // And the same picture on demand, for a tab coming back from the
    // background with its connection intact.
    bob_ws
        .send(Message::Text(
            json!({"type": "voice_state_request"}).to_string(),
        ))
        .await
        .unwrap();
    let requested = recv_event_type(&mut bob_ws, "voice_state_sync").await;
    assert_eq!(
        requested["channels"][&room_id]["members"],
        channel["members"]
    );
}

#[tokio::test]
async fn voice_events_carry_every_members_state() {
    // The list of ids alone left a client that had not seen a member before to
    // invent their flags, and it invented them unmuted.
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

    let mut alice_ws = ws_connect_authenticated(&server.ws_url, &alice_token).await;
    let _ = recv_event_type(&mut alice_ws, "connected").await;
    let mut bob_ws = ws_connect_authenticated(&server.ws_url, &bob_token).await;
    let _ = recv_event_type(&mut bob_ws, "connected").await;

    alice_ws
        .send(Message::Text(
            json!({"type": "voice_join", "room_id": room_id}).to_string(),
        ))
        .await
        .unwrap();
    let _ = recv_event_type(&mut alice_ws, "voice_user_joined").await;
    alice_ws
        .send(Message::Text(
            json!({"type": "voice_deafen", "room_id": room_id, "deafened": true}).to_string(),
        ))
        .await
        .unwrap();
    let _ = recv_event_type(&mut bob_ws, "voice_user_deafened").await;

    // Bob joining is told about Alice as she actually is.
    bob_ws
        .send(Message::Text(
            json!({"type": "voice_join", "room_id": room_id}).to_string(),
        ))
        .await
        .unwrap();
    let joined = recv_matching(&mut bob_ws, |event| {
        event.get("type").and_then(Value::as_str) == Some("voice_user_joined")
            && event.get("user_id").and_then(Value::as_str) == Some("@bob:localhost")
    })
    .await;

    let alice = joined["voice_states"]
        .as_array()
        .expect("a join names every member's state")
        .iter()
        .find(|m| m["user_id"] == "@alice:localhost")
        .expect("alice is still in the channel");
    assert_eq!(alice["deafened"], true);

    // And so is the leave that follows.
    alice_ws
        .send(Message::Text(
            json!({"type": "voice_leave", "room_id": room_id}).to_string(),
        ))
        .await
        .unwrap();
    let left = recv_event_type(&mut bob_ws, "voice_user_left").await;
    let remaining = left["voice_states"].as_array().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["user_id"], "@bob:localhost");
}
