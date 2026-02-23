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

export function WhiteboardArea() {
  const { state, wsRef } = useAppContext();
  const roomId = state.currentRoomId;
  const userId = state.userId;

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#000000");
  const [width, setWidth] = useState(3);
  const [strokes, setStrokes] = useState<WhiteboardStroke[]>([]);
  const [cursors, setCursors] = useState<Map<string, CursorInfo>>(new Map());

  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isDrawing = useRef(false);
  const currentPoints = useRef<number[][]>([]);
  const shapeStart = useRef<number[] | null>(null);
  const lastCursorSend = useRef(0);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;

  const isOwnerOrMod = state.roomMembers.some(
    (m) => m.userId === userId && (m.role === "owner" || m.role === "moderator")
  );

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

  // ─── Rendering helpers ──────────────────────────────────────────────────────

  const drawStroke = useCallback((ctx: CanvasRenderingContext2D, stroke: WhiteboardStroke) => {
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
        // Fill is a pixel-level operation — replay it by flood-filling on the canvas
        if (pts.length >= 1) {
          const px = Math.floor(pts[0][0]);
          const py = Math.floor(pts[0][1]);
          const imageData = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
          const data = imageData.data;

          const targetIdx = (py * CANVAS_W + px) * 4;
          const targetR = data[targetIdx];
          const targetG = data[targetIdx + 1];
          const targetB = data[targetIdx + 2];
          const targetA = data[targetIdx + 3];

          const fillR = parseInt(stroke.color.slice(1, 3), 16);
          const fillG = parseInt(stroke.color.slice(3, 5), 16);
          const fillB = parseInt(stroke.color.slice(5, 7), 16);

          if (!(targetR === fillR && targetG === fillG && targetB === fillB && targetA === 255)) {
            const match = (idx: number) =>
              data[idx] === targetR &&
              data[idx + 1] === targetG &&
              data[idx + 2] === targetB &&
              data[idx + 3] === targetA;

            const stack = [[px, py]];
            const visited = new Uint8Array(CANVAS_W * CANVAS_H);

            while (stack.length > 0) {
              const [cx, cy] = stack.pop()!;
              if (cx < 0 || cx >= CANVAS_W || cy < 0 || cy >= CANVAS_H) continue;
              const ci = cy * CANVAS_W + cx;
              if (visited[ci]) continue;
              const idx = ci * 4;
              if (!match(idx)) continue;

              visited[ci] = 1;
              data[idx] = fillR;
              data[idx + 1] = fillG;
              data[idx + 2] = fillB;
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
  }, []);

  const renderBaseCanvas = useCallback(() => {
    const canvas = baseCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    for (const stroke of strokesRef.current) {
      drawStroke(ctx, stroke);
    }
  }, [drawStroke]);

  // ─── Load strokes on mount / room change ────────────────────────────────────

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    apiGetWhiteboardStrokes(roomId).then((res) => {
      if (!cancelled) {
        setStrokes(res.strokes);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [roomId]);

  // Re-render base canvas when strokes change
  useEffect(() => {
    renderBaseCanvas();
  }, [strokes, renderBaseCanvas]);

  // ─── WS event listeners ─────────────────────────────────────────────────────

  useEffect(() => {
    const onStroke = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.room_id !== roomId) return;
      const stroke = detail.stroke as WhiteboardStroke;
      // Don't duplicate our own strokes (we already added them optimistically)
      if (stroke.user_id === userId) return;
      setStrokes((prev) => [...prev, stroke]);
    };

    const onCursor = (e: Event) => {
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
      const detail = (e as CustomEvent).detail;
      if (detail.room_id !== roomId) return;
      setStrokes([]);
    };

    const onUndo = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.room_id !== roomId) return;
      if (detail.user_id === userId) return; // Already handled locally
      setStrokes((prev) => prev.filter((s) => s.stroke_id !== detail.stroke_id));
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
  }, [roomId, userId]);

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

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!roomId) return;
    const [x, y] = getCanvasPos(e);

    if (tool === "fill") {
      // Send fill as a stroke with single point
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
      setStrokes((prev) => [...prev, fillStroke]);
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
  }, [roomId, tool, color, width, getCanvasPos, userId, sendWs]);

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
      // Draw current freehand stroke on active canvas
      const preview: WhiteboardStroke = {
        stroke_id: "",
        user_id: "",
        tool,
        color,
        width,
        points: currentPoints.current,
        fill: false,
        timestamp: 0,
      };
      drawStroke(ctx, preview);
    } else if (shapeStart.current) {
      // Shape preview
      const preview: WhiteboardStroke = {
        stroke_id: "",
        user_id: "",
        tool,
        color,
        width,
        points: [shapeStart.current, [x, y]],
        fill: false,
        timestamp: 0,
      };
      drawStroke(ctx, preview);
    }
  }, [roomId, tool, color, width, getCanvasPos, sendWs, drawStroke]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current || !roomId) return;
    isDrawing.current = false;

    const [x, y] = getCanvasPos(e);

    // Clear active canvas
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

    if (points.length === 0) return;

    // Add locally (optimistic)
    const localStroke: WhiteboardStroke = {
      stroke_id: `local_${Date.now()}`,
      user_id: userId || "",
      tool,
      color,
      width,
      points,
      fill: false,
      timestamp: Date.now(),
    };
    setStrokes((prev) => [...prev, localStroke]);

    // Send over WS
    sendWs({
      type: "whiteboard_stroke",
      room_id: roomId,
      tool,
      color,
      width,
      points,
      fill: false,
    });
  }, [roomId, tool, color, width, getCanvasPos, userId, sendWs]);

  const handleUndo = useCallback(() => {
    if (!roomId || !userId) return;
    // Remove user's last stroke locally
    setStrokes((prev) => {
      const idx = [...prev].reverse().findIndex((s) => s.user_id === userId);
      if (idx === -1) return prev;
      const actualIdx = prev.length - 1 - idx;
      return [...prev.slice(0, actualIdx), ...prev.slice(actualIdx + 1)];
    });
    sendWs({ type: "whiteboard_undo", room_id: roomId });
  }, [roomId, userId, sendWs]);

  const handleClear = useCallback(() => {
    if (!roomId) return;
    sendWs({ type: "whiteboard_clear", room_id: roomId });
    setStrokes([]);
  }, [roomId, sendWs]);

  // ─── Render cursors on active canvas ────────────────────────────────────────

  useEffect(() => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Only redraw cursors if not currently drawing (don't clear active preview)
    if (isDrawing.current) return;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const now = Date.now();
    cursors.forEach((cursor) => {
      const age = now - cursor.lastSeen;
      if (age > CURSOR_FADE_MS) return;
      const opacity = Math.max(0, 1 - age / CURSOR_FADE_MS);

      // Cursor dot
      ctx.globalAlpha = opacity;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#3b82f6";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Username label
      const displayName = state.roomMembers.find((m) => m.userId === cursor.userId)?.displayName
        || cursor.userId.replace(/^@/, "");
      ctx.font = "bold 16px sans-serif";
      ctx.fillStyle = "#3b82f6";
      ctx.fillText(displayName, cursor.x + 10, cursor.y - 10);
      ctx.globalAlpha = 1;
    });
  }, [cursors, state.roomMembers]);

  // ─── Cursor style ──────────────────────────────────────────────────────────

  const cursorStyle = tool === "fill" ? "crosshair" : "crosshair";

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
            style={{ cursor: cursorStyle, imageRendering: "auto" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => {
              if (isDrawing.current) {
                // Treat leaving canvas as mouseup
                isDrawing.current = false;
                const activeCanvas = activeCanvasRef.current;
                if (activeCanvas) {
                  const ctx = activeCanvas.getContext("2d");
                  ctx?.clearRect(0, 0, CANVAS_W, CANVAS_H);
                }
                // Send whatever was drawn
                if (currentPoints.current.length > 0 && roomId) {
                  const points = currentPoints.current;
                  currentPoints.current = [];
                  const localStroke: WhiteboardStroke = {
                    stroke_id: `local_${Date.now()}`,
                    user_id: userId || "",
                    tool,
                    color,
                    width,
                    points,
                    fill: false,
                    timestamp: Date.now(),
                  };
                  setStrokes((prev) => [...prev, localStroke]);
                  sendWs({
                    type: "whiteboard_stroke",
                    room_id: roomId,
                    tool,
                    color,
                    width,
                    points,
                    fill: false,
                  });
                }
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
