import { useEffect, useState, useRef } from "react";
import type { PeerStats } from "@/lib/webrtc";

interface PeerConnectionSource {
  voicePublisherPcRef: React.MutableRefObject<RTCPeerConnection | null>;
  voiceSubscriberPcsRef: React.MutableRefObject<Map<string, RTCPeerConnection>>;
  screenPubPcRef: React.MutableRefObject<RTCPeerConnection | null>;
  screenSubPcsRef: React.MutableRefObject<Map<string, RTCPeerConnection>>;
}

export function useConnectionStats(
  inVoiceChannel: boolean,
  sources: PeerConnectionSource,
) {
  const [connStats, setConnStats] = useState<Record<string, PeerStats>>({});
  const prevBytesRef = useRef<Record<string, number>>({});
  const prevTimestampRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!inVoiceChannel) {
      setConnStats({});
      prevBytesRef.current = {};
      prevTimestampRef.current = {};
      return;
    }

    const pollStats = async () => {
      const pcs: [string, RTCPeerConnection | null][] = [
        ["voice-pub", sources.voicePublisherPcRef.current],
      ];
      sources.voiceSubscriberPcsRef.current.forEach((pc, uid) => pcs.push([`voice-sub:${uid}`, pc]));
      pcs.push(["screen-pub", sources.screenPubPcRef.current]);
      sources.screenSubPcsRef.current.forEach((pc, uid) => pcs.push([`screen-sub:${uid}`, pc]));

      const next: Record<string, PeerStats> = {};
      const now = performance.now();

      for (const [key, pc] of pcs) {
        if (!pc) continue;
        try {
          const stats = await pc.getStats();
          let rtt: number | null = null;
          let packetsLost: number | null = null;
          let audioPacketsLost: number | null = null;
          let fps: number | null = null;
          let resolution: string | null = null;
          let audioBytes = 0;
          let videoBytes = 0;
          let audioJitter: number | null = null;
          let audioLevel: number | null = null;
          let concealmentRatio: number | null = null;
          let audioCodec: string | null = null;
          const codecMap = new Map<string, string>();

          stats.forEach((report) => {
            if (report.type === "codec") {
              const label = [
                report.mimeType,
                report.clockRate != null ? String(report.clockRate) : null,
                report.channels != null ? String(report.channels) : null,
              ].filter(Boolean).join("/");
              codecMap.set(report.id, label);
            }
          });

          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.nominated) {
              if (report.currentRoundTripTime != null) rtt = report.currentRoundTripTime;
            }

            if (report.type === "media-source" && report.kind === "audio") {
              if (report.audioLevel != null) audioLevel = report.audioLevel;
            }

            if (report.type === "inbound-rtp" || report.type === "outbound-rtp") {
              const bytes = report.bytesReceived ?? report.bytesSent ?? 0;
              if (report.kind === "audio") {
                audioBytes += bytes;
                if (report.packetsLost != null) audioPacketsLost = (audioPacketsLost ?? 0) + report.packetsLost;
                if (report.jitter != null) audioJitter = report.jitter;
                if (report.concealedSamples != null && report.totalSamplesReceived != null && report.totalSamplesReceived > 0) {
                  concealmentRatio = report.concealedSamples / report.totalSamplesReceived;
                }
                if (report.codecId && codecMap.has(report.codecId)) {
                  audioCodec = codecMap.get(report.codecId)!;
                }
              } else {
                videoBytes += bytes;
                if (report.packetsLost != null) packetsLost = (packetsLost ?? 0) + report.packetsLost;
                if (report.framesPerSecond != null) fps = report.framesPerSecond;
                if (report.frameWidth && report.frameHeight) {
                  resolution = `${report.frameWidth}x${report.frameHeight}`;
                }
              }
            }
          });

          const calcBitrate = (bytesKey: string, bytes: number) => {
            let rate: number | null = null;
            const prev = prevBytesRef.current[bytesKey];
            const prevTs = prevTimestampRef.current[bytesKey];
            if (prev != null && prevTs != null) {
              const dt = (now - prevTs) / 1000;
              if (dt > 0) rate = (bytes - prev) / dt;
            }
            prevBytesRef.current[bytesKey] = bytes;
            prevTimestampRef.current[bytesKey] = now;
            return rate;
          };

          const audioBitrate = calcBitrate(`${key}:audio`, audioBytes);
          const videoBitrate = calcBitrate(`${key}:video`, videoBytes);
          const bitrate = (audioBitrate ?? 0) + (videoBitrate ?? 0) || null;

          next[key] = {
            rtt, bitrate, audioBitrate, videoBitrate,
            packetsLost, audioPacketsLost,
            framesPerSecond: fps, resolution,
            connectionState: pc.connectionState,
            audioJitter, audioLevel, concealmentRatio, audioCodec,
          };
        } catch {}
      }
      setConnStats(next);
    };

    pollStats();
    const id = setInterval(pollStats, 2000);
    return () => clearInterval(id);
  }, [inVoiceChannel]);

  return connStats;
}
