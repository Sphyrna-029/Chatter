use axum::Router;
use chatter::backend::app::{build_app, build_state};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

pub type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub struct TestServer {
    pub base_url: String,
    pub ws_url: String,
    handle: JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub async fn spawn_server() -> TestServer {
    let app: Router = build_app(build_state().await);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    TestServer {
        base_url: format!("http://{}", addr),
        ws_url: format!("ws://{}/ws", addr),
        handle,
    }
}

pub fn bearer(token: &str) -> String {
    format!("Bearer {}", token)
}

pub async fn register_user(
    client: &Client,
    base_url: &str,
    username: &str,
    password: &str,
) -> (String, String) {
    let response = client
        .post(format!("{}/_matrix/client/r0/register", base_url))
        .json(&json!({
            "username": username,
            "password": password,
            "device_id": format!("{}-device", username)
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    (
        body["user_id"].as_str().unwrap().to_string(),
        body["access_token"].as_str().unwrap().to_string(),
    )
}

pub async fn create_room(
    client: &Client,
    base_url: &str,
    token: &str,
    name: &str,
    invite: Option<Vec<String>>,
    is_direct: bool,
) -> String {
    let response = client
        .post(format!("{}/_matrix/client/r0/createRoom", base_url))
        .header("authorization", bearer(token))
        .json(&json!({
            "name": name,
            "topic": "",
            "invite": invite,
            "is_direct": is_direct
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    body["room_id"].as_str().unwrap().to_string()
}

pub async fn ws_connect_authenticated(ws_url: &str, token: &str) -> WsStream {
    let (mut socket, _) = connect_async(ws_url).await.unwrap();
    socket
        .send(Message::Text(json!({"access_token": token}).to_string()))
        .await
        .unwrap();
    socket
}

pub async fn recv_json(ws: &mut WsStream) -> Value {
    loop {
        let next_msg = timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for websocket message")
            .expect("websocket stream ended")
            .expect("websocket read error");

        match next_msg {
            Message::Text(text) => {
                let text = text.to_string();
                return serde_json::from_str(&text).expect("text message should be valid JSON");
            }
            Message::Binary(bin) => {
                return serde_json::from_slice(&bin)
                    .expect("binary message in contract tests should be valid JSON");
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(frame) => {
                panic!("unexpected websocket close: {:?}", frame);
            }
        }
    }
}

pub async fn recv_event_type(ws: &mut WsStream, event_type: &str) -> Value {
    recv_matching(ws, |event| {
        event.get("type").and_then(Value::as_str) == Some(event_type)
    })
    .await
}

pub async fn recv_matching<F>(ws: &mut WsStream, predicate: F) -> Value
where
    F: Fn(&Value) -> bool,
{
    loop {
        let event = recv_json(ws).await;
        if predicate(&event) {
            return event;
        }
    }
}
