import { useEffect, useMemo, useState } from "react";
import { Check, Eye, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn, displayUserId } from "@/lib/utils";
import { apiGetMyPermissions } from "@/lib/api";
import type { CustomRole, PermissionName, PermissionOverwrite, RolePermissions } from "@/lib/api";

/** The permissions worth adjusting per channel. Room-wide powers like
 *  manage_roles or ban_members are deliberately absent — scoping them to one
 *  channel is meaningless. */
const CHANNEL_PERMISSIONS: { key: PermissionName; label: string }[] = [
  { key: "view_channel", label: "View Channel" },
  { key: "send_messages", label: "Send Messages" },
  { key: "attach_files", label: "Attach Files" },
  { key: "embed_links", label: "Embed Links" },
  { key: "add_reactions", label: "Add Reactions" },
  { key: "connect", label: "Join Voice" },
  { key: "speak", label: "Speak in Voice" },
  { key: "manage_messages", label: "Manage Messages" },
];

/** Neutral means "inherit" — the permission is left to the room-level result. */
type TriState = "allow" | "deny" | "neutral";

function stateOf(ow: PermissionOverwrite, key: PermissionName): TriState {
  if (ow.allow.includes(key)) return "allow";
  if (ow.deny.includes(key)) return "deny";
  return "neutral";
}

function withState(
  ow: PermissionOverwrite,
  key: PermissionName,
  next: TriState,
): PermissionOverwrite {
  const allow = ow.allow.filter((k) => k !== key);
  const deny = ow.deny.filter((k) => k !== key);
  if (next === "allow") allow.push(key);
  if (next === "deny") deny.push(key);
  return { ...ow, allow, deny };
}

interface ChannelOverwritesProps {
  overwrites: PermissionOverwrite[];
  onChange: (next: PermissionOverwrite[]) => void;
  roles: CustomRole[];
  members: { userId: string; displayName: string }[];
  /** Enables the "view as" preview, which asks the server to resolve. */
  roomId?: string;
  channelId?: string;
  /** Rendered above the list — the category inherit toggle, when relevant. */
  header?: React.ReactNode;
}

/**
 * Asks the server to resolve what a role or member ends up with in this
 * channel. The rules layer three deep, so reading them off the editor is not
 * something anyone should have to do in their head.
 */
function ViewAsPreview({
  roomId,
  channelId,
  roles,
  members,
}: {
  roomId: string;
  channelId: string;
  roles: CustomRole[];
  members: { userId: string; displayName: string }[];
}) {
  const [target, setTarget] = useState<string>("");
  const [resolved, setResolved] = useState<RolePermissions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Clearing is done by the select's handler, so the effect body never has to
    // setState synchronously.
    if (!target) return;
    let cancelled = false;
    const [kind, id] = target.split(":");
    apiGetMyPermissions(roomId, channelId, kind === "role" ? { role: id } : { user: id })
      .then((data) => {
        if (cancelled) return;
        setResolved(data.permissions);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setResolved(null);
        setError(e instanceof Error ? e.message : "Could not resolve");
      });
    return () => {
      cancelled = true;
    };
  }, [target, roomId, channelId]);

  return (
    <div className="rounded-md border p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <Label className="text-xs text-muted-foreground">View as</Label>
        <select
          className="ml-auto text-xs bg-transparent border border-input rounded px-1.5 py-0.5 max-w-[55%]"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setResolved(null);
            setError(null);
          }}
        >
          <option value="">Nobody</option>
          {roles.length > 0 && (
            <optgroup label="Roles">
              {roles.map((r) => (
                <option key={r.role_id} value={`role:${r.role_id}`}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
          {members.length > 0 && (
            <optgroup label="Members">
              {members.map((m) => (
                <option key={m.userId} value={`user:${m.userId}`}>
                  {m.displayName}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {error && <p className="text-3xs text-destructive">{error}</p>}
      {target && resolved && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {CHANNEL_PERMISSIONS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-1.5">
              {resolved[key] ? (
                <Check className="h-3 w-3 text-green-500 shrink-0" />
              ) : (
                <X className="h-3 w-3 text-destructive shrink-0" />
              )}
              <span
                className={cn(
                  "text-3xs truncate",
                  resolved[key] ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </div>
          ))}
        </div>
      )}
      {(!target || !resolved) && !error && (
        <p className="text-3xs text-muted-foreground/70 italic">
          Pick a role or member to see what they end up with here.
        </p>
      )}
    </div>
  );
}

/**
 * Editor for a channel's permission overwrites. Each row targets everyone, one
 * role, or one member, and each permission is allow / deny / inherit.
 */
export function ChannelOverwrites({
  overwrites,
  onChange,
  roles,
  members,
  roomId,
  channelId,
  header,
}: ChannelOverwritesProps) {
  const [adding, setAdding] = useState(false);

  const roleName = useMemo(
    () => new Map(roles.map((r) => [r.role_id, r] as const)),
    [roles],
  );

  const labelFor = (ow: PermissionOverwrite) => {
    if (ow.target_type === "everyone") return { text: "Everyone", color: undefined };
    if (ow.target_type === "role") {
      const role = roleName.get(ow.target_id);
      return { text: role?.name ?? "Deleted role", color: role?.color || undefined };
    }
    const member = members.find((m) => m.userId === ow.target_id);
    return { text: member?.displayName ?? displayUserId(ow.target_id), color: undefined };
  };

  const alreadyTargeted = (type: string, id: string) =>
    overwrites.some((o) => o.target_type === type && o.target_id === id);

  const addOverwrite = (target_type: PermissionOverwrite["target_type"], target_id: string) => {
    if (alreadyTargeted(target_type, target_id)) return;
    onChange([...overwrites, { target_type, target_id, allow: [], deny: [] }]);
    setAdding(false);
  };

  return (
    <div className="space-y-2">
      <div>
        <Label className="text-xs text-muted-foreground">Channel permission overwrites</Label>
        <p className="text-3xs text-muted-foreground/70">
          Applied over each member's room permissions: Everyone first, then their roles, then
          them specifically. Owners and moderators are not affected.
        </p>
      </div>

      {header}

      {overwrites.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground/70 italic">
          No overwrites — everyone follows their room permissions here.
        </p>
      )}

      {overwrites.map((ow, i) => {
        const { text, color } = labelFor(ow);
        return (
          <div key={`${ow.target_type}:${ow.target_id}:${i}`} className="rounded-md border p-2">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-sm font-medium" style={{ color }}>
                {text}
              </span>
              <span className="text-3xs uppercase tracking-wider text-muted-foreground">
                {ow.target_type}
              </span>
              <button
                className="ml-auto text-muted-foreground hover:text-destructive cursor-pointer"
                title="Remove overwrite"
                onClick={() => onChange(overwrites.filter((_, idx) => idx !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1">
              {CHANNEL_PERMISSIONS.map(({ key, label }) => {
                const current = stateOf(ow, key);
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs flex-1 min-w-0 truncate">{label}</span>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {(
                        [
                          ["deny", X, "Deny"],
                          ["neutral", Minus, "Inherit"],
                          ["allow", Check, "Allow"],
                        ] as const
                      ).map(([value, Icon, title]) => (
                        <button
                          key={value}
                          title={title}
                          aria-pressed={current === value}
                          className={cn(
                            "h-5 w-5 rounded flex items-center justify-center transition-colors cursor-pointer",
                            current === value
                              ? value === "deny"
                                ? "bg-destructive/20 text-destructive"
                                : value === "allow"
                                  ? "bg-green-500/20 text-green-500"
                                  : "bg-accent text-foreground"
                              : "text-muted-foreground/50 hover:text-foreground hover:bg-accent/50",
                          )}
                          onClick={() =>
                            onChange(
                              overwrites.map((o, idx) =>
                                idx === i ? withState(o, key, value) : o,
                              ),
                            )
                          }
                        >
                          <Icon className="h-3 w-3" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {adding ? (
        <div className="rounded-md border p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Add overwrite for</span>
            <button
              className="text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => setAdding(false)}
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {!alreadyTargeted("everyone", "") && (
              <button
                className="w-full text-left text-xs px-2 py-1 rounded hover:bg-accent cursor-pointer"
                onClick={() => addOverwrite("everyone", "")}
              >
                Everyone
              </button>
            )}
            {roles
              .filter((r) => !alreadyTargeted("role", r.role_id))
              .map((r) => (
                <button
                  key={r.role_id}
                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-accent cursor-pointer"
                  style={{ color: r.color || undefined }}
                  onClick={() => addOverwrite("role", r.role_id)}
                >
                  {r.name}
                </button>
              ))}
            {members
              .filter((m) => !alreadyTargeted("user", m.userId))
              .map((m) => (
                <button
                  key={m.userId}
                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-accent cursor-pointer text-muted-foreground"
                  onClick={() => addOverwrite("user", m.userId)}
                >
                  {m.displayName}
                </button>
              ))}
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3 w-3" />
          Add overwrite
        </Button>
      )}

      {roomId && channelId && (
        <ViewAsPreview
          roomId={roomId}
          channelId={channelId}
          roles={roles}
          members={members}
        />
      )}
    </div>
  );
}
