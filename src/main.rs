#[tokio::main]
async fn main() {
    chatter::backend::run().await;
}
