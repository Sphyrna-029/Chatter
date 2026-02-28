import { useState, useEffect, useCallback } from "react";
import { Shield, X, Users, MessageSquare, HardDrive, Wifi, Home, Copy, Check, RefreshCw } from "lucide-react";
import { useAppContext } from "@/lib/store";
import {
  apiAdminGetStats,
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
  type AdminUser,
  type AdminRoom,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, displayUserId } from "@/lib/utils";

type Tab = "overview" | "users" | "rooms" | "settings";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function AdminDashboard() {
  const { dispatch } = useAppContext();
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [inviteOnly, setInviteOnly] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);
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
    if (!confirm(`Permanently delete user ${userId}? This will remove them from all rooms and cannot be undone.`)) return;
    try {
      await apiAdminDeleteUser(userId);
      setUsers((prev) => prev.filter((u) => u.user_id !== userId));
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleDisable = async (userId: string) => {
    if (!confirm(`Disable user ${userId}? They will be disconnected and unable to log in.`)) return;
    try {
      await apiAdminDisableUser(userId);
      setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, disabled: true, online: false } : u)));
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleEnable = async (userId: string) => {
    try {
      await apiAdminEnableUser(userId);
      setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, disabled: false } : u)));
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (!confirm(`Reset password and TOTP for ${userId}? This cannot be undone.`)) return;
    try {
      const pw = await apiAdminResetPassword(userId);
      setTempPassword(pw);
      setTempPasswordUser(userId);
      setCopied(false);
      setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, totp_verified: false } : u)));
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleDeleteRoom = async (roomId: string, roomName: string) => {
    if (!confirm(`Force-delete room "${roomName}"? All messages, members, and associated data will be permanently removed.`)) return;
    try {
      await apiAdminDeleteRoom(roomId);
      setRooms((prev) => prev.filter((r) => r.room_id !== roomId));
    } catch (e: any) {
      alert(e.message);
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
        <Button variant="ghost" size="icon" onClick={close} className="h-8 w-8">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b px-4 py-1 shrink-0">
        {(["overview", "users", "rooms", "settings"] as Tab[]).map((t) => (
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
              onToggleInviteOnly={async (val) => {
                try {
                  await apiAdminUpdateSettings(val);
                  setInviteOnly(val);
                } catch (e: any) {
                  alert(e.message);
                }
              }}
              onRefreshInvite={async () => {
                try {
                  const result = await apiAdminRefreshInvite();
                  setInviteCode(result.invite_code);
                } catch (e: any) {
                  alert(e.message);
                }
              }}
              onCopyInvite={() => {
                navigator.clipboard.writeText(inviteCode);
                setInviteCopied(true);
                setTimeout(() => setInviteCopied(false), 2000);
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
                {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
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
            {user.avatar_url && <AvatarImage src={user.avatar_url} />}
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
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary/20 text-primary">Admin</span>
              )}
              {user.disabled && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-destructive/20 text-destructive">Disabled</span>
              )}
              {user.online && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-green-500/20 text-green-500">Online</span>
              )}
              {user.totp_verified && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-500/20 text-blue-500">2FA</span>
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
              <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-muted text-muted-foreground">
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
  onToggleInviteOnly,
  onRefreshInvite,
  onCopyInvite,
}: {
  inviteOnly: boolean;
  inviteCode: string;
  inviteCopied: boolean;
  onToggleInviteOnly: (val: boolean) => void;
  onRefreshInvite: () => void;
  onCopyInvite: () => void;
}) {
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
                {inviteCopied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={onRefreshInvite}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Share this code with people you want to allow to register. Refreshing generates a new code and invalidates the old one.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
