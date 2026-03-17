# Chatter

A lightweight, performant, self-hosted chat application built with Rust. Chatter implements real-time messaging, voice chat, and screen sharing.

Development is moving fast — features are offered as-is with no guarantee of stability.

![Chatter screenshot](Screenshot_20260211_110841-1.png)

---

## Features

- Rooms
- Real-Time Messaging
- Voice Chat
- Multi Screen Sharing (requires HTTPS)
- File Sharing
- Steam Integration
- Spotify Integration
- Forums
- Collaborative Whiteboard
- Code Snippets and Syntax Highlighting
- Direct Messages
- Custom Emojis
- Room Invite Links
- 2FA (TOTP)
- Themes
- Friend Requests
- Chat Search
- Webhooks
- GIF Search (requires Klipy API key)
- Tank Scripting Mini Game
- Server Admin Dashboard

---

## Deployment

Chatter is deployed via Docker Compose. The stack includes three services: the Chatter application, MongoDB, and coturn (the TURN server required for WebRTC voice and screen sharing).

### Prerequisites

- Docker and Docker Compose
- A domain with HTTPS (required for WebRTC features)
- Ports open on your firewall: `3478/tcp`, `3478/udp`, `49152-49252/udp` (TURN relay range)

### 1. Clone the repository

```bash
git clone https://github.com/Sphyrna-029/Chatter.git
cd Chatter
```

### 2. Configure the TURN server

The TURN server enables WebRTC (voice and screen share) to work across different networks and through NATs. Coturn is included in the Docker Compose stack and reads from `turnserver.conf` in the project root.

Open `turnserver.conf` and set a strong username and password:

```conf
user=chatter:your-strong-password
```

Then configure the `external-ip` line based on your hosting scenario — see the [TURN server configuration](#turn-server-configuration) section below.

### 3. Set environment variables

Copy the example below into a `.env` file in the project root:

```env
JWT_SECRET=change-this-to-a-long-random-string
TURN_USERNAME=chatter
TURN_PASSWORD=your-strong-password
```

`TURN_USERNAME` and `TURN_PASSWORD` must match the credentials in `turnserver.conf`.

### 4. Configure docker-compose.yml

Open `docker-compose.yml` and adjust the settings for your environment. At minimum:

- Set the exposed port for the `chatter` service (default is `127.0.0.1:8067`)
- If using a reverse proxy (e.g. Traefik, Nginx), uncomment and fill in the labels or upstream config
- Uncomment and set `TURN_PUBLIC_URL` if your domain name differs from the internal TURN address

### 5. Start the stack

```bash
docker compose up -d
```

Chatter will be available on the port you configured. Register an account from the login screen — the first user to register is automatically promoted to server admin.

---

## TURN Server Configuration

WebRTC requires a TURN server for peers who cannot connect directly (e.g. users behind strict firewalls or symmetric NATs). Coturn handles this. The critical setting is `external-ip` in `turnserver.conf`, which tells coturn what address to advertise to clients.

### Scenario A: Server has a public IP directly

If your server is directly on the internet with a public IP (no NAT between the server and the internet), set `external-ip` to that IP:

```conf
external-ip=203.0.113.1
```

`docker-compose.yml` — no changes needed for TURN. Leave `TURN_URL` as-is:

```yaml
TURN_URL: "turn:host.docker.internal:3478"
TURN_USERNAME: ${TURN_USERNAME:-chatter}
TURN_PASSWORD: ${TURN_PASSWORD:-changeme}
```

Since coturn uses `network_mode: host`, it binds directly to the server's network interfaces and the relay ports are immediately reachable.

### Scenario B: Server is behind a NAT (home server, VPS with private LAN IP)

If your server sits behind a router or has both a private LAN IP and a public IP, coturn needs to know both so it can bind on the LAN interface but advertise the public address to clients.

Set `external-ip` in `turnserver.conf` using the format `PUBLIC_IP/LAN_IP`:

```conf
# Replace with your actual public IP and LAN IP
external-ip=203.0.113.1/192.168.1.100
```

To find your LAN IP:
```bash
ip addr show | grep 'inet '
```

To find your public IP:
```bash
curl -s https://ifconfig.me
```

In `docker-compose.yml`, also set `TURN_PUBLIC_URL` so the Chatter backend sends clients the correct public TURN address:

```yaml
TURN_URL: "turn:host.docker.internal:3478"
TURN_PUBLIC_URL: "turn:yourdomain.com:3478"
TURN_USERNAME: ${TURN_USERNAME:-chatter}
TURN_PASSWORD: ${TURN_PASSWORD:-changeme}
```

`TURN_URL` is used internally by the Chatter container to reach coturn. `TURN_PUBLIC_URL` is what gets sent to browser clients — it must be reachable from the internet.

### Firewall / port forwarding rules

In both scenarios, ensure the following are open and forwarded to your server:

| Port | Protocol | Purpose |
|------|----------|---------|
| 3478 | TCP + UDP | TURN signaling |
| 49152–49252 | UDP | TURN relay media |

On your router (NAT scenario), forward these port ranges to the server's LAN IP. On the server's firewall (`ufw`, `iptables`, cloud security group), allow inbound traffic on these ports.

### Verifying TURN works

After deployment, you can test your TURN server using a WebRTC ICE tester such as [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/). Enter your TURN URL and credentials and click "Gather candidates" — you should see relay candidates appear. If you only see `host` or `srflx` candidates but no `relay` candidates, the TURN server is not reachable.

---

## Optional Integrations

Uncomment the relevant environment variables in `docker-compose.yml`:

| Variable | Purpose |
|----------|---------|
| `KLIPY_API_KEY` | GIF search |
| `STEAM_API_KEY` + `SERVER_URL` | Steam integration |
| `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` | Spotify integration (set redirect URI to `https://yourdomain.com/api/auth/spotify/callback`) |

---

## Reverse Proxy (HTTPS)

HTTPS is required for WebRTC (voice and screen sharing). A Traefik example is included as comments in `docker-compose.yml`. Nginx or Caddy work equally well — proxy traffic to the Chatter container's port (`8000` internally).

Example Traefik labels (uncomment and fill in):

```yaml
labels:
  traefik.enable: "true"
  traefik.http.routers.chatter.entrypoints: "your-https-entrypoint"
  traefik.http.routers.chatter.rule: "Host(`yourdomain.com`)"
  traefik.http.routers.chatter.tls.certResolver: "your-tls-resolver"
  traefik.http.routers.chatter.tls: "true"
```

---

## Admin Dashboard

The first registered user is automatically promoted to server admin. Admins have a "Server Dashboard" button in the sidebar with:

- **Overview** — server stats (users, rooms, messages, files, storage)
- **Users** — view all users, disable/enable accounts, reset passwords, delete users
- **Rooms** — view all rooms with member and message counts, force-delete rooms

---

## Notes

- Data is persisted in a named Docker volume (`mongo_data`). Deleting the volume deletes all data.
- If behind Cloudflare's free plan, the maximum file upload size is 100 MB (Chatter does not currently chunk uploads).
- WebRTC (voice, screen share) requires HTTPS — it will not work over plain HTTP.

---

## License

See [LICENSE](LICENSE) for details.
