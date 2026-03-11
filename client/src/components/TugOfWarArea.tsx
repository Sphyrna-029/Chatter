import { useState, useEffect, useRef, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetTugOfWarState, apiNewTugOfWarGame } from "@/lib/api";
import { displayUserId } from "@/lib/utils";

interface TugPlayer {
  user_id: string;
  team: string;
  ready: boolean;
  chars_correct: number;
  errors: number;
  wps: number;
}

interface GameState {
  game_id: string | null;
  status: "none" | "lobby" | "running" | "finished";
  players: TugPlayer[];
  rope_position: number;
  prompt: string;
  started_at: number | null;
  winner: string | null;
  left_wps: number;
  right_wps: number;
  reset_votes: number;
  reset_total: number;
  my_reset_vote: boolean;
}

const LEFT_COLOR = "#ef4444";
const RIGHT_COLOR = "#3b82f6";

function RopeVisualizer({ position }: { position: number }) {
  // position: -100 (left wins) to +100 (right wins)
  // normalized to 0-100% for display
  const pct = ((position + 100) / 200) * 100;
  const winLeft = pct <= 25;
  const winRight = pct >= 75;

  return (
    <div className="w-full px-4 py-3 select-none">
      <div className="flex justify-between text-xs font-bold mb-1.5">
        <span style={{ color: LEFT_COLOR }}>Left Team</span>
        <span style={{ color: RIGHT_COLOR }}>Right Team</span>
      </div>
      <div className="relative h-8 rounded-full overflow-hidden bg-muted border border-border">
        {/* Win zone indicators */}
        <div className="absolute left-0 top-0 bottom-0 w-1/4 rounded-l-full opacity-20" style={{ background: LEFT_COLOR }} />
        <div className="absolute right-0 top-0 bottom-0 w-1/4 rounded-r-full opacity-20" style={{ background: RIGHT_COLOR }} />
        {/* Rope fill - gradient from left to right */}
        <div
          className="absolute inset-0 opacity-30"
          style={{
            background: `linear-gradient(to right, ${LEFT_COLOR}, ${RIGHT_COLOR})`,
          }}
        />
        {/* Center marker */}
        <div className="absolute top-0 bottom-0 w-0.5 bg-border/70" style={{ left: "50%" }} />
        {/* Threshold markers */}
        <div className="absolute top-0 bottom-0 w-0.5 bg-white/30" style={{ left: "25%" }} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-white/30" style={{ left: "75%" }} />
        {/* Rope knot */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 border-white shadow-lg transition-all duration-300 flex items-center justify-center text-xs font-bold"
          style={{
            left: `clamp(14px, calc(${pct}% - 14px), calc(100% - 14px))`,
            background: winLeft ? LEFT_COLOR : winRight ? RIGHT_COLOR : "#888",
            boxShadow: `0 0 8px 2px ${winLeft ? LEFT_COLOR : winRight ? RIGHT_COLOR : "transparent"}`,
          }}
        >
          <span className="text-white text-[9px]">⚡</span>
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
        <span>Win zone</span>
        <span>Win zone</span>
      </div>
    </div>
  );
}

function TypingArea({
  prompt,
  onProgress,
}: {
  prompt: string;
  onProgress: (charsCorrect: number, errors: number) => void;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const totalCharsRef = useRef(0); // cumulative correct chars across loops

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      // Calculate errors: positions where typed doesn't match prompt
      const currentPromptSection = prompt.substring(0, val.length);
      let errors = 0;
      for (let i = 0; i < val.length; i++) {
        if (val[i] !== currentPromptSection[i]) errors++;
      }

      // Chars correct = longest error-free prefix
      let charsCorrect = 0;
      for (let i = 0; i < val.length; i++) {
        if (val[i] === prompt[i]) charsCorrect++;
        else break;
      }

      // Check if prompt completed (all chars typed correctly)
      if (val === prompt) {
        // Loop: add prompt length to total, reset input
        totalCharsRef.current += prompt.length;
        setTyped("");
        onProgress(totalCharsRef.current, 0);
        return;
      }

      setTyped(val);
      onProgress(totalCharsRef.current + charsCorrect, errors);
    },
    [prompt, onProgress]
  );

  // Render prompt with character coloring
  const renderPrompt = () => {
    return prompt.split("").map((char, i) => {
      let color = "text-muted-foreground";
      if (i < typed.length) {
        color = typed[i] === char ? "text-green-400" : "text-red-400";
      } else if (i === typed.length) {
        color = "text-foreground";
      }
      const isCursor = i === typed.length;
      return (
        <span
          key={i}
          className={`${color} relative ${isCursor ? "border-l-2 border-white/80 animate-pulse" : ""}`}
        >
          {char === " " && i < typed.length && typed[i] !== " " ? (
            <span className="bg-red-500/30">&nbsp;</span>
          ) : (
            char
          )}
        </span>
      );
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        className="font-mono text-lg leading-relaxed p-4 rounded-lg bg-muted border border-border cursor-text select-none tracking-wide"
        onClick={() => inputRef.current?.focus()}
      >
        {renderPrompt()}
        {typed.length >= prompt.length && (
          <span className="text-green-400 ml-1 text-sm">↩ looping…</span>
        )}
      </div>
      <input
        ref={inputRef}
        value={typed}
        onChange={handleChange}
        className="opacity-0 absolute pointer-events-none"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground text-center">
        Click above to focus · Type the prompt · When done it loops automatically
      </p>
    </div>
  );
}

interface TugOfWarAreaProps {
  onJoinVoice?: () => void;
}

export function TugOfWarArea({ onJoinVoice: _onJoinVoice }: TugOfWarAreaProps) {
  const { state, wsRef } = useAppContext();
  const roomId = state.currentRoomId;
  const userId = state.userId;

  const [gameState, setGameState] = useState<GameState>({
    game_id: null,
    status: "none",
    players: [],
    rope_position: 0,
    prompt: "",
    started_at: null,
    winner: null,
    left_wps: 0,
    right_wps: 0,
    reset_votes: 0,
    reset_total: 0,
    my_reset_vote: false,
  });

  const [loading, setLoading] = useState(true);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef<{ charsCorrect: number; errors: number }>({ charsCorrect: 0, errors: 0 });

  const sendWs = useCallback(
    (msg: Record<string, unknown>) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    [wsRef]
  );

  // Load initial state
  useEffect(() => {
    if (!roomId) return;
    setLoading(true);
    apiGetTugOfWarState(roomId)
      .then((data) => {
        if (data.status !== "none") {
          setGameState((prev) => ({
            ...prev,
            game_id: data.game_id,
            status: data.status,
            players: data.players || [],
            rope_position: data.rope_position ?? 0,
            prompt: data.prompt || "",
            started_at: data.started_at ?? null,
            winner: data.winner ?? null,
          }));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [roomId]);

  // Send progress updates every 200ms during game
  useEffect(() => {
    if (gameState.status !== "running" || !roomId || !gameState.game_id) return;

    progressIntervalRef.current = setInterval(() => {
      sendWs({
        type: "tugofwar_progress",
        room_id: roomId,
        game_id: gameState.game_id,
        chars_correct: progressRef.current.charsCorrect,
        errors: progressRef.current.errors,
      });
    }, 200);

    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, [gameState.status, gameState.game_id, roomId, sendWs]);

  // WS event handlers
  useEffect(() => {
    const onGameCreated = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({
        ...prev,
        game_id: d.game_id,
        status: "lobby",
        players: d.players || [],
        rope_position: 0,
        prompt: d.prompt || "",
        started_at: null,
        winner: null,
        left_wps: 0,
        right_wps: 0,
        reset_votes: 0,
        reset_total: 0,
        my_reset_vote: false,
      }));
    };
    const onPlayerUpdate = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({ ...prev, game_id: d.game_id, players: d.players }));
    };
    const onGameStarted = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      progressRef.current = { charsCorrect: 0, errors: 0 };
      setGameState((prev) => ({
        ...prev,
        game_id: d.game_id,
        status: "running",
        prompt: d.prompt,
        started_at: d.started_at,
        players: d.players || prev.players,
        rope_position: 0,
        winner: null,
        left_wps: 0,
        right_wps: 0,
        reset_votes: 0,
        reset_total: 0,
        my_reset_vote: false,
      }));
    };
    const onRopeUpdate = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({
        ...prev,
        rope_position: d.rope_position,
        left_wps: d.left_wps,
        right_wps: d.right_wps,
        players: d.players
          ? d.players.map((p: TugPlayer) => {
              const existing = prev.players.find((ep) => ep.user_id === p.user_id);
              return existing ? { ...existing, ...p } : p;
            })
          : prev.players,
      }));
    };
    const onGameOver = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({ ...prev, status: "finished", winner: d.winner }));
    };
    const onResetVote = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({
        ...prev,
        reset_votes: d.vote_count,
        reset_total: d.votes_needed,
        my_reset_vote: d.user_id === userId ? true : prev.my_reset_vote,
      }));
    };
    const onGameReset = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.room_id !== roomId) return;
      setGameState((prev) => ({
        ...prev,
        status: "finished",
        winner: null,
        reset_votes: 0,
        reset_total: 0,
        my_reset_vote: false,
      }));
    };

    const events = [
      ["tugofwar_game_created", onGameCreated],
      ["tugofwar_player_update", onPlayerUpdate],
      ["tugofwar_game_started", onGameStarted],
      ["tugofwar_rope_update", onRopeUpdate],
      ["tugofwar_game_over", onGameOver],
      ["tugofwar_reset_vote", onResetVote],
      ["tugofwar_game_reset", onGameReset],
    ] as const;
    for (const [name, fn] of events) window.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of events) window.removeEventListener(name, fn);
    };
  }, [roomId, userId]);

  const myPlayer = gameState.players.find((p) => p.user_id === userId);
  const leftPlayers = gameState.players.filter((p) => p.team === "left");
  const rightPlayers = gameState.players.filter((p) => p.team === "right");
  const unassigned = gameState.players.filter((p) => !p.team);

  const handleNewGame = async () => {
    if (!roomId) return;
    try {
      await apiNewTugOfWarGame(roomId);
    } catch {}
  };

  const handleJoinTeam = (team: "left" | "right") => {
    if (!roomId || !gameState.game_id) return;
    sendWs({ type: "tugofwar_join_team", room_id: roomId, game_id: gameState.game_id, team });
  };

  const handleLeaveTeam = () => {
    if (!roomId || !gameState.game_id) return;
    sendWs({ type: "tugofwar_leave_team", room_id: roomId, game_id: gameState.game_id });
  };

  const handleReady = () => {
    if (!roomId || !gameState.game_id) return;
    sendWs({ type: "tugofwar_ready", room_id: roomId, game_id: gameState.game_id });
  };

  const handleUnready = () => {
    if (!roomId || !gameState.game_id) return;
    sendWs({ type: "tugofwar_unready", room_id: roomId, game_id: gameState.game_id });
  };

  const handleVoteReset = () => {
    if (!roomId || !gameState.game_id) return;
    sendWs({ type: "tugofwar_vote_reset", room_id: roomId, game_id: gameState.game_id });
  };

  const handleProgress = useCallback((charsCorrect: number, errors: number) => {
    progressRef.current = { charsCorrect, errors };
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  // ─── No game ──────────────────────────────────────────────────────────────
  if (gameState.status === "none") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-1">Tug of War</h2>
          <p className="text-muted-foreground text-sm">
            Two teams race to out-type each other. Higher WPS pulls the rope to your side!
          </p>
        </div>
        <button
          onClick={handleNewGame}
          className="px-6 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
        >
          Create Game
        </button>
      </div>
    );
  }

  // ─── Lobby ────────────────────────────────────────────────────────────────
  if (gameState.status === "lobby") {
    const canReady = !!myPlayer?.team && !myPlayer.ready;
    const isReady = !!myPlayer?.ready;

    return (
      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 gap-4">
        <div className="text-center">
          <h2 className="text-xl font-bold">Tug of War — Lobby</h2>
          <p className="text-xs text-muted-foreground mt-1">Pick a team and ready up. Game starts when all players on both teams are ready.</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {/* Left Team */}
          <div className="rounded-xl border p-3 flex flex-col gap-2" style={{ borderColor: `${LEFT_COLOR}55` }}>
            <div className="text-sm font-bold text-center" style={{ color: LEFT_COLOR }}>
              🔴 Left Team
            </div>
            <div className="text-xs text-muted-foreground text-center">{gameState.left_wps.toFixed(2)} WPS avg</div>
            <div className="flex flex-col gap-1 min-h-[60px]">
              {leftPlayers.map((p) => (
                <div key={p.user_id} className="flex items-center gap-1.5 text-xs">
                  <span className={p.ready ? "text-green-400" : "text-muted-foreground"}>
                    {p.ready ? "✓" : "○"}
                  </span>
                  <span className="truncate">{displayUserId(p.user_id)}</span>
                </div>
              ))}
            </div>
            {myPlayer?.team !== "left" && (
              <button
                onClick={() => handleJoinTeam("left")}
                className="text-xs px-3 py-1.5 rounded-md border transition-colors hover:bg-red-500/10"
                style={{ borderColor: `${LEFT_COLOR}66`, color: LEFT_COLOR }}
              >
                Join Left
              </button>
            )}
          </div>

          {/* Center — unassigned + status */}
          <div className="flex flex-col items-center justify-center gap-3">
            <div className="text-2xl select-none">🪢</div>
            <div className="text-xs text-muted-foreground text-center">
              {unassigned.length > 0 && (
                <span>{unassigned.length} spectating</span>
              )}
            </div>
            {myPlayer?.team && (
              <div className="flex flex-col items-center gap-2 w-full">
                {isReady ? (
                  <button
                    onClick={handleUnready}
                    className="w-full text-xs px-3 py-1.5 rounded-md bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/30 transition-colors"
                  >
                    Unready
                  </button>
                ) : (
                  <button
                    onClick={handleReady}
                    disabled={!canReady}
                    className="w-full text-xs px-3 py-1.5 rounded-md bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 transition-colors disabled:opacity-40"
                  >
                    Ready!
                  </button>
                )}
                <button
                  onClick={handleLeaveTeam}
                  className="w-full text-xs px-3 py-1.5 rounded-md text-muted-foreground border border-border hover:bg-muted transition-colors"
                >
                  Leave team
                </button>
              </div>
            )}
          </div>

          {/* Right Team */}
          <div className="rounded-xl border p-3 flex flex-col gap-2" style={{ borderColor: `${RIGHT_COLOR}55` }}>
            <div className="text-sm font-bold text-center" style={{ color: RIGHT_COLOR }}>
              🔵 Right Team
            </div>
            <div className="text-xs text-muted-foreground text-center">{gameState.right_wps.toFixed(2)} WPS avg</div>
            <div className="flex flex-col gap-1 min-h-[60px]">
              {rightPlayers.map((p) => (
                <div key={p.user_id} className="flex items-center gap-1.5 text-xs">
                  <span className={p.ready ? "text-green-400" : "text-muted-foreground"}>
                    {p.ready ? "✓" : "○"}
                  </span>
                  <span className="truncate">{displayUserId(p.user_id)}</span>
                </div>
              ))}
            </div>
            {myPlayer?.team !== "right" && (
              <button
                onClick={() => handleJoinTeam("right")}
                className="text-xs px-3 py-1.5 rounded-md border transition-colors hover:bg-blue-500/10"
                style={{ borderColor: `${RIGHT_COLOR}66`, color: RIGHT_COLOR }}
              >
                Join Right
              </button>
            )}
          </div>
        </div>

        {!myPlayer && (
          <div className="text-center text-xs text-muted-foreground">
            Join a team above to participate
          </div>
        )}
      </div>
    );
  }

  // ─── Running ──────────────────────────────────────────────────────────────
  if (gameState.status === "running") {
    const myTeam = myPlayer?.team;
    const myWps = myPlayer?.wps?.toFixed(2) ?? "0.00";

    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Rope */}
        <RopeVisualizer position={gameState.rope_position} />

        {/* Team WPS bars */}
        <div className="flex justify-between px-4 mb-3 gap-3">
          <div className="flex-1 text-center">
            <div className="text-xs font-medium mb-1" style={{ color: LEFT_COLOR }}>
              Left — {gameState.left_wps.toFixed(2)} WPS
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.min(gameState.left_wps * 50, 100)}%`, background: LEFT_COLOR }}
              />
            </div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-xs font-medium mb-1" style={{ color: RIGHT_COLOR }}>
              Right — {gameState.right_wps.toFixed(2)} WPS
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300 ml-auto"
                style={{ width: `${Math.min(gameState.right_wps * 50, 100)}%`, background: RIGHT_COLOR }}
              />
            </div>
          </div>
        </div>

        {/* Players list */}
        <div className="flex gap-2 px-4 mb-3 overflow-x-auto pb-1">
          {gameState.players
            .filter((p) => p.team)
            .sort((a, b) => b.wps - a.wps)
            .map((p) => (
              <div
                key={p.user_id}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border shrink-0"
                style={{
                  borderColor: p.team === "left" ? `${LEFT_COLOR}55` : `${RIGHT_COLOR}55`,
                  color: p.team === "left" ? LEFT_COLOR : RIGHT_COLOR,
                  background: p.team === "left" ? `${LEFT_COLOR}10` : `${RIGHT_COLOR}10`,
                }}
              >
                <span className="font-medium truncate max-w-[80px]">{displayUserId(p.user_id)}</span>
                <span className="opacity-70">{p.wps.toFixed(2)} wps</span>
              </div>
            ))}
        </div>

        {/* Typing area */}
        <div className="flex-1 flex flex-col px-4 pb-4 gap-3 min-h-0 overflow-y-auto">
          <div className="text-center text-xs text-muted-foreground">
            You're on the{" "}
            <span className="font-medium" style={{ color: myTeam === "left" ? LEFT_COLOR : RIGHT_COLOR }}>
              {myTeam} team
            </span>{" "}
            · Your WPS: <span className="font-mono font-medium text-foreground">{myWps}</span>
          </div>

          {myTeam ? (
            <TypingArea prompt={gameState.prompt} onProgress={handleProgress} />
          ) : (
            <div className="text-center text-muted-foreground text-sm py-8">
              You're spectating this game.
            </div>
          )}

          {/* Reset vote */}
          <div className="flex justify-center mt-2">
            <button
              onClick={handleVoteReset}
              disabled={gameState.my_reset_vote}
              className="text-xs px-4 py-1.5 rounded-md text-muted-foreground border border-border hover:bg-muted transition-colors disabled:opacity-40"
            >
              {gameState.my_reset_vote
                ? `Vote to reset (${gameState.reset_votes}/${gameState.reset_total})`
                : "Vote to reset"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Finished ─────────────────────────────────────────────────────────────
  const winnerColor =
    gameState.winner === "left" ? LEFT_COLOR : gameState.winner === "right" ? RIGHT_COLOR : "#888";
  const winnerLabel =
    gameState.winner === "left"
      ? "🔴 Left Team Wins!"
      : gameState.winner === "right"
      ? "🔵 Right Team Wins!"
      : "It's a Draw!";

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <div className="text-4xl font-bold mb-2" style={{ color: winnerColor }}>
          {winnerLabel}
        </div>
        <div className="text-muted-foreground text-sm">
          Final rope position: {gameState.rope_position.toFixed(1)}
        </div>
      </div>

      {/* Final scores */}
      <div className="grid grid-cols-2 gap-4 w-full max-w-sm">
        {(["left", "right"] as const).map((team) => {
          const teamPlayers = gameState.players.filter((p) => p.team === team);
          const avgWps = teamPlayers.length
            ? (teamPlayers.reduce((s, p) => s + p.wps, 0) / teamPlayers.length).toFixed(2)
            : "0.00";
          const color = team === "left" ? LEFT_COLOR : RIGHT_COLOR;
          return (
            <div
              key={team}
              className="rounded-xl border p-3 text-center"
              style={{ borderColor: `${color}55`, background: `${color}08` }}
            >
              <div className="font-bold text-sm mb-1 capitalize" style={{ color }}>
                {team} Team
              </div>
              <div className="text-xs text-muted-foreground">{avgWps} WPS avg</div>
              {teamPlayers.map((p) => (
                <div key={p.user_id} className="text-xs mt-1 truncate">
                  {displayUserId(p.user_id)} — {p.wps.toFixed(2)} wps
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleNewGame}
          className="px-5 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors"
        >
          New Game
        </button>
        <button
          onClick={handleVoteReset}
          disabled={gameState.my_reset_vote}
          className="px-5 py-2 rounded-lg border border-border text-sm hover:bg-muted transition-colors disabled:opacity-40"
        >
          {gameState.my_reset_vote
            ? `Vote to reset (${gameState.reset_votes}/${gameState.reset_total})`
            : "Vote to reset"}
        </button>
      </div>
    </div>
  );
}
