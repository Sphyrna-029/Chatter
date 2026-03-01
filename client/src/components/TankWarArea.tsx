import { useState, useEffect, useRef, useCallback } from "react";
import { GripHorizontal, GripVertical, ZoomIn, ZoomOut, PanelBottom, PanelLeft, PanelRight, PanelTop } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { apiGetTankWarState, apiNewTankWarGame } from "@/lib/api";
import Editor from "@monaco-editor/react";

const CELL_SIZE = 10;
const GRID_SIZE = 64;
const CANVAS_SIZE = CELL_SIZE * GRID_SIZE;

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

const DEFAULT_SCRIPT = `-- ╔══════════════════════════════════════════════════╗
-- ║           TANK WARS — LUA SCRIPTING API          ║
-- ╚══════════════════════════════════════════════════╝
--
-- Your script runs once per tick (~6 ticks/sec).
-- Game modes: CTF (capture the flag), Battle Royale (1HP, last
-- alive wins), King of the Hill (hold hill zone 20 ticks to win).
-- One move and one shot allowed per tick.
--
-- ┌─────────────────────────────────────────────────┐
-- │ MOVEMENT & COMBAT                               │
-- ├─────────────────────────────────────────────────┤
-- │ move(dir)          Move 1 cell in direction.    │
-- │                    Blocked by walls and tanks.   │
-- │ shoot(dir)         Fire a bullet in direction.  │
-- │                    Bullets move 1 cell/tick.     │
-- │                    Each hit does 1 damage.       │
-- ├─────────────────────────────────────────────────┤
-- │ SENSING                                         │
-- ├─────────────────────────────────────────────────┤
-- │ scan(dir, range)   Look up to \`range\` cells in │
-- │                    a direction. Returns the     │
-- │                    first thing found:            │
-- │                    "wall", "enemy", "flag",     │
-- │                    or "empty" if nothing.        │
-- ├─────────────────────────────────────────────────┤
-- │ STATE                                           │
-- ├─────────────────────────────────────────────────┤
-- │ get_position()     Returns {x, y} of your tank. │
-- │ get_health()       Returns HP remaining (1-3).  │
-- │ get_flag_position()Returns {x, y} of the flag.  │
-- │ get_tick()         Returns current tick number.   │
-- │ get_game_mode()    Returns "ctf",                │
-- │                    "battle_royale", or "koth".   │
-- ├─────────────────────────────────────────────────┤
-- │ MEMORY (persists across ticks)                  │
-- ├─────────────────────────────────────────────────┤
-- │ store(key, val)    Save a string value.         │
-- │                    Up to 100 keys allowed.      │
-- │ recall(key)        Get stored value or nil.     │
-- ├─────────────────────────────────────────────────┤
-- │ DIRECTIONS                                      │
-- ├─────────────────────────────────────────────────┤
-- │ "north" = up (y-1)    "south" = down (y+1)     │
-- │ "west"  = left (x-1)  "east"  = right (x+1)    │
-- └─────────────────────────────────────────────────┘
--
-- Grid is 64x64 with walls on the borders.
-- Tanks spawn in corners. Flag is at the center.

local pos = get_position()
local flag = get_flag_position()

-- Move toward the flag
if pos.x < flag.x then
  move("east")
elseif pos.x > flag.x then
  move("west")
elseif pos.y < flag.y then
  move("south")
elseif pos.y > flag.y then
  move("north")
end

-- Shoot at enemies in sight
for _, dir in ipairs({"north","south","east","west"}) do
  local result = scan(dir, 5)
  if result == "enemy" then
    shoot(dir)
    break
  end
end
`;

interface TankPlayer {
  user_id: string;
  ready: boolean;
  x: number;
  y: number;
  direction: string;
  health: number;
  alive: boolean;
  color: string;
  score: number;
  has_script?: boolean;
  hill_ticks?: number;
}

interface BulletData {
  x: number;
  y: number;
  direction: string;
  owner: string;
}

interface GameState {
  game_id: string | null;
  status: "none" | "lobby" | "running" | "finished";
  grid_size: number;
  max_ticks: number;
  current_tick: number;
  maze: number[][];
  players: TankPlayer[];
  bullets: BulletData[];
  flag_position: number[];
  winner: string | null;
  resetVotes: number;
  resetTotal: number;
  myResetVote: boolean;
  game_mode: string;
}

type EditorPosition = "bottom" | "top" | "left" | "right";

export function TankWarArea() {
  const { state, wsRef } = useAppContext();
  const roomId = state.currentRoomId;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [editorSize, setEditorSize] = useState(220);
  const [editorPos, setEditorPos] = useState<EditorPosition>("bottom");
  const [zoom, setZoom] = useState(1);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef(0);
  const dragStartSizeRef = useRef(0);
  const [gameState, setGameState] = useState<GameState>({
    game_id: null,
    status: "none",
    grid_size: GRID_SIZE,
    max_ticks: 1000,
    current_tick: 0,
    maze: [],
    players: [],
    bullets: [],
    flag_position: [32, 32],
    winner: null,
    resetVotes: 0,
    resetTotal: 0,
    myResetVote: false,
    game_mode: "ctf",
  });
  const [scriptSubmitted, setScriptSubmitted] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsMode, setSettingsMode] = useState("ctf");
  const [settingsTicks, setSettingsTicks] = useState(1000);

  const sendWs = useCallback(
    (msg: Record<string, unknown>) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    [wsRef]
  );

  const isVertical = editorPos === "top" || editorPos === "bottom";

  // Drag-to-resize editor panel
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = isVertical ? e.clientY : e.clientX;
    dragStartSizeRef.current = editorSize;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const wrapper = wrapperRef.current;
      const maxS = wrapper
        ? (isVertical ? wrapper.clientHeight : wrapper.clientWidth) - 60
        : 600;
      const pos = isVertical ? ev.clientY : ev.clientX;
      // Dragging toward the canvas = growing the editor
      const sign = editorPos === "bottom" || editorPos === "right" ? -1 : 1;
      const delta = (pos - dragStartRef.current) * sign;
      setEditorSize(Math.max(36, Math.min(maxS, dragStartSizeRef.current + delta)));
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [editorSize, editorPos, isVertical]);

  // Zoom
  const zoomIn = useCallback(() => {
    setZoom((z) => {
      const idx = ZOOM_LEVELS.indexOf(z);
      return idx < ZOOM_LEVELS.length - 1 ? ZOOM_LEVELS[idx + 1] : z;
    });
  }, []);
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const idx = ZOOM_LEVELS.indexOf(z);
      return idx > 0 ? ZOOM_LEVELS[idx - 1] : z;
    });
  }, []);

  // Load initial state
  useEffect(() => {
    if (!roomId) return;
    apiGetTankWarState(roomId)
      .then((data) => {
        if (data.status !== "none") {
          setGameState((prev) => ({
            ...prev,
            game_id: data.game_id,
            status: data.status,
            grid_size: data.grid_size || GRID_SIZE,
            max_ticks: data.max_ticks || 1000,
            current_tick: data.current_tick || 0,
            maze: data.maze || [],
            players: data.players || [],
            bullets: data.bullets || [],
            flag_position: data.flag_position || [32, 32],
            winner: data.winner || null,
            game_mode: data.game_mode || "ctf",
          }));
        }
      })
      .catch(() => {});
  }, [roomId]);

  // Listen for WS events
  useEffect(() => {
    const onPlayerJoined = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({ ...prev, game_id: d.game_id, players: d.players || prev.players }));
    };
    const onPlayerReady = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({ ...prev, players: d.players || prev.players }));
    };
    const onScriptSubmitted = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setScriptSubmitted(true);
    };
    const onGameStart = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setEditorSize(36);
      setGameState((prev) => ({
        ...prev, status: "running", game_id: d.game_id, maze: d.maze,
        flag_position: d.flag_position, players: d.players, current_tick: 0, bullets: [],
        game_mode: d.game_mode || prev.game_mode,
      }));
    };
    const onTick = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({
        ...prev, current_tick: d.tick,
        players: d.players.map((p: any) => ({ ...prev.players.find((ep) => ep.user_id === p.user_id), ...p })),
        bullets: d.bullets || [],
      }));
    };
    const onGameOver = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({
        ...prev, status: "finished", winner: d.winner,
        players: d.players.map((p: any) => ({ ...prev.players.find((ep) => ep.user_id === p.user_id), ...p })),
      }));
    };
    const onResetVote = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({
        ...prev, resetVotes: d.vote_count, resetTotal: d.votes_needed,
        myResetVote: d.user_id === state.userId ? true : prev.myResetVote,
      }));
    };
    const onGameReset = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({ ...prev, status: "finished", winner: null, resetVotes: 0, resetTotal: 0, myResetVote: false }));
    };

    const events = [
      ["tankwar_player_joined", onPlayerJoined], ["tankwar_player_ready", onPlayerReady],
      ["tankwar_script_submitted", onScriptSubmitted], ["tankwar_game_start", onGameStart],
      ["tankwar_tick", onTick], ["tankwar_game_over", onGameOver],
      ["tankwar_reset_vote", onResetVote], ["tankwar_game_reset", onGameReset],
    ] as const;
    for (const [name, fn] of events) window.addEventListener(name, fn);
    return () => { for (const [name, fn] of events) window.removeEventListener(name, fn); };
  }, [roomId, state.userId]);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { maze, players, bullets, flag_position, status } = gameState;
    const CS = CELL_SIZE;

    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    if (status === "none" || status === "lobby") {
      ctx.strokeStyle = "#2a2a4a";
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= GRID_SIZE; i++) {
        ctx.beginPath(); ctx.moveTo(i * CS, 0); ctx.lineTo(i * CS, CANVAS_SIZE); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * CS); ctx.lineTo(CANVAS_SIZE, i * CS); ctx.stroke();
      }
      ctx.fillStyle = "#6a6a8a";
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.fillText(status === "none" ? "Start a new game to begin!" : "Waiting for players...", CANVAS_SIZE / 2, CANVAS_SIZE / 2);
      return;
    }

    for (let y = 0; y < maze.length; y++)
      for (let x = 0; x < (maze[y]?.length || 0); x++) {
        ctx.fillStyle = maze[y][x] === 1 ? "#2d2d5e" : "#0f0f23";
        ctx.fillRect(x * CS, y * CS, CS, CS);
      }

    ctx.strokeStyle = "#1a1a3a"; ctx.lineWidth = 0.3;
    for (let i = 0; i <= GRID_SIZE; i++) {
      ctx.beginPath(); ctx.moveTo(i * CS, 0); ctx.lineTo(i * CS, CANVAS_SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * CS); ctx.lineTo(CANVAS_SIZE, i * CS); ctx.stroke();
    }

    if (gameState.game_mode === "koth" && flag_position?.length === 2) {
      // Draw 3x3 hill zone around flag position
      const hx = flag_position[0], hy = flag_position[1];
      ctx.fillStyle = "rgba(251, 191, 36, 0.15)";
      ctx.strokeStyle = "rgba(251, 191, 36, 0.5)";
      ctx.lineWidth = 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = (hx + dx) * CS, cy = (hy + dy) * CS;
          ctx.fillRect(cx, cy, CS, CS);
        }
      }
      ctx.strokeRect((hx - 1) * CS, (hy - 1) * CS, CS * 3, CS * 3);
      // Crown icon at center
      ctx.fillStyle = "#fbbf24";
      ctx.font = `${CS}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("♛", hx * CS + CS / 2, hy * CS + CS / 2);
    } else if (gameState.game_mode !== "battle_royale" && flag_position?.length === 2) {
      // CTF: draw flag
      const fx = flag_position[0] * CS, fy = flag_position[1] * CS;
      ctx.fillStyle = "#fbbf24";
      ctx.fillRect(fx + 1, fy + 1, 2, CS - 2);
      ctx.beginPath(); ctx.moveTo(fx + 3, fy + 1); ctx.lineTo(fx + CS - 1, fy + CS / 3); ctx.lineTo(fx + 3, fy + CS / 2); ctx.closePath(); ctx.fill();
    }

    for (const player of players) {
      if (!player.alive) continue;
      const tx = player.x * CS, ty = player.y * CS;
      ctx.fillStyle = player.color || "#3b82f6";
      ctx.fillRect(tx + 1, ty + 1, CS - 2, CS - 2);
      ctx.fillStyle = "#ffffff";
      const cx = tx + CS / 2, cy = ty + CS / 2;
      switch (player.direction) {
        case "north": ctx.fillRect(cx - 1, ty, 2, CS / 2); break;
        case "south": ctx.fillRect(cx - 1, cy, 2, CS / 2); break;
        case "east":  ctx.fillRect(cx, cy - 1, CS / 2, 2); break;
        case "west":  ctx.fillRect(tx, cy - 1, CS / 2, 2); break;
      }
      for (let h = 0; h < player.health; h++) {
        ctx.fillStyle = "#22c55e";
        ctx.fillRect(tx + 1 + h * 3, ty - 3, 2, 2);
      }
    }

    ctx.fillStyle = "#f97316";
    for (const bullet of bullets) {
      ctx.beginPath();
      ctx.arc(bullet.x * CS + CS / 2, bullet.y * CS + CS / 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (status === "finished") {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      ctx.fillStyle = "#fbbf24";
      ctx.font = "bold 20px monospace";
      ctx.textAlign = "center";
      ctx.fillText(gameState.winner ? `Winner: ${gameState.winner}` : "Game Over!", CANVAS_SIZE / 2, CANVAS_SIZE / 2);
    }
  }, [gameState]);

  const handleNewGame = async () => {
    if (!roomId) return;
    if (!showSettings) {
      setShowSettings(true);
      return;
    }
    try {
      const { game_id } = await apiNewTankWarGame(roomId, { game_mode: settingsMode, max_ticks: settingsTicks });
      const hp = settingsMode === "battle_royale" ? 1 : 3;
      setGameState({
        game_id, status: "lobby", grid_size: GRID_SIZE, max_ticks: settingsTicks, current_tick: 0,
        maze: [], players: [{
          user_id: state.userId || "", ready: false, x: 1, y: 1,
          direction: "east", health: hp, alive: true, color: "#ef4444", score: 0, has_script: false, hill_ticks: 0,
        }],
        bullets: [], flag_position: [32, 32], winner: null, resetVotes: 0, resetTotal: 0, myResetVote: false,
        game_mode: settingsMode,
      });
      setScriptSubmitted(false);
      setEditorSize(220);
      setShowSettings(false);
    } catch (err: any) {
      console.error("Failed to create game:", err.message);
    }
  };

  const handleSubmitScript = () => {
    if (!roomId || !gameState.game_id) return;
    sendWs({ type: "tankwar_submit_script", room_id: roomId, script });
  };

  const handleReady = () => {
    if (!roomId) return;
    const me = gameState.players.find((p) => p.user_id === state.userId);
    if (me?.ready) sendWs({ type: "tankwar_unready", room_id: roomId });
    else sendWs({ type: "tankwar_ready", room_id: roomId });
  };

  const handleVoteReset = () => {
    if (!roomId) return;
    sendWs({ type: "tankwar_vote_reset", room_id: roomId });
  };

  const myPlayer = gameState.players.find((p) => p.user_id === state.userId);
  const isRunning = gameState.status === "running";
  const isFinished = gameState.status === "finished";
  const isLobby = gameState.status === "lobby";

  const posIcons: Record<EditorPosition, typeof PanelBottom> = { bottom: PanelBottom, top: PanelTop, left: PanelLeft, right: PanelRight };
  const nextPos: Record<EditorPosition, EditorPosition> = { bottom: "right", right: "top", top: "left", left: "bottom" };

  // ─── Shared sub-components ──────────────────────────────────────────────────

  const canvasPanel = (
    <div className="flex-1 min-h-0 min-w-0 overflow-auto">
      <div className="flex items-center justify-center h-full w-full p-2">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="rounded-md border border-border"
          style={{ imageRendering: "pixelated", width: CANVAS_SIZE * zoom, height: CANVAS_SIZE * zoom }}
        />
      </div>
    </div>
  );

  const dragHandle = isVertical ? (
    <div
      onMouseDown={onDragStart}
      className="shrink-0 flex items-center justify-center h-2 cursor-ns-resize hover:bg-accent/60 bg-border/50 select-none"
    >
      <GripHorizontal className="w-4 h-4 text-muted-foreground pointer-events-none" />
    </div>
  ) : (
    <div
      onMouseDown={onDragStart}
      className="shrink-0 flex items-center justify-center w-2 cursor-ew-resize hover:bg-accent/60 bg-border/50 select-none"
    >
      <GripVertical className="w-4 h-4 text-muted-foreground pointer-events-none" />
    </div>
  );

  const editorPanel = (
    <div
      className={`shrink-0 flex flex-col bg-background overflow-hidden ${
        isVertical ? "border-t border-border" : "border-l border-border"
      }`}
      style={isVertical ? { height: editorSize } : { width: editorSize }}
    >
      {editorSize > 36 ? (
        <>
          <div className="flex-1 min-h-0">
            <Editor
              height="100%"
              language="lua"
              theme="vs-dark"
              value={script}
              onChange={(v) => setScript(v || "")}
              options={{
                minimap: { enabled: false }, fontSize: 13, lineNumbers: "on",
                scrollBeyondLastLine: false, readOnly: isRunning, wordWrap: "on", automaticLayout: true,
              }}
            />
          </div>
          {isLobby && (
            <div className="flex items-center gap-2 border-t border-border px-4 py-2 shrink-0">
              <button onClick={handleSubmitScript} className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer">
                {scriptSubmitted ? "Update Script" : "Submit Script"}
              </button>
              <button onClick={handleReady} disabled={!scriptSubmitted}
                className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${myPlayer?.ready ? "bg-green-600 text-white hover:bg-green-700" : "bg-muted text-muted-foreground hover:bg-accent"} ${!scriptSubmitted ? "opacity-50 cursor-not-allowed" : ""}`}>
                {myPlayer?.ready ? "Ready \u2713" : "Ready"}
              </button>
              <span className="text-xs text-muted-foreground ml-auto">
                {gameState.players.filter((p) => p.ready).length}/{gameState.players.length} ready
              </span>
            </div>
          )}
          {isFinished && gameState.winner && (
            <div className="border-t border-border px-4 py-3 text-center">
              <p className="text-sm font-semibold text-yellow-400">
                Winner: {gameState.winner.replace("@", "").split(":")[0]}
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center h-full w-full text-xs text-muted-foreground">
          {isVertical ? "Drag up to open editor" : "Drag to open editor"}
        </div>
      )}
    </div>
  );

  // ─── Render ─────────────────────────────────────────────────────────────────

  const PosIcon = posIcons[editorPos];

  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0 relative">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0 z-10 bg-background">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Tank Wars</h2>
          {gameState.game_mode !== "ctf" && gameState.status !== "none" && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-accent text-accent-foreground">
              {gameState.game_mode === "battle_royale" ? "Battle Royale" : "King of the Hill"}
            </span>
          )}
          {isRunning && (
            <span className="text-xs text-muted-foreground">
              Tick: {gameState.current_tick}/{gameState.max_ticks}
            </span>
          )}
          {gameState.players.length > 0 && (
            <div className="flex items-center gap-3 ml-2">
              {gameState.players.map((p) => (
                <div key={p.user_id} className="flex items-center gap-1.5 text-xs" style={{ opacity: p.alive ? 1 : 0.4 }}>
                  <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
                  <span className="text-foreground font-medium">{p.user_id.replace("@", "").split(":")[0]}</span>
                  <span className="text-muted-foreground">{"♥".repeat(p.health)}{"♡".repeat(Math.max(0, (gameState.game_mode === "battle_royale" ? 1 : 3) - p.health))}</span>
                  {(isRunning || isFinished) && <span className="text-muted-foreground">{p.score}pts</span>}
                  {gameState.game_mode === "koth" && (isRunning || isFinished) && (
                    <span className="text-yellow-400 font-mono">♛{p.hill_ticks || 0}/20</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Zoom controls */}
          <button onClick={zoomOut} disabled={zoom <= ZOOM_LEVELS[0]} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer" title="Zoom out">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={zoomIn} disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer" title="Zoom in">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          {/* Editor position toggle */}
          <button
            onClick={() => setEditorPos((p) => nextPos[p])}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer"
            title={`Editor: ${editorPos}`}
          >
            <PosIcon className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          {(isRunning || isLobby) && (
            <button onClick={handleVoteReset} disabled={gameState.myResetVote}
              className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer ${gameState.myResetVote ? "bg-red-900/40 text-red-400/60 cursor-not-allowed" : "bg-red-600/20 text-red-400 hover:bg-red-600/30"}`}>
              {gameState.myResetVote ? `Voted Reset (${gameState.resetVotes}/${gameState.resetTotal})` : gameState.resetVotes > 0 ? `Vote Reset (${gameState.resetVotes}/${gameState.resetTotal})` : "Vote Reset"}
            </button>
          )}
          {(gameState.status === "none" || isFinished) && showSettings && (
            <div className="flex items-center gap-2 mr-1">
              <select
                value={settingsMode}
                onChange={(e) => setSettingsMode(e.target.value)}
                className="text-xs bg-muted border border-border rounded px-1.5 py-1 text-foreground"
              >
                <option value="ctf">Capture the Flag</option>
                <option value="battle_royale">Battle Royale</option>
                <option value="koth">King of the Hill</option>
              </select>
              <input
                type="number"
                value={settingsTicks}
                onChange={(e) => setSettingsTicks(Math.max(100, Math.min(10000, Number(e.target.value) || 1000)))}
                className="text-xs bg-muted border border-border rounded px-1.5 py-1 w-16 text-foreground"
                title="Max ticks"
              />
              <span className="text-xs text-muted-foreground">ticks</span>
              <button onClick={() => setShowSettings(false)} className="text-xs text-muted-foreground hover:text-foreground cursor-pointer">✕</button>
            </div>
          )}
          {(gameState.status === "none" || isFinished) && (
            <button onClick={handleNewGame} className="px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer">
              {showSettings ? "Start" : isFinished ? "Play Again" : "New Game"}
            </button>
          )}
        </div>
      </div>

      {/* Main area — flex direction depends on editor position */}
      <div ref={wrapperRef} className={`flex-1 min-h-0 min-w-0 flex ${isVertical ? "flex-col" : "flex-row"}`}>
        {editorPos === "top" || editorPos === "left" ? (
          <>{editorPanel}{dragHandle}{canvasPanel}</>
        ) : (
          <>{canvasPanel}{dragHandle}{editorPanel}</>
        )}
      </div>
    </div>
  );
}
