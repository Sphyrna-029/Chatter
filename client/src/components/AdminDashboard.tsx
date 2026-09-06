import { useState, useEffect, useCallback, useRef } from "react";
import { Shield, X, Users, MessageSquare, HardDrive, Wifi, Home, Copy, Check, RefreshCw, Activity, Radio, Cpu, Layers, Mic, Monitor, Video, AlertTriangle } from "lucide-react";
import { useAppActions } from "@/lib/store";
import {
  apiAdminGetStats,
  apiAdminGetMetrics,
  apiAdminListUsers,
  apiAdminDeleteUser,
  apiAdminDisableUser,
  apiAdminEnableUser,
  apiAdminResetPassword,
  apiAdminListRooms,
  apiAdminDeleteRoom,
  apiAdminGetSettings,
  apiAdminUpdateSettings,
  apiAdminRefreshInvite,
  type AdminStats,
  type AdminMetrics,
  type AdminUser,
  type AdminRoom,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AuthAvatarImage } from "@/components/AuthImage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, displayUserId } from "@/lib/utils";
import { toast } from "sonner";
import { apiDownloadExport } from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";

type Tab = "overview" | "metrics" | "users" | "rooms" | "settings";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function AdminDashboard() {
  const confirm = useConfirm();
  const { dispatch } = useAppActions();
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [inviteOnly, setInviteOnly] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);
  const [storageLimitMb, setStorageLimitMb] = useState(0);
  const [uploadLimitMb, setUploadLimitMb] = useState(0);
  const [roomCreationLimit, setRoomCreationLimit] = useState(0);
  const [requireAuthForUploads, setRequireAuthForUploads] = useState(false);
  const [roomCreationDisabled, setRoomCreationDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [tempPasswordUser, setTempPasswordUser] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "overview") {
        setStats(await apiAdminGetStats());
      } else if (tab === "users") {
        setUsers(await apiAdminListUsers());
      } else if (tab === "rooms") {
        setRooms(await apiAdminListRooms());
      } else if (tab === "settings") {
        const s = await apiAdminGetSettings();
        setInviteOnly(s.invite_only);
        setInviteCode(s.invite_code);
        setStorageLimitMb(Math.round(s.storage_limit_bytes / (1024 * 1024)));
        setUploadLimitMb(Math.round((s.upload_limit_bytes ?? 0) / (1024 * 1024)));
        setRoomCreationLimit(s.room_creation_limit);
        setRequireAuthForUploads(s.require_auth_for_uploads);
        setRoomCreationDisabled(s.room_creation_disabled ?? false);
      }
    } catch (e: any) {
      console.error("Admin load error:", e.message);
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const close = () => dispatch({ type: "SET_ADMIN_DASHBOARD_OPEN", payload: false });

  const handleDeleteUser = async (userId: string) => {
    if (!(await confirm({ title: `Permanently delete ${userId}?`, description: "They will be removed from all rooms. This cannot be undone.", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await apiAdminDeleteUser(userId);
      setUsers((prev) => prev.filter((u) => u.user_id !== userId));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleDisable = async (userId: string) => {
    if (!(await confirm({ title: `Disable ${userId}?`, description: "They will be disconnected and unable to log in.", confirmLabel: "Disable", destructive: true }))) return;
    try {
      await apiAdminDisableUser(userId);
      setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, disabled: true, online: false } : u)));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleEnable = async (userId: string) => {
    try {
      await apiAdminEnableUser(userId);
      setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, disabled: false } : u)));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (!(await confirm({ title: `Reset password and TOTP for ${userId}?`, description: "This cannot be undone.", confirmLabel: "Reset", destructive: true }))) return;
    try {
      const pw = await apiAdminResetPassword(userId);
      setTempPassword(pw);
      setTempPasswordUser(userId);
      setCopied(false);
      setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, totp_verified: false } : u)));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleDeleteRoom = async (roomId: string, roomName: string) => {
    if (!(await confirm({ title: `Force-delete "${roomName}"?`, description: "All messages, members and associated data are permanently removed.", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await apiAdminDeleteRoom(roomId);
      setRooms((prev) => prev.filter((r) => r.room_id !== roomId));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const copyPassword = () => {
    if (tempPassword) {
      navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };


  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Server Dashboard</h1>
        </div>
        <Button variant="ghost" size="icon" onClick={close} className="h-8 w-8" aria-label="Close dashboard">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b px-4 py-1 shrink-0">
        {(["overview", "metrics", "users", "rooms", "settings"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-1.5 text-sm rounded-md transition-colors capitalize",
              tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : tab === "overview" && stats ? (
            <OverviewTab stats={stats} />
          ) : tab === "metrics" ? (
            <MetricsTab />
          ) : tab === "users" ? (
            <UsersTab
              users={users}
              onDisable={handleDisable}
              onEnable={handleEnable}
              onDelete={handleDeleteUser}
              onResetPassword={handleResetPassword}
              displayName={displayUserId}
            />
          ) : tab === "rooms" ? (
            <RoomsTab rooms={rooms} onDelete={handleDeleteRoom} displayName={displayUserId} />
          ) : tab === "settings" ? (
            <SettingsTab
              inviteOnly={inviteOnly}
              inviteCode={inviteCode}
              inviteCopied={inviteCopied}
              storageLimitMb={storageLimitMb}
              uploadLimitMb={uploadLimitMb}
              roomCreationLimit={roomCreationLimit}
              requireAuthForUploads={requireAuthForUploads}
              roomCreationDisabled={roomCreationDisabled}
              onToggleInviteOnly={async (val) => {
                try {
                  await apiAdminUpdateSettings({ invite_only: val });
                  setInviteOnly(val);
                } catch (e: any) {
                  toast.error(e.message);
                }
              }}
              onRefreshInvite={async () => {
                try {
                  const result = await apiAdminRefreshInvite();
                  setInviteCode(result.invite_code);
                } catch (e: any) {
                  toast.error(e.message);
                }
              }}
              onCopyInvite={() => {
                navigator.clipboard.writeText(inviteCode);
                setInviteCopied(true);
                setTimeout(() => setInviteCopied(false), 2000);
              }}
              onSaveStorageLimit={async (mb) => {
                try {
                  await apiAdminUpdateSettings({ storage_limit_bytes: mb * 1024 * 1024 });
                  setStorageLimitMb(mb);
                } catch (e: any) {
                  toast.error(e.message);
                }
              }}
              onSaveUploadLimit={async (mb) => {
                try {
                  await apiAdminUpdateSettings({ upload_limit_bytes: mb * 1024 * 1024 });
                  setUploadLimitMb(mb);
                } catch (e: any) {
                  toast.error(e.message);
                }
              }}
              onSaveRoomCreationLimit={async (val) => {
                try {
                  await apiAdminUpdateSettings({ room_creation_limit: val });
                  setRoomCreationLimit(val);
                } catch (e: any) {
                  toast.error(e.message);
                }
              }}
              onToggleRequireAuthForUploads={async (val) => {
                try {
                  await apiAdminUpdateSettings({ require_auth_for_uploads: val });
                  setRequireAuthForUploads(val);
                } catch (e: any) {
                  toast.error(e.message);
                }
              }}
              onToggleRoomCreationDisabled={async (val) => {
                try {
                  await apiAdminUpdateSettings({ room_creation_disabled: val });
                  setRoomCreationDisabled(val);
                } catch (e: any) {
                  toast.error(e.message);
                }
              }}
            />
          ) : null}
        </div>
      </ScrollArea>

      {/* Password reset result dialog */}
      {tempPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setTempPassword(null)}>
          <div className="bg-background border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-1">Password Reset</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Temporary password for {tempPasswordUser ? displayUserId(tempPasswordUser) : "user"}:
            </p>
            <div className="flex items-center gap-2 bg-muted rounded-md px-3 py-2 mb-3">
              <code className="flex-1 text-sm font-mono select-all">{tempPassword}</code>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={copyPassword}>
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">TOTP has also been reset. The user will need to set up 2FA again.</p>
            <Button size="sm" className="w-full" onClick={() => setTempPassword(null)}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function OverviewTab({ stats }: { stats: AdminStats }) {
  const cards = [
    { label: "Total Users", value: stats.users, icon: Users },
    { label: "Online Users", value: stats.online_users, icon: Wifi },
    { label: "Rooms", value: stats.rooms, icon: Home },
    { label: "Messages", value: stats.messages.toLocaleString(), icon: MessageSquare },
    { label: "Files", value: stats.uploads, icon: HardDrive },
    { label: "Storage Size", value: formatBytes(stats.total_file_size), icon: HardDrive },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="border rounded-lg p-4 flex flex-col gap-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <c.icon className="h-4 w-4" />
            <span className="text-xs">{c.label}</span>
          </div>
          <span className="text-2xl font-bold">{c.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Metrics                                                          */
/* ---------------------------------------------------------------- */

/** Poll cadence. Fast enough to watch a call start, slow enough that the
 *  window below still covers a couple of minutes. */
const METRICS_POLL_MS = 3000;
/** Samples kept for the sparkline — two minutes at the cadence above. */
const METRICS_HISTORY = 40;
/** Floor for the sparkline's y-axis, so an idle server reads as flat rather
 *  than as noise amplified to full height. */
const SPARKLINE_FLOOR_BPS = 1_000_000;

function formatBitrate(bps: number): string {
  if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`;
  return `${Math.round(bps)} bps`;
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface MediaRates {
  voiceOut: number;
  screenOut: number;
  webcamOut: number;
  totalOut: number;
  totalIn: number;
}

/**
 * Egress over the polling window.
 *
 * One series, so no legend — the heading names it — and no marker on every
 * point: the current value is the hero number beside it and the peak is
 * labelled once. `non-scaling-stroke` keeps the 2px line 2px while the
 * viewBox stretches to the panel width.
 */
function EgressSparkline({ values }: { values: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 64;

  if (values.length < 2) {
    return (
      <div className="h-16 flex items-center text-xs text-muted-foreground">
        Sampling…
      </div>
    );
  }

  const peak = Math.max(...values);
  const max = Math.max(peak, SPARKLINE_FLOOR_BPS);
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - (v / max) * (H - 4) - 2;
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  const hoverIndex = hover === null ? null : Math.min(values.length - 1, Math.max(0, Math.round(hover * (values.length - 1))));
  const secondsAgo = hoverIndex === null ? 0 : Math.round(((values.length - 1 - hoverIndex) * METRICS_POLL_MS) / 1000);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-16 cursor-crosshair"
        role="img"
        aria-label={`Egress over the last ${Math.round((values.length * METRICS_POLL_MS) / 1000)} seconds, currently ${formatBitrate(values[values.length - 1])}, peak ${formatBitrate(peak)}`}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover((e.clientX - rect.left) / rect.width);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <path d={area} fill="var(--color-chart-1)" opacity={0.12} />
        <path
          d={line}
          fill="none"
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hoverIndex !== null && (
          <line
            x1={x(hoverIndex)}
            x2={x(hoverIndex)}
            y1={0}
            y2={H}
            stroke="var(--color-muted-foreground)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
        <span>{Math.round((values.length * METRICS_POLL_MS) / 1000)}s ago</span>
        <span>peak {formatBitrate(peak)}</span>
      </div>
      {hoverIndex !== null && (
        <div className="absolute -top-7 left-0 right-0 flex justify-center pointer-events-none">
          <span className="rounded bg-popover border px-2 py-0.5 text-xs shadow-sm whitespace-nowrap">
            {formatBitrate(values[hoverIndex])} · {secondsAgo}s ago
          </span>
        </div>
      )}
    </div>
  );
}

function MetricRow({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 border-b last:border-b-0">
      <span className="text-xs text-muted-foreground">
        {label}
        {hint && <span className="ml-1 opacity-60">{hint}</span>}
      </span>
      <span className="text-sm font-mono">{value}</span>
    </div>
  );
}

function MetricsTab() {
  const [snap, setSnap] = useState<AdminMetrics | null>(null);
  const [rates, setRates] = useState<MediaRates | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const prevRef = useRef<AdminMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const cur = await apiAdminGetMetrics();
        if (cancelled) return;
        setError(null);
        setSnap(cur);

        const prev = prevRef.current;
        prevRef.current = cur;
        // A restart resets every counter, so a diff across one would read as a
        // huge negative rate. Drop the window and start again.
        if (!prev || cur.uptime_secs < prev.uptime_secs) {
          setRates(null);
          setHistory([]);
          return;
        }
        const dt = (cur.timestamp_ms - prev.timestamp_ms) / 1000;
        if (dt <= 0) return;
        const rate = (a: number, b: number) => Math.max(0, ((b - a) * 8) / dt);
        const next: MediaRates = {
          voiceOut: rate(prev.voice.out_bytes, cur.voice.out_bytes),
          screenOut: rate(prev.screen.out_bytes, cur.screen.out_bytes),
          webcamOut: rate(prev.webcam.out_bytes, cur.webcam.out_bytes),
          totalOut: rate(
            prev.voice.out_bytes + prev.screen.out_bytes + prev.webcam.out_bytes,
            cur.voice.out_bytes + cur.screen.out_bytes + cur.webcam.out_bytes,
          ),
          totalIn: rate(
            prev.voice.in_bytes + prev.screen.in_bytes + prev.webcam.in_bytes,
            cur.voice.in_bytes + cur.screen.in_bytes + cur.webcam.in_bytes,
          ),
        };
        setRates(next);
        setHistory((h) => [...h, next.totalOut].slice(-METRICS_HISTORY));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    tick();
    const id = setInterval(tick, METRICS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!snap) return <p className="text-sm text-muted-foreground">Loading...</p>;

  const s = snap.sessions;
  const laggedTotal = snap.voice.lagged_packets + snap.screen.lagged_packets + snap.webcam.lagged_packets;

  const kinds = [
    { name: "Voice", counters: snap.voice, out: rates?.voiceOut, icon: Mic },
    { name: "Screen", counters: snap.screen, out: rates?.screenOut, icon: Monitor },
    { name: "Webcam", counters: snap.webcam, out: rates?.webcamOut, icon: Video },
  ];

  return (
    <div className="space-y-4">
      {/* Media plane — the number that decides how many people fit on this box */}
      <div className="border rounded-lg p-4">
        <div className="flex items-center gap-2 text-muted-foreground mb-2">
          <Activity className="h-4 w-4" />
          <span className="text-xs">SFU egress</span>
        </div>
        <div className="flex items-end gap-3 mb-1">
          <span className="text-3xl font-bold tabular-nums">
            {rates ? formatBitrate(rates.totalOut) : "—"}
          </span>
          <span className="text-xs text-muted-foreground mb-1.5">
            forwarded out · {rates ? formatBitrate(rates.totalIn) : "—"} in
          </span>
        </div>
        <EgressSparkline values={history} />
      </div>

      {/* Per-kind breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {kinds.map((k) => (
          <div key={k.name} className="border rounded-lg p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
              <k.icon className="h-4 w-4" />
              <span className="text-xs">{k.name}</span>
            </div>
            <div className="text-xl font-bold tabular-nums mb-2">
              {k.out === undefined ? "—" : formatBitrate(k.out)}
            </div>
            <MetricRow label="Sent" value={formatBytes(k.counters.out_bytes)} />
            <MetricRow label="Received" value={formatBytes(k.counters.in_bytes)} />
            <MetricRow label="Packets out" value={k.counters.out_packets.toLocaleString()} />
            <MetricRow
              label="Dropped to lag"
              value={k.counters.lagged_packets.toLocaleString()}
            />
          </div>
        ))}
      </div>

      {laggedTotal > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground">
            <span className="text-foreground font-medium">
              {laggedTotal.toLocaleString()} packets dropped to subscriber lag.
            </span>{" "}
            A subscriber fell behind the publisher's ring buffer — its link is too slow, the
            buffer is too small, or the process was starved. Video recovers on the next
            keyframe; voice does not.
          </p>
        </div>
      )}

      {/* Live sessions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Radio className="h-4 w-4" />
            <span className="text-xs">Sessions</span>
          </div>
          <MetricRow label="Voice channels occupied" value={s.voice_channels_active} />
          <MetricRow label="Voice members" value={s.voice_members} />
          <MetricRow
            label="Voice streams"
            value={`${s.voice_publishers} pub / ${s.voice_subscribers} sub`}
          />
          <MetricRow
            label="Screen streams"
            value={`${s.screen_publishers} pub / ${s.screen_subscribers} sub`}
          />
          <MetricRow
            label="Webcam streams"
            value={`${s.webcam_publishers} pub / ${s.webcam_subscribers} sub`}
          />
        </div>

        <div className="border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Cpu className="h-4 w-4" />
            <span className="text-xs">Process</span>
          </div>
          <MetricRow label="Uptime" value={formatUptime(snap.uptime_secs)} />
          <MetricRow
            label="WebSockets"
            value={`${snap.connections.sockets} / ${snap.connections.users} users`}
          />
          <MetricRow
            label="Resident memory"
            value={snap.resident_bytes === null ? "n/a" : formatBytes(snap.resident_bytes)}
          />
          <MetricRow
            label="Media jobs"
            value={`${snap.media_jobs.active} running / ${snap.media_jobs.started} total`}
            hint="ffmpeg"
          />
        </div>
      </div>

      {/* Ephemeral maps — these only ever grow until something trims them */}
      <div className="border rounded-lg p-4">
        <div className="flex items-center gap-2 text-muted-foreground mb-2">
          <Layers className="h-4 w-4" />
          <span className="text-xs">In-memory maps</span>
        </div>
        <MetricRow label="Rate limit buckets" value={snap.caches.rate_limit_buckets} />
        <MetricRow label="Presence entries" value={snap.caches.presence_entries} />
        <MetricRow label="Link preview cache" value={snap.caches.link_previews} />
        <MetricRow label="Room member cache" value={snap.caches.room_member_cache} />
        <MetricRow label="Watch parties" value={snap.caches.watch_parties} />
        <MetricRow label="Pending voice subscribes" value={snap.caches.pending_voice_subscribes} />
      </div>

      <p className="text-[11px] text-muted-foreground">
        Counters are cumulative since startup; rates are measured over the last{" "}
        {METRICS_POLL_MS / 1000}s. Byte counts are RTP as written to the socket — they exclude
        IP/UDP and SRTP overhead, so real link usage runs roughly 5–10% higher.
      </p>
    </div>
  );
}

function UsersTab({
  users,
  onDisable,
  onEnable,
  onDelete,
  onResetPassword,
  displayName,
}: {
  users: AdminUser[];
  onDisable: (id: string) => void;
  onEnable: (id: string) => void;
  onDelete: (id: string) => void;
  onResetPassword: (id: string) => void;
  displayName: (id: string) => string;
}) {
  return (
    <div className="space-y-2">
      {users.map((user) => (
        <div
          key={user.user_id}
          className={cn(
            "flex items-center gap-3 border rounded-lg p-3",
            user.disabled && "opacity-60"
          )}
        >
          <Avatar className="h-9 w-9 shrink-0">
            <AuthAvatarImage src={user.avatar_url} />
            <AvatarFallback className="text-xs">
              {displayUserId(user.user_id).substring(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium truncate">
                {user.display_name || displayUserId(user.user_id)}
              </span>
              {user.is_admin && (
                <span className="px-1.5 py-0.5 text-3xs font-medium rounded bg-primary/20 text-primary">Admin</span>
              )}
              {user.disabled && (
                <span className="px-1.5 py-0.5 text-3xs font-medium rounded bg-destructive/20 text-destructive">Disabled</span>
              )}
              {user.online && (
                <span className="px-1.5 py-0.5 text-3xs font-medium rounded bg-success/20 text-success">Online</span>
              )}
              {user.totp_verified && (
                <span className="px-1.5 py-0.5 text-3xs font-medium rounded bg-blue-500/20 text-blue-500">2FA</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">{displayUserId(user.user_id)}</p>
            <p className="text-xs text-muted-foreground">{user.room_count} room{user.room_count !== 1 ? "s" : ""}</p>
          </div>

          {!user.is_admin && (
            <div className="flex gap-1 shrink-0">
              {user.disabled ? (
                <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => onEnable(user.user_id)}>
                  Enable
                </Button>
              ) : (
                <Button variant="outline" size="sm" className="text-xs h-7 text-destructive hover:text-destructive" onClick={() => onDisable(user.user_id)}>
                  Disable
                </Button>
              )}
              <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => onResetPassword(user.user_id)}>
                Reset PW
              </Button>
              <Button variant="outline" size="sm" className="text-xs h-7 text-destructive hover:text-destructive" onClick={() => onDelete(user.user_id)}>
                Delete
              </Button>
            </div>
          )}
        </div>
      ))}
      {users.length === 0 && (
        <p className="text-sm text-muted-foreground">No users found.</p>
      )}
    </div>
  );
}

function RoomsTab({
  rooms,
  onDelete,
  displayName,
}: {
  rooms: AdminRoom[];
  onDelete: (id: string, name: string) => void;
  displayName: (id: string) => string;
}) {
  return (
    <div className="space-y-2">
      {rooms.map((room) => (
        <div key={room.room_id} className="flex items-center gap-3 border rounded-lg p-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium truncate max-w-[200px]">{room.name || "Unnamed"}</span>
              <span className="px-1.5 py-0.5 text-3xs font-medium rounded bg-muted text-muted-foreground">
                {room.is_dm ? "DM" : room.room_type || "text"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground truncate max-w-[300px]">
              Created by {displayUserId(room.creator)} &middot; {room.member_count} member{room.member_count !== 1 ? "s" : ""} &middot; {room.message_count} message{room.message_count !== 1 ? "s" : ""}
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7 text-destructive hover:text-destructive shrink-0"
            onClick={() => onDelete(room.room_id, room.name)}
          >
            Delete
          </Button>
        </div>
      ))}
      {rooms.length === 0 && (
        <p className="text-sm text-muted-foreground">No rooms found.</p>
      )}
    </div>
  );
}

function SettingsTab({
  inviteOnly,
  inviteCode,
  inviteCopied,
  storageLimitMb,
  uploadLimitMb,
  roomCreationLimit,
  requireAuthForUploads,
  roomCreationDisabled,
  onToggleInviteOnly,
  onRefreshInvite,
  onCopyInvite,
  onSaveStorageLimit,
  onSaveUploadLimit,
  onSaveRoomCreationLimit,
  onToggleRequireAuthForUploads,
  onToggleRoomCreationDisabled,
}: {
  inviteOnly: boolean;
  inviteCode: string;
  inviteCopied: boolean;
  storageLimitMb: number;
  uploadLimitMb: number;
  roomCreationLimit: number;
  requireAuthForUploads: boolean;
  roomCreationDisabled: boolean;
  onToggleInviteOnly: (val: boolean) => void;
  onRefreshInvite: () => void;
  onCopyInvite: () => void;
  onSaveStorageLimit: (mb: number) => void;
  onSaveUploadLimit: (mb: number) => void;
  onSaveRoomCreationLimit: (val: number) => void;
  onToggleRequireAuthForUploads: (val: boolean) => void;
  onToggleRoomCreationDisabled: (val: boolean) => void;
}) {
  // Local: the export is a one-off action, not server settings state.
  const [exporting, setExporting] = useState(false);

  const [localLimit, setLocalLimit] = useState(storageLimitMb);
  const limitChanged = localLimit !== storageLimitMb;
  const [localUploadLimit, setLocalUploadLimit] = useState(uploadLimitMb);
  const uploadLimitChanged = localUploadLimit !== uploadLimitMb;
  const [localRoomLimit, setLocalRoomLimit] = useState(roomCreationLimit);
  const roomLimitChanged = localRoomLimit !== roomCreationLimit;

  useEffect(() => {
    setLocalLimit(storageLimitMb);
  }, [storageLimitMb]);

  useEffect(() => {
    setLocalUploadLimit(uploadLimitMb);
  }, [uploadLimitMb]);

  useEffect(() => {
    setLocalRoomLimit(roomCreationLimit);
  }, [roomCreationLimit]);

  return (
    <div className="space-y-4">
      <div className="border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Invite-Only Mode</h3>
            <p className="text-xs text-muted-foreground">
              When enabled, new users must enter a valid invite code to register.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={inviteOnly}
            onClick={() => onToggleInviteOnly(!inviteOnly)}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0",
              inviteOnly ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-background transition-transform",
                inviteOnly ? "translate-x-6" : "translate-x-1"
              )}
            />
          </button>
        </div>

        {inviteOnly && (
          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs text-muted-foreground">Current invite code:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted rounded-md px-3 py-2 text-sm font-mono select-all">
                {inviteCode}
              </code>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={onCopyInvite}>
                {inviteCopied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={onRefreshInvite}
            aria-label="Refresh">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="ui-meta">
              Share this code with people you want to allow to register. Refreshing generates a new code and invalidates the old one.
            </p>
          </div>
        )}
      </div>

      <div className="border rounded-lg p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Per-User Storage Limit</h3>
          <p className="text-xs text-muted-foreground">
            Maximum upload storage per user. Set to 0 for unlimited.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            value={localLimit}
            onChange={(e) => setLocalLimit(Math.max(0, parseInt(e.target.value) || 0))}
            className="w-28 rounded-md border bg-background px-3 py-1.5 text-sm"
          />
          <span className="text-sm text-muted-foreground">MB</span>
          <Button
            size="sm"
            className="text-xs h-7 ml-2"
            disabled={!limitChanged}
            onClick={() => onSaveStorageLimit(localLimit)}
          >
            Save
          </Button>
        </div>
        <p className="ui-meta">
          {localLimit === 0 ? "Currently unlimited." : `Each user can upload up to ${localLimit} MB total.`}
        </p>
      </div>

      <div className="border rounded-lg p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Max File Upload Size</h3>
          <p className="text-xs text-muted-foreground">
            Maximum size for a single file upload. Set to 0 for unlimited.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            value={localUploadLimit}
            onChange={(e) => setLocalUploadLimit(Math.max(0, parseInt(e.target.value) || 0))}
            className="w-28 rounded-md border bg-background px-3 py-1.5 text-sm"
          />
          <span className="text-sm text-muted-foreground">MB</span>
          <Button
            size="sm"
            className="text-xs h-7 ml-2"
            disabled={!uploadLimitChanged}
            onClick={() => onSaveUploadLimit(localUploadLimit)}
          >
            Save
          </Button>
        </div>
        <p className="ui-meta">
          {localUploadLimit === 0 ? "Currently unlimited." : `Individual files cannot exceed ${localUploadLimit} MB.`}
        </p>
      </div>

      <div className="border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Disable Room Creation</h3>
            <p className="text-xs text-muted-foreground">
              Prevent all non-admin users from creating new rooms. Server owners can still create rooms.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={roomCreationDisabled}
            onClick={() => onToggleRoomCreationDisabled(!roomCreationDisabled)}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0",
              roomCreationDisabled ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-background transition-transform",
                roomCreationDisabled ? "translate-x-6" : "translate-x-1"
              )}
            />
          </button>
        </div>
        <p className="ui-meta">
          {roomCreationDisabled
            ? "Only server owners/admins can create rooms."
            : "All users can create rooms (subject to the per-user limit below)."}
        </p>
      </div>

      <div className="border rounded-lg p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Per-User Room Limit</h3>
          <p className="text-xs text-muted-foreground">
            Maximum number of rooms each user can create. DMs are not counted. Set to 0 for unlimited.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            value={localRoomLimit}
            onChange={(e) => setLocalRoomLimit(Math.max(0, parseInt(e.target.value) || 0))}
            className="w-28 rounded-md border bg-background px-3 py-1.5 text-sm"
          />
          <span className="text-sm text-muted-foreground">rooms</span>
          <Button
            size="sm"
            className="text-xs h-7 ml-2"
            disabled={!roomLimitChanged}
            onClick={() => onSaveRoomCreationLimit(localRoomLimit)}
          >
            Save
          </Button>
        </div>
        <p className="ui-meta">
          {localRoomLimit === 0 ? "Currently unlimited." : `Each user can create up to ${localRoomLimit} room${localRoomLimit !== 1 ? "s" : ""}.`}
        </p>
      </div>

      <div className="border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Require Auth for Uploads</h3>
            <p className="text-xs text-muted-foreground">
              When enabled, uploaded files can only be accessed by authenticated users.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={requireAuthForUploads}
            onClick={() => onToggleRequireAuthForUploads(!requireAuthForUploads)}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0",
              requireAuthForUploads ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-background transition-transform",
                requireAuthForUploads ? "translate-x-6" : "translate-x-1"
              )}
            />
          </button>
        </div>
        <p className="ui-meta">
          {requireAuthForUploads
            ? "Only logged-in users can view uploaded images and files."
            : "Uploaded files are publicly accessible to anyone with the link."}
        </p>
      </div>

      <div className="border rounded-lg p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Backup</h3>
          <p className="text-xs text-muted-foreground">
            Download every room, message, member and setting as newline-delimited
            JSON.
          </p>
        </div>
        <p className="ui-meta">
          Contains password hashes, TOTP secrets and recovery codes — a backup
          that cannot restore logins is not a backup. Store it accordingly.
          Uploaded media is not included; copy the server's{" "}
          <code className="text-2xs">external/</code> directory alongside it.
        </p>
        <button
          type="button"
          className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-muted transition-colors disabled:opacity-50"
          disabled={exporting}
          onClick={async () => {
            setExporting(true);
            try {
              await apiDownloadExport();
            } catch {
              toast.error("Export failed");
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? "Preparing…" : "Download backup"}
        </button>
      </div>
    </div>
  );
}
