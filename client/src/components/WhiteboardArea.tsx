import { useState, useEffect, useRef, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetWhiteboardStrokes, type WhiteboardStroke } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  Pen,
  Eraser,
  Minus,
  Square,
  Circle,
  PaintBucket,
  Undo2,
  Trash2,
  Loader2,
} from "lucide-react";

type Tool = "pen" | "eraser" | "line" | "rect" | "circle" | "fill";

interface CursorInfo {
  x: number;
  y: number;
  userId: string;
  lastSeen: number;
}

const CANVAS_W = 2000;
const CANVAS_H = 2000;
const CURSOR_FADE_MS = 3000;
const CURSOR_THROTTLE_MS = 50;

const TOOL_ITEMS: { tool: Tool; icon: typeof Pen; label: string }[] = [
  { tool: "pen", icon: Pen, label: "Pen" },
  { tool: "eraser", icon: Eraser, label: "Eraser" },
  { tool: "line", icon: Minus, label: "Line" },
  { tool: "rect", icon: Square, label: "Rectangle" },
  { tool: "circle", icon: Circle, label: "Ellipse" },
  { tool: "fill", icon: PaintBucket, label: "Fill" },
];

const PRESET_COLORS = [
  "#000000", "#ffffff", "#ef4444", "#f97316", "#eab308",
  "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280",
];

// ─── Pure drawing helper (no hooks, no state) ───────────────────────────────

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function drawStrokeToCtx(ctx: Ctx2D, stroke: WhiteboardStroke) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = "source-over";

  if (stroke.tool === "eraser") {
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
  } else {
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
  }
  ctx.lineWidth = stroke.width;

  const pts = stroke.points;
  if (!pts || pts.length === 0) return;

  switch (stroke.tool) {
    case "pen":
    case "eraser": {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0], pts[i][1]);
      }
      ctx.stroke();
      break;
    }
    case "fill": {
      if (pts.length >= 1) {
        const px = Math.floor(pts[0][0]);
        const py = Math.floor(pts[0][1]);
        const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
        const data = imageData.data;

        const targetIdx = (py * CANVAS_W + px) * 4;
        const tR = data[targetIdx], tG = data[targetIdx + 1], tB = data[targetIdx + 2], tA = data[targetIdx + 3];
        const fR = parseInt(stroke.color.slice(1, 3), 16);
        const fG = parseInt(stroke.color.slice(3, 5), 16);
        const fB = parseInt(stroke.color.slice(5, 7), 16);

        if (!(tR === fR && tG === fG && tB === fB && tA === 255)) {
          const stack = [[px, py]];
          const visited = new Uint8Array(CANVAS_W * CANVAS_H);

          while (stack.length > 0) {
            const [cx, cy] = stack.pop()!;
            if (cx < 0 || cx >= CANVAS_W || cy < 0 || cy >= CANVAS_H) continue;
            const ci = cy * CANVAS_W + cx;
            if (visited[ci]) continue;
            const idx = ci * 4;
            if (data[idx] !== tR || data[idx + 1] !== tG || data[idx + 2] !== tB || data[idx + 3] !== tA) continue;

            visited[ci] = 1;
            data[idx] = fR;
            data[idx + 1] = fG;
            data[idx + 2] = fB;
            data[idx + 3] = 255;

            stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
          }
          ctx.putImageData(imageData, 0, 0);
        }
      }
      break;
    }
    case "line": {
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        ctx.stroke();
      }
      break;
    }
    case "rect": {
      if (pts.length >= 2) {
        const x = Math.min(pts[0][0], pts[1][0]);
        const y = Math.min(pts[0][1], pts[1][1]);
        const w = Math.abs(pts[1][0] - pts[0][0]);
        const h = Math.abs(pts[1][1] - pts[0][1]);
        if (stroke.fill) {
          ctx.fillRect(x, y, w, h);
        } else {
          ctx.strokeRect(x, y, w, h);
        }
      }
      break;
    }
    case "circle": {
      if (pts.length >= 2) {
        const cx = (pts[0][0] + pts[1][0]) / 2;
        const cy = (pts[0][1] + pts[1][1]) / 2;
        const rx = Math.abs(pts[1][0] - pts[0][0]) / 2;
        const ry = Math.abs(pts[1][1] - pts[0][1]) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        if (stroke.fill) {
          ctx.fill();
        } else {
          ctx.stroke();
        }
      }
      break;
    }
  }
}

/** Render all strokes to a context (with white bg). Used for full rebuilds. */
function renderAllStrokes(ctx: Ctx2D, strokes: WhiteboardStroke[]) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  for (const s of strokes) {
    drawStrokeToCtx(ctx, s);
  }
}

export function WhiteboardArea() {
  const { state, wsRef } = useAppContext();
  const roomId = state.currentRoomId;
  const userId = state.userId;

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#000000");
  const [width, setWidth] = useState(3);
  const [loading, setLoading] = useState(true);
  const [cursors, setCursors] = useState<Map<string, CursorInfo>>(new Map());

  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Offscreen buffer: holds the composited image of all committed strokes.
  // We draw new strokes incrementally onto this buffer instead of replaying all.
  const bufferRef = useRef<OffscreenCanvas | null>(null);
  // Track strokes for undo / full rebuild
  const strokesRef = useRef<WhiteboardStroke[]>([]);
  // How many strokes are already rendered in the buffer
  const renderedCountRef = useRef(0);
  // Mounted flag to skip work after unmount
  const mountedRef = useRef(true);

  const isDrawing = useRef(false);
  const currentPoints = useRef<number[][]>([]);
  const shapeStart = useRef<number[] | null>(null);
  const lastCursorSend = useRef(0);

  const isOwnerOrMod = state.roomMembers.some(
    (m) => m.userId === userId && (m.role === "owner" || m.role === "moderator")
  );

  // Ensure buffer exists
  const getBuffer = useCallback(() => {
    if (!bufferRef.current) {
      bufferRef.current = new OffscreenCanvas(CANVAS_W, CANVAS_H);
      const ctx = bufferRef.current.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }
    return bufferRef.current;
  }, []);

  // Blit the offscreen buffer onto the visible base canvas
  const blitToScreen = useCallback(() => {
    const canvas = baseCanvasRef.current;
    const buffer = bufferRef.current;
    if (!canvas || !buffer) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.drawImage(buffer, 0, 0);
  }, []);

  // Full rebuild of the buffer from the strokes array (used after undo/clear/load)
  const fullRebuild = useCallback((strokes: WhiteboardStroke[]) => {
    const buffer = getBuffer();
    const ctx = buffer.getContext("2d")!;
    renderAllStrokes(ctx, strokes);
    renderedCountRef.current = strokes.length;
    blitToScreen();
  }, [getBuffer, blitToScreen]);

  // Draw only the newly added strokes (incremental)
  const drawIncremental = useCallback((strokes: WhiteboardStroke[]) => {
    const buffer = getBuffer();
    const ctx = buffer.getContext("2d")!;
    const start = renderedCountRef.current;
    for (let i = start; i < strokes.length; i++) {
      drawStrokeToCtx(ctx, strokes[i]);
    }
    renderedCountRef.current = strokes.length;
    blitToScreen();
  }, [getBuffer, blitToScreen]);

  // Get canvas coordinates from mouse event
  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    return [
      (e.clientX - rect.left) * scaleX,
      (e.clientY - rect.top) * scaleY,
    ];
  }, []);

  // ─── Load strokes on mount / room change ────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    // Reset buffer for new room
    bufferRef.current = null;
    strokesRef.current = [];
    renderedCountRef.current = 0;
    setLoading(true);

    apiGetWhiteboardStrokes(roomId).then((res) => {
      if (cancelled || !mountedRef.current) return;
      strokesRef.current = res.strokes;
      fullRebuild(res.strokes);
    }).catch(() => {}).finally(() => {
      if (!cancelled && mountedRef.current) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [roomId, fullRebuild]);

  // ─── WS event listeners ─────────────────────────────────────────────────────

  useEffect(() => {
    const onStroke = (e: Event) => {
      if (!mountedRef.current) return;
      const detail = (e as CustomEvent).detail;
      if (detail.room_id !== roomId) return;
      const stroke = detail.stroke as WhiteboardStroke;
      if (stroke.user_id === userId) return;
      strokesRef.current = [...strokesRef.current, stroke];
      drawIncremental(strokesRef.current);
    };

    const onCursor = (e: Event) => {
      if (!mountedRef.current) return;
      const detail = (e as CustomEvent).detail;
      if (detail.room_id !== roomId || detail.user_id === userId) return;
      setCursors((prev) => {
        const next = new Map(prev);
        next.set(detail.user_id, {
          x: detail.x,
          y: detail.y,
          userId: detail.user_id,
          lastSeen: Date.now(),
        });
        return next;
      });
    };

    const onClear = (e: Event) => {
      if (!mountedRef.current) return;
      const detail = (e as CustomEvent).detail;
      if (detail.room_id !== roomId) return;
      strokesRef.current = [];
      fullRebuild([]);
    };

    const onUndo = (e: Event) => {
      if (!mountedRef.current) return;
      const detail = (e as CustomEvent).detail;
      if (detail.room_id !== roomId) return;
      if (detail.user_id === userId) return;
      strokesRef.current = strokesRef.current.filter((s) => s.stroke_id !== detail.stroke_id);
      fullRebuild(strokesRef.current);
    };

    window.addEventListener("whiteboard_stroke", onStroke);
    window.addEventListener("whiteboard_cursor", onCursor);
    window.addEventListener("whiteboard_clear", onClear);
    window.addEventListener("whiteboard_undo", onUndo);
    return () => {
      window.removeEventListener("whiteboard_stroke", onStroke);
      window.removeEventListener("whiteboard_cursor", onCursor);
      window.removeEventListener("whiteboard_clear", onClear);
      window.removeEventListener("whiteboard_undo", onUndo);
    };
  }, [roomId, userId, drawIncremental, fullRebuild]);

  // Fade out old cursors
  useEffect(() => {
    const interval = setInterval(() => {
      setCursors((prev) => {
        const now = Date.now();
        let changed = false;
        const next = new Map<string, CursorInfo>();
        prev.forEach((c, k) => {
          if (now - c.lastSeen < CURSOR_FADE_MS) {
            next.set(k, c);
          } else {
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // ─── Drawing handlers ──────────────────────────────────────────────────────

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, [wsRef]);

  const addStrokeLocal = useCallback((stroke: WhiteboardStroke) => {
    strokesRef.current = [...strokesRef.current, stroke];
    drawIncremental(strokesRef.current);
  }, [drawIncremental]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!roomId) return;
    const [x, y] = getCanvasPos(e);

    if (tool === "fill") {
      const fillStroke: WhiteboardStroke = {
        stroke_id: `local_${Date.now()}`,
        user_id: userId || "",
        tool: "fill",
        color,
        width: 0,
        points: [[x, y]],
        fill: true,
        timestamp: Date.now(),
      };
      addStrokeLocal(fillStroke);
      sendWs({
        type: "whiteboard_stroke",
        room_id: roomId,
        tool: "fill",
        color,
        width: 0,
        points: [[x, y]],
        fill: true,
      });
      return;
    }

    isDrawing.current = true;

    if (tool === "pen" || tool === "eraser") {
      currentPoints.current = [[x, y]];
    } else {
      shapeStart.current = [x, y];
    }
  }, [roomId, tool, color, getCanvasPos, userId, sendWs, addStrokeLocal]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!roomId) return;
    const [x, y] = getCanvasPos(e);

    // Throttled cursor broadcast
    const now = Date.now();
    if (now - lastCursorSend.current > CURSOR_THROTTLE_MS) {
      lastCursorSend.current = now;
      sendWs({ type: "whiteboard_cursor", room_id: roomId, x, y });
    }

    if (!isDrawing.current) return;

    const activeCanvas = activeCanvasRef.current;
    if (!activeCanvas) return;
    const ctx = activeCanvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    if (tool === "pen" || tool === "eraser") {
      currentPoints.current.push([x, y]);
      drawStrokeToCtx(ctx, {
        stroke_id: "", user_id: "", tool, color, width,
        points: currentPoints.current, fill: false, timestamp: 0,
      });
    } else if (shapeStart.current) {
      drawStrokeToCtx(ctx, {
        stroke_id: "", user_id: "", tool, color, width,
        points: [shapeStart.current, [x, y]], fill: false, timestamp: 0,
      });
    }
  }, [roomId, tool, color, width, getCanvasPos, sendWs]);

  const finishStroke = useCallback((points: number[][]) => {
    if (!roomId || points.length === 0) return;
    const localStroke: WhiteboardStroke = {
      stroke_id: `local_${Date.now()}`,
      user_id: userId || "",
      tool, color, width, points,
      fill: false,
      timestamp: Date.now(),
    };
    addStrokeLocal(localStroke);
    sendWs({
      type: "whiteboard_stroke",
      room_id: roomId,
      tool, color, width, points,
      fill: false,
    });
  }, [roomId, tool, color, width, userId, sendWs, addStrokeLocal]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current || !roomId) return;
    isDrawing.current = false;

    const [x, y] = getCanvasPos(e);

    const activeCanvas = activeCanvasRef.current;
    if (activeCanvas) {
      const ctx = activeCanvas.getContext("2d");
      ctx?.clearRect(0, 0, CANVAS_W, CANVAS_H);
    }

    let points: number[][];
    if (tool === "pen" || tool === "eraser") {
      points = currentPoints.current;
      currentPoints.current = [];
    } else if (shapeStart.current) {
      points = [shapeStart.current, [x, y]];
      shapeStart.current = null;
    } else {
      return;
    }

    finishStroke(points);
  }, [roomId, tool, getCanvasPos, finishStroke]);

  const handleUndo = useCallback(() => {
    if (!roomId || !userId) return;
    const idx = [...strokesRef.current].reverse().findIndex((s) => s.user_id === userId);
    if (idx === -1) return;
    const actualIdx = strokesRef.current.length - 1 - idx;
    strokesRef.current = [
      ...strokesRef.current.slice(0, actualIdx),
      ...strokesRef.current.slice(actualIdx + 1),
    ];
    fullRebuild(strokesRef.current);
    sendWs({ type: "whiteboard_undo", room_id: roomId });
  }, [roomId, userId, sendWs, fullRebuild]);

  const handleClear = useCallback(() => {
    if (!roomId) return;
    sendWs({ type: "whiteboard_clear", room_id: roomId });
    strokesRef.current = [];
    fullRebuild([]);
  }, [roomId, sendWs, fullRebuild]);

  // ─── Render cursors on active canvas ────────────────────────────────────────

  useEffect(() => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (isDrawing.current) return;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const now = Date.now();
    cursors.forEach((cursor) => {
      const age = now - cursor.lastSeen;
      if (age > CURSOR_FADE_MS) return;
      const opacity = Math.max(0, 1 - age / CURSOR_FADE_MS);

      ctx.globalAlpha = opacity;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#3b82f6";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      const displayName = state.roomMembers.find((m) => m.userId === cursor.userId)?.displayName
        || cursor.userId.replace(/^@/, "");
      ctx.font = "bold 16px sans-serif";
      ctx.fillStyle = "#3b82f6";
      ctx.fillText(displayName, cursor.x + 10, cursor.y - 10);
      ctx.globalAlpha = 1;
    });
  }, [cursors, state.roomMembers]);

  if (!roomId) return null;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      {/* Toolbar */}
      <div className="w-14 border-r border-border bg-background flex flex-col items-center py-2 gap-1 shrink-0 overflow-y-auto">
        <TooltipProvider delayDuration={300}>
          {TOOL_ITEMS.map(({ tool: t, icon: Icon, label }) => (
            <Tooltip key={t}>
              <TooltipTrigger asChild>
                <Button
                  variant={tool === t ? "default" : "ghost"}
                  size="icon"
                  className="h-9 w-9"
                  onClick={() => setTool(t)}
                >
                  <Icon className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          ))}

          <div className="w-8 border-t border-border my-1" />

          {/* Color presets */}
          <div className="grid grid-cols-2 gap-1 px-1">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                className="w-5 h-5 rounded-sm border border-border transition-transform"
                style={{
                  backgroundColor: c,
                  transform: color === c ? "scale(1.2)" : "scale(1)",
                  boxShadow: color === c ? "0 0 0 2px hsl(var(--primary))" : "none",
                }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>

          {/* Custom color picker */}
          <div className="mt-1 relative">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer border border-border bg-transparent"
              style={{ padding: 0 }}
            />
          </div>

          <div className="w-8 border-t border-border my-1" />

          {/* Width slider */}
          <div className="px-1 w-full">
            <Slider
              orientation="vertical"
              value={[width]}
              onValueChange={(v) => setWidth(v[0])}
              min={1}
              max={20}
              step={1}
              className="h-20 mx-auto"
            />
            <span className="text-[10px] text-muted-foreground text-center block mt-1">{width}px</span>
          </div>

          <div className="w-8 border-t border-border my-1" />

          {/* Undo */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleUndo}>
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Undo</TooltipContent>
          </Tooltip>

          {/* Clear (owner/mod only) */}
          {isOwnerOrMod && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={handleClear}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Clear Canvas</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 min-w-0 overflow-auto bg-muted/30 flex items-center justify-center"
      >
        <div className="relative" style={{ width: "100%", height: "100%" }}>
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-sm">Loading canvas...</span>
              </div>
            </div>
          )}
          <canvas
            ref={baseCanvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="absolute inset-0 w-full h-full"
            style={{ imageRendering: "auto" }}
          />
          <canvas
            ref={activeCanvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="absolute inset-0 w-full h-full"
            style={{ cursor: "crosshair", imageRendering: "auto" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => {
              if (isDrawing.current) {
                isDrawing.current = false;
                const activeCanvas = activeCanvasRef.current;
                if (activeCanvas) {
                  const ctx = activeCanvas.getContext("2d");
                  ctx?.clearRect(0, 0, CANVAS_W, CANVAS_H);
                }
                if (currentPoints.current.length > 0) {
                  const points = currentPoints.current;
                  currentPoints.current = [];
                  finishStroke(points);
                }
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
