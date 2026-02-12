"""
Matrix Protocol Chat Server - FastAPI Implementation
Implements core Matrix Client-Server API endpoints
"""
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List, Dict
import uvicorn
import json
import time
import secrets
from datetime import datetime
from pathlib import Path

app = FastAPI(title="Matrix Chat Server")

# In-memory storage (in production, use a real database)
users: Dict[str, dict] = {}
rooms: Dict[str, dict] = {}
room_members: Dict[str, List[str]] = {}  # room_id -> list of user_ids
messages: Dict[str, List[dict]] = {}  # room_id -> list of messages
message_reactions: Dict[str, Dict[str, List[str]]] = {}  # event_id -> {emoji: [user_ids]}
access_tokens: Dict[str, str] = {}  # token -> user_id
active_websockets: Dict[str, WebSocket] = {}  # user_id -> websocket
voice_channels: Dict[str, Dict[str, dict]] = {}  # room_id -> {user_id: {muted: bool, screen_sharing: bool}}
user_presence: Dict[str, dict] = {}  # user_id -> {last_active: timestamp, last_typing: timestamp}


# Pydantic Models
class RegisterRequest(BaseModel):
    username: str
    password: str
    device_id: Optional[str] = None


class LoginRequest(BaseModel):
    username: str
    password: str
    device_id: Optional[str] = None


class CreateRoomRequest(BaseModel):
    name: Optional[str] = None
    topic: Optional[str] = None
    invite: Optional[List[str]] = []


class SendMessageRequest(BaseModel):
    msgtype: str = "m.text"
    body: str


class JoinRoomRequest(BaseModel):
    room_id: str


# Helper Functions
def generate_token() -> str:
    return f"syt_{secrets.token_urlsafe(32)}"


def generate_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(16)}"


def get_user_from_token(token: str) -> Optional[str]:
    return access_tokens.get(token)


def format_user_id(username: str) -> str:
    return f"@{username}:localhost"


def format_room_id(room_name: str) -> str:
    return f"!{room_name}:localhost"


async def broadcast_to_room(room_id: str, message: dict):
    """Broadcast a message to all users in a room via WebSocket"""
    if room_id in room_members:
        for user_id in room_members[room_id]:
            if user_id in active_websockets:
                try:
                    await active_websockets[user_id].send_json(message)
                except:
                    pass


# Matrix Client-Server API Endpoints

@app.get("/")
async def root():
    """Serve the chat client HTML"""
    html_path = Path(__file__).parent / "client.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text())
    return {"message": "Matrix Chat Server", "version": "r0.6.1"}


@app.get("/_matrix/client/versions")
async def versions():
    """Return supported Matrix versions"""
    return {
        "versions": ["r0.5.0", "r0.6.0", "r0.6.1"]
    }


@app.post("/_matrix/client/r0/register")
async def register(request: RegisterRequest):
    """Register a new user"""
    user_id = format_user_id(request.username)
    
    if user_id in users:
        raise HTTPException(status_code=400, detail="User already exists")
    
    token = generate_token()
    device_id = request.device_id or generate_id("DEVICE")
    
    users[user_id] = {
        "password": request.password,
        "created": datetime.now().isoformat(),
        "devices": [device_id]
    }
    access_tokens[token] = user_id
    
    return {
        "user_id": user_id,
        "access_token": token,
        "device_id": device_id
    }


@app.post("/_matrix/client/r0/login")
async def login(request: LoginRequest):
    """Login an existing user"""
    user_id = format_user_id(request.username)
    
    if user_id not in users or users[user_id]["password"] != request.password:
        raise HTTPException(status_code=403, detail="Invalid credentials")
    
    token = generate_token()
    device_id = request.device_id or generate_id("DEVICE")
    
    access_tokens[token] = user_id
    
    return {
        "user_id": user_id,
        "access_token": token,
        "device_id": device_id
    }


@app.post("/_matrix/client/r0/logout")
async def logout(request: Request):
    """Logout the current user"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if user_id and user_id in active_websockets:
        del active_websockets[user_id]
    
    if token in access_tokens:
        del access_tokens[token]
    
    return {}


@app.post("/_matrix/client/r0/createRoom")
async def create_room(room_request: CreateRoomRequest, request: Request):
    """Create a new room"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    room_id = generate_id("!")
    room_name = room_request.name or f"Room {len(rooms) + 1}"
    
    rooms[room_id] = {
        "name": room_name,
        "topic": room_request.topic or "",
        "creator": user_id,
        "created": datetime.now().isoformat()
    }
    
    room_members[room_id] = [user_id]
    messages[room_id] = []
    
    # Add invited users
    if room_request.invite:
        for invited_user in room_request.invite:
            if invited_user in users and invited_user not in room_members[room_id]:
                room_members[room_id].append(invited_user)
    
    return {
        "room_id": room_id
    }


@app.post("/_matrix/client/r0/rooms/{room_id}/join")
async def join_room(room_id: str, request: Request):
    """Join a room"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    if room_id not in room_members:
        room_members[room_id] = []
    
    if user_id not in room_members[room_id]:
        room_members[room_id].append(user_id)
        
        # Broadcast join event
        await broadcast_to_room(room_id, {
            "type": "m.room.member",
            "room_id": room_id,
            "sender": user_id,
            "content": {
                "membership": "join"
            },
            "event_id": generate_id("$"),
            "origin_server_ts": int(time.time() * 1000)
        })
    
    return {
        "room_id": room_id
    }


@app.post("/_matrix/client/r0/rooms/{room_id}/leave")
async def leave_room(room_id: str, request: Request):
    """Leave a room"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    if room_id in room_members and user_id in room_members[room_id]:
        room_members[room_id].remove(user_id)
        
        # Remove from voice channel if active
        if room_id in voice_channels and user_id in voice_channels[room_id]:
            del voice_channels[room_id][user_id]
        
        # Broadcast leave event
        await broadcast_to_room(room_id, {
            "type": "m.room.member",
            "room_id": room_id,
            "sender": user_id,
            "content": {
                "membership": "leave"
            },
            "event_id": generate_id("$"),
            "origin_server_ts": int(time.time() * 1000)
        })
    
    return {
        "room_id": room_id
    }


@app.get("/_matrix/client/r0/joined_rooms")
async def get_joined_rooms(request: Request):
    """Get list of rooms the user has joined"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    joined = [room_id for room_id, members in room_members.items() if user_id in members]
    
    return {
        "joined_rooms": joined
    }


@app.get("/_matrix/client/r0/rooms/{room_id}/messages")
async def get_room_messages(room_id: str, request: Request, limit: int = 50):
    """Get messages from a room"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    if user_id not in room_members.get(room_id, []):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    
    room_messages = messages.get(room_id, [])[-limit:]
    
    return {
        "start": "t0",
        "end": "t1",
        "chunk": room_messages
    }


@app.put("/_matrix/client/r0/rooms/{room_id}/send/m.room.message/{txn_id}")
async def send_message(room_id: str, txn_id: str, message: SendMessageRequest, request: Request):
    """Send a message to a room"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    if user_id not in room_members.get(room_id, []):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    
    event_id = generate_id("$")
    timestamp = int(time.time() * 1000)
    
    event = {
        "type": "m.room.message",
        "room_id": room_id,
        "sender": user_id,
        "content": {
            "msgtype": message.msgtype,
            "body": message.body
        },
        "event_id": event_id,
        "origin_server_ts": timestamp
    }
    
    if room_id not in messages:
        messages[room_id] = []
    
    messages[room_id].append(event)
    
    # Broadcast to all room members
    await broadcast_to_room(room_id, event)
    
    return {
        "event_id": event_id
    }


@app.delete("/_matrix/client/r0/rooms/{room_id}/redact/{event_id}/{txn_id}")
async def redact_message(room_id: str, event_id: str, txn_id: str, request: Request):
    """Delete/redact a message"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    if user_id not in room_members.get(room_id, []):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    
    # Find the message
    if room_id in messages:
        for msg in messages[room_id]:
            if msg.get("event_id") == event_id:
                # Check if user is the sender
                if msg.get("sender") != user_id:
                    raise HTTPException(status_code=403, detail="Can only delete your own messages")
                
                # Mark message as redacted
                msg["content"] = {
                    "msgtype": "m.text",
                    "body": "[deleted]"
                }
                msg["redacted"] = True
                msg["redacted_by"] = user_id
                msg["redacted_at"] = int(time.time() * 1000)
                
                # Broadcast the redaction
                redaction_event = {
                    "type": "m.room.redaction",
                    "room_id": room_id,
                    "sender": user_id,
                    "redacts": event_id,
                    "event_id": generate_id("$"),
                    "origin_server_ts": int(time.time() * 1000)
                }
                
                await broadcast_to_room(room_id, redaction_event)
                
                return {"event_id": redaction_event["event_id"]}
    
    raise HTTPException(status_code=404, detail="Message not found")


@app.get("/_matrix/client/r0/sync")
async def sync(request: Request, timeout: int = 30000):
    """Sync endpoint for long-polling"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    # Build sync response
    joined_rooms_data = {}
    for room_id, members in room_members.items():
        if user_id in members:
            room_data = rooms.get(room_id, {})
            room_messages = messages.get(room_id, [])[-10:]  # Last 10 messages
            
            # Build member events
            member_events = []
            for member_id in members:
                member_events.append({
                    "type": "m.room.member",
                    "state_key": member_id,
                    "content": {
                        "membership": "join",
                        "displayname": member_id.split(':')[0][1:]
                    },
                    "sender": member_id
                })
            
            joined_rooms_data[room_id] = {
                "state": {
                    "events": [
                        {
                            "type": "m.room.name",
                            "state_key": "",
                            "content": {"name": room_data.get("name", "")},
                            "sender": room_data.get("creator", "")
                        },
                        {
                            "type": "m.room.topic",
                            "state_key": "",
                            "content": {"topic": room_data.get("topic", "")},
                            "sender": room_data.get("creator", "")
                        }
                    ] + member_events
                },
                "timeline": {
                    "events": room_messages,
                    "limited": False,
                    "prev_batch": "t0"
                }
            }
    
    return {
        "next_batch": f"s{int(time.time())}",
        "rooms": {
            "join": joined_rooms_data
        }
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates and audio streaming"""
    await websocket.accept()
    user_id = None
    
    try:
        # First message should be authentication
        auth_msg = await websocket.receive_json()
        token = auth_msg.get("access_token")
        user_id = get_user_from_token(token)
        
        if not user_id:
            await websocket.send_json({"error": "Invalid token"})
            await websocket.close()
            return
        
        active_websockets[user_id] = websocket
        
        # Update user presence
        user_presence[user_id] = {
            "last_active": time.time(),
            "last_typing": 0,
            "connected": True
        }
        
        await websocket.send_json({"type": "connected", "user_id": user_id})
        
        # Keep connection alive and handle incoming messages
        while True:
            data = await websocket.receive()
            
            # Handle binary audio data
            if "bytes" in data:
                binary_data = data["bytes"]
                
                # Check if it's screen share or audio based on header
                if binary_data[:7] == b'SCREEN:':
                    # Screen share frame - only to voice members
                    screen_frame = binary_data[7:]
                    
                    # Find which room this user is in and broadcasting screen
                    for room_id, members in voice_channels.items():
                        if user_id in members and members[user_id].get("screen_sharing", False):
                            # Broadcast screen frame to all other users in the voice channel
                            for member_id in members:
                                if member_id != user_id and member_id in active_websockets:
                                    try:
                                        await active_websockets[member_id].send_bytes(binary_data)
                                    except:
                                        pass
                            break
                
                elif binary_data[:6] == b'AUDIO:':
                    # Audio data with header - only to voice members
                    audio_data = binary_data[6:]
                    
                    # Find which room this user is in voice chat
                    for room_id, members in voice_channels.items():
                        if user_id in members and not members[user_id].get("muted", False):
                            # Broadcast audio to all other users in the voice channel
                            for member_id in members:
                                if member_id != user_id and member_id in active_websockets:
                                    try:
                                        await active_websockets[member_id].send_bytes(binary_data)
                                    except:
                                        pass
                            break
                else:
                    # Legacy audio without header - only to voice members
                    # Find which room this user is in voice chat
                    for room_id, members in voice_channels.items():
                        if user_id in members and not members[user_id].get("muted", False):
                            # Broadcast audio to all other users in the voice channel
                            for member_id in members:
                                if member_id != user_id and member_id in active_websockets:
                                    try:
                                        await active_websockets[member_id].send_bytes(binary_data)
                                    except:
                                        pass
                            break
            
            # Handle JSON messages
            elif "text" in data:
                msg = json.loads(data["text"])
                
                # Update last active time for any message
                if user_id in user_presence:
                    user_presence[user_id]["last_active"] = time.time()
                
                if msg.get("type") == "typing":
                    # User is typing
                    room_id = msg.get("room_id")
                    if user_id in user_presence:
                        user_presence[user_id]["last_typing"] = time.time()
                    
                    # Broadcast typing indicator to room
                    await broadcast_to_room(room_id, {
                        "type": "user_typing",
                        "room_id": room_id,
                        "user_id": user_id
                    })
                
                elif msg.get("type") == "voice_join":
                    # User joining voice channel
                    room_id = msg.get("room_id")
                    if room_id not in voice_channels:
                        voice_channels[room_id] = {}
                    
                    voice_channels[room_id][user_id] = {
                        "muted": False,
                        "joined_at": time.time()
                    }
                    
                    # Notify all room members
                    await broadcast_to_room(room_id, {
                        "type": "voice_user_joined",
                        "room_id": room_id,
                        "user_id": user_id,
                        "voice_members": list(voice_channels[room_id].keys())
                    })
                
                elif msg.get("type") == "voice_leave":
                    # User leaving voice channel
                    room_id = msg.get("room_id")
                    if room_id in voice_channels and user_id in voice_channels[room_id]:
                        del voice_channels[room_id][user_id]
                        
                        # Notify all room members
                        await broadcast_to_room(room_id, {
                            "type": "voice_user_left",
                            "room_id": room_id,
                            "user_id": user_id,
                            "voice_members": list(voice_channels[room_id].keys())
                        })
                
                elif msg.get("type") == "voice_mute":
                    # User toggling mute
                    room_id = msg.get("room_id")
                    muted = msg.get("muted", False)
                    if room_id in voice_channels and user_id in voice_channels[room_id]:
                        voice_channels[room_id][user_id]["muted"] = muted
                        
                        # Notify all room members
                        await broadcast_to_room(room_id, {
                            "type": "voice_user_muted",
                            "room_id": room_id,
                            "user_id": user_id,
                            "muted": muted
                        })
                
                elif msg.get("type") == "screen_share_start":
                    # User started screen sharing
                    room_id = msg.get("room_id")
                    if room_id in voice_channels and user_id in voice_channels[room_id]:
                        voice_channels[room_id][user_id]["screen_sharing"] = True
                        
                        # Notify all room members
                        await broadcast_to_room(room_id, {
                            "type": "screen_share_started",
                            "room_id": room_id,
                            "user_id": user_id
                        })
                
                elif msg.get("type") == "screen_share_stop":
                    # User stopped screen sharing
                    room_id = msg.get("room_id")
                    if room_id in voice_channels and user_id in voice_channels[room_id]:
                        voice_channels[room_id][user_id]["screen_sharing"] = False
                        
                        # Notify all room members
                        await broadcast_to_room(room_id, {
                            "type": "screen_share_stopped",
                            "room_id": room_id,
                            "user_id": user_id
                        })
            
    except WebSocketDisconnect:
        if user_id:
            # Remove from voice channels
            for room_id in list(voice_channels.keys()):
                if user_id in voice_channels[room_id]:
                    was_screen_sharing = voice_channels[room_id][user_id].get("screen_sharing", False)
                    del voice_channels[room_id][user_id]
                    
                    await broadcast_to_room(room_id, {
                        "type": "voice_user_left",
                        "room_id": room_id,
                        "user_id": user_id,
                        "voice_members": list(voice_channels[room_id].keys())
                    })
                    
                    # Notify about screen share stopping if they were sharing
                    if was_screen_sharing:
                        await broadcast_to_room(room_id, {
                            "type": "screen_share_stopped",
                            "room_id": room_id,
                            "user_id": user_id
                        })
            
            if user_id in active_websockets:
                del active_websockets[user_id]
            
            # Mark user as disconnected
            if user_id in user_presence:
                user_presence[user_id]["connected"] = False
                user_presence[user_id]["last_active"] = time.time()
    except Exception as e:
        print(f"WebSocket error: {e}")
        if user_id and user_id in active_websockets:
            del active_websockets[user_id]


@app.get("/api/rooms")
async def list_all_rooms():
    """List all available rooms (non-standard endpoint for convenience)"""
    room_list = []
    for room_id, room_data in rooms.items():
        room_list.append({
            "room_id": room_id,
            "name": room_data["name"],
            "topic": room_data.get("topic", ""),
            "member_count": len(room_members.get(room_id, []))
        })
    return {"rooms": room_list}


@app.get("/api/rooms/{room_id}/voice")
async def get_voice_channel_status(room_id: str, request: Request):
    """Get voice channel status for a room"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    voice_members = []
    if room_id in voice_channels:
        for member_id, member_data in voice_channels[room_id].items():
            voice_members.append({
                "user_id": member_id,
                "muted": member_data.get("muted", False),
                "screen_sharing": member_data.get("screen_sharing", False)
            })
    
    return {
        "room_id": room_id,
        "voice_members": voice_members
    }


@app.get("/api/rooms/{room_id}/presence")
async def get_room_presence(room_id: str, request: Request):
    """Get presence information for all members in a room"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    current_time = time.time()
    presence_data = {}
    
    if room_id in room_members:
        for member_id in room_members[room_id]:
            if member_id in user_presence:
                presence = user_presence[member_id]
                time_since_typing = current_time - presence.get("last_typing", 0)
                
                # Determine status
                if not presence.get("connected", False):
                    status = "offline"
                elif time_since_typing < 300:  # 5 minutes
                    status = "active"
                else:
                    status = "idle"
                
                presence_data[member_id] = {
                    "status": status,
                    "last_active": presence.get("last_active", 0),
                    "last_typing": presence.get("last_typing", 0)
                }
            else:
                presence_data[member_id] = {
                    "status": "offline",
                    "last_active": 0,
                    "last_typing": 0
                }
    
    return {
        "room_id": room_id,
        "presence": presence_data
    }


@app.put("/_matrix/client/r0/rooms/{room_id}/send/m.reaction/{event_id}")
async def add_reaction(room_id: str, event_id: str, request: Request):
    """Add an emoji reaction to a message"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    if user_id not in room_members.get(room_id, []):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    
    body = await request.json()
    emoji = body.get("emoji")
    
    if not emoji:
        raise HTTPException(status_code=400, detail="Emoji required")
    
    # Initialize reactions for this event if needed
    if event_id not in message_reactions:
        message_reactions[event_id] = {}
    
    # Initialize emoji list if needed
    if emoji not in message_reactions[event_id]:
        message_reactions[event_id][emoji] = []
    
    # Toggle reaction (add if not present, remove if present)
    if user_id in message_reactions[event_id][emoji]:
        message_reactions[event_id][emoji].remove(user_id)
        if not message_reactions[event_id][emoji]:
            del message_reactions[event_id][emoji]
        action = "removed"
    else:
        message_reactions[event_id][emoji].append(user_id)
        action = "added"
    
    # Broadcast reaction update
    await broadcast_to_room(room_id, {
        "type": "m.reaction",
        "room_id": room_id,
        "event_id": event_id,
        "emoji": emoji,
        "user_id": user_id,
        "action": action,
        "reactions": message_reactions.get(event_id, {})
    })
    
    return {
        "event_id": generate_id("$"),
        "reactions": message_reactions.get(event_id, {})
    }


@app.get("/_matrix/client/r0/rooms/{room_id}/event/{event_id}/reactions")
async def get_reactions(room_id: str, event_id: str, request: Request):
    """Get reactions for a specific message"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split("Bearer ")[1]
    user_id = get_user_from_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    return {
        "event_id": event_id,
        "reactions": message_reactions.get(event_id, {})
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
