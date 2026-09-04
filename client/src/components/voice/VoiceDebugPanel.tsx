import { cn, displayUserId } from "@/lib/utils";
import type { PeerStats } from "@/lib/webrtc";

interface VoiceDebugPanelProps {
  connStats: Record<string, PeerStats>;
}


export function VoiceDebugPanel({ connStats }: VoiceDebugPanelProps) {
  if (Object.keys(connStats).length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="grid gap-2">
        {Object.entries(connStats).map(([key, s]) => {
          let label = key;
          if (key === "voice-pub") label = "Voice Pub";
          else if (key === "screen-pub") label = "Screen Pub";
          else if (key.startsWith("voice-sub:")) label = `Voice Sub: ${displayUserId(key.replace("voice-sub:", ""))}`;
          else if (key.startsWith("screen-sub:")) label = `Screen Sub: ${displayUserId(key.replace("screen-sub:", ""))}`;

          const stateColor =
            s.connectionState === "connected" ? "text-success" :
            s.connectionState === "connecting" || s.connectionState === "new" ? "text-warning" :
            "text-destructive";

          const jitterMs = s.audioJitter != null ? Math.round(s.audioJitter * 1000) : null;
          const jitterColor =
            jitterMs == null ? "text-muted-foreground" :
            jitterMs < 10 ? "text-success" :
            jitterMs < 30 ? "text-warning" :
            "text-destructive";

          const concealPct = s.concealmentRatio != null ? (s.concealmentRatio * 100) : null;
          const concealColor =
            concealPct == null ? "text-muted-foreground" :
            concealPct < 1 ? "text-success" :
            concealPct < 5 ? "text-warning" :
            "text-destructive";

          // 5-block level meter for audioLevel (0-1)
          const levelBlocks = s.audioLevel != null
            ? Math.round(s.audioLevel * 5)
            : null;

          const hasAudio = s.audioBitrate != null || s.audioJitter != null || s.audioCodec != null;
          const hasVideo = s.videoBitrate != null || s.framesPerSecond != null;

          return (
            <div key={key} className="flex flex-col gap-0.5">
              {/* Row 1 - connection overview */}
              <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                <span className="font-semibold min-w-[110px]">{label}</span>
                <span className={cn("font-medium", stateColor)}>{s.connectionState}</span>
                <span>RTT: {s.rtt != null ? `${Math.round(s.rtt * 1000)}ms` : "—"}</span>
                {hasVideo && (
                  <span className="text-blue-400">
                    vid {s.videoBitrate != null ? `${Math.round(s.videoBitrate * 8 / 1000)}kbps` : "—"}
                  </span>
                )}
                {hasVideo && s.framesPerSecond != null && (
                  <span className="text-blue-400">{s.framesPerSecond}fps</span>
                )}
                {hasVideo && s.resolution && (
                  <span className="text-blue-400">{s.resolution}</span>
                )}
                {hasVideo && s.packetsLost != null && s.packetsLost > 0 && (
                  <span className="text-destructive">vid lost: {s.packetsLost}</span>
                )}
                {/* For voice-only connections show total bitrate */}
                {!hasVideo && s.bitrate != null && (
                  <span>↕ {Math.round(s.bitrate * 8 / 1000)}kbps</span>
                )}
              </div>

              {/* Row 2 - audio detail */}
              {hasAudio && (
                <div className="flex flex-wrap items-center gap-3 text-xs font-mono pl-[118px]">
                  {s.audioBitrate != null && (
                    <span className="text-purple-400">
                      aud {Math.round(s.audioBitrate * 8 / 1000)}kbps
                    </span>
                  )}
                  {s.audioCodec && (
                    <span className="text-muted-foreground">{s.audioCodec}</span>
                  )}
                  {jitterMs != null && (
                    <span className={jitterColor}>jitter: {jitterMs}ms</span>
                  )}
                  {s.audioPacketsLost != null && s.audioPacketsLost > 0 && (
                    <span className="text-destructive">lost: {s.audioPacketsLost}</span>
                  )}
                  {concealPct != null && (
                    <span className={concealColor}>
                      concealed: {concealPct < 0.1 ? "<0.1" : concealPct.toFixed(1)}%
                    </span>
                  )}
                  {levelBlocks != null && (
                    <span className="text-muted-foreground" title={`Audio level: ${(s.audioLevel! * 100).toFixed(1)}%`}>
                      lvl:{" "}
                      <span className="text-success">{"█".repeat(levelBlocks)}</span>
                      <span className="text-muted-foreground/30">{"█".repeat(5 - levelBlocks)}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
