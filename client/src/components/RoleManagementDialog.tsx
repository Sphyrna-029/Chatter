import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/lib/store";
import { ChevronDown, ChevronUp, Plus, Shield, Trash2, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { can } from "@/lib/permissions";
import {
  DEFAULT_PERMISSIONS,
  PERMISSION_SECTIONS,
  type PermissionMeta,
} from "@/lib/permissionMeta";
import type { CustomRole, RolePermissions } from "@/lib/api";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";

const DEFAULT_ROLE_COLOR = "#6366f1";

interface RoleManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One permission row: a switch, its name, and what it actually does. */
function PermissionRow({
  meta,
  value,
  onChange,
  grantable,
}: {
  meta: PermissionMeta;
  value: boolean;
  onChange: (next: boolean) => void;
  grantable: boolean;
}) {
  const row = (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md px-2 py-1.5 transition-colors",
        grantable ? "hover:bg-accent/40" : "opacity-60",
      )}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-tight">{meta.label}</p>
        <p className="text-3xs text-muted-foreground leading-snug mt-0.5">{meta.description}</p>
      </div>
      <Switch
        checked={value}
        disabled={!grantable}
        onCheckedChange={onChange}
        className="mt-0.5 shrink-0"
        aria-label={meta.label}
      />
    </div>
  );

  if (grantable) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{row}</div>
      </TooltipTrigger>
      <TooltipContent side="left">You do not hold this permission yourself</TooltipContent>
    </Tooltip>
  );
}

export function RoleManagementDialog({ open, onOpenChange }: RoleManagementDialogProps) {
  const confirm = useConfirm();
  const { state, createRole, updateRole, deleteRole } = useAppContext();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(DEFAULT_ROLE_COLOR);
  const [draftPerms, setDraftPerms] = useState<RolePermissions>({ ...DEFAULT_PERMISSIONS });
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const roomId = state.currentRoomId;

  // Ordered strongest first: a lower position outranks, matching the server.
  const roles = useMemo(
    () => [...state.customRoles].sort((a, b) => a.position - b.position),
    [state.customRoles],
  );

  const memberCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const roleIds of Object.values(state.memberCustomRoles)) {
      for (const id of roleIds) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }, [state.memberCustomRoles]);

  const loadRole = (role: CustomRole) => {
    setCreating(false);
    setSelectedId(role.role_id);
    setDraftName(role.name);
    setDraftColor(role.color || DEFAULT_ROLE_COLOR);
    setDraftPerms({ ...DEFAULT_PERMISSIONS, ...role.permissions });
  };

  // Select something sensible whenever the dialog opens or the list changes.
  useEffect(() => {
    if (!open) return;
    if (creating) return;
    if (selectedId && roles.some((r) => r.role_id === selectedId)) return;
    const first = roles[0];
    if (first) loadRole(first);
    else setSelectedId(null);
  }, [open, roles, selectedId, creating]);

  if (!roomId) return null;

  const startCreating = () => {
    setCreating(true);
    setSelectedId(null);
    setDraftName("");
    setDraftColor(DEFAULT_ROLE_COLOR);
    // New roles start from nothing granted, so a role only ever adds.
    setDraftPerms({ ...DEFAULT_PERMISSIONS });
  };

  const handleSave = async () => {
    const name = draftName.trim();
    if (!name) return;
    setSaving(true);
    try {
      if (creating) {
        await createRole(roomId, name, draftColor, draftPerms);
        setCreating(false);
      } else if (selectedId) {
        await updateRole(roomId, selectedId, {
          name,
          color: draftColor,
          permissions: draftPerms,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save role");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (roleId: string) => {
    if (
      !(await confirm({
        title: "Delete this role?",
        description: "It is removed from every member, channel, and category.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;
    try {
      await deleteRole(roomId, roleId);
      if (selectedId === roleId) setSelectedId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete role");
    }
  };

  /** Reordering is what makes hierarchy usable: position decides who may act
   *  on whom, so swapping two neighbours swaps their authority. */
  const move = async (index: number, direction: -1 | 1) => {
    const role = roles[index];
    const swap = roles[index + direction];
    if (!role || !swap) return;
    try {
      await updateRole(roomId, role.role_id, { position: swap.position });
      await updateRole(roomId, swap.role_id, { position: role.position });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reorder roles");
    }
  };

  const editing = creating || selectedId !== null;
  const dirtyLabel = creating ? "Create role" : "Save changes";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            Roles
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-4 min-h-0 h-[26rem] max-h-[60vh] overflow-hidden">
          {/* Role list, strongest first */}
          <div className="w-52 shrink-0 flex flex-col min-h-0 border-r pr-3">
            <p className="text-3xs uppercase tracking-wider text-muted-foreground mb-1.5">
              Highest first
            </p>
            <ScrollArea className="flex-1 min-h-0 -mr-2 pr-2">
              <div className="space-y-0.5">
                {roles.map((r, i) => (
                  <div
                    key={r.role_id}
                    className={cn(
                      "group flex items-center gap-1.5 rounded-md px-2 py-1.5 cursor-pointer transition-colors",
                      selectedId === r.role_id && !creating
                        ? "bg-accent"
                        : "hover:bg-accent/50",
                    )}
                    role="button"
                    tabIndex={0}
                    onClick={() => loadRole(r)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        loadRole(r);
                      }
                    }}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ background: r.color || DEFAULT_ROLE_COLOR }}
                    />
                    <span
                      className="text-sm flex-1 min-w-0 truncate"
                      style={{ color: r.color || undefined }}
                    >
                      {r.name}
                    </span>
                    <span className="text-3xs text-muted-foreground inline-flex items-center gap-0.5 shrink-0">
                      <Users className="h-2.5 w-2.5" />
                      {memberCounts[r.role_id] ?? 0}
                    </span>
                    <div className="flex flex-col can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
                        disabled={i === 0}
                        title="Move up"
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, -1);
                        }}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
                        disabled={i === roles.length - 1}
                        title="Move down"
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, 1);
                        }}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
                {roles.length === 0 && (
                  <p className="text-xs text-muted-foreground py-3 text-center">
                    No roles yet
                  </p>
                )}
              </div>
            </ScrollArea>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-xs w-full shrink-0"
              onClick={startCreating}
            >
              <Plus className="h-3 w-3" />
              New role
            </Button>
          </div>

          {/* Editor */}
          {editing ? (
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              <div className="flex items-end gap-2 mb-3 shrink-0">
                <div className="flex-1 min-w-0">
                  <Label className="text-xs text-muted-foreground">Name</Label>
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder="Role name"
                    className="h-8 mt-1"
                    onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Colour</Label>
                  <input
                    type="color"
                    value={draftColor}
                    onChange={(e) => setDraftColor(e.target.value)}
                    className="h-8 w-10 rounded cursor-pointer border-0 p-0 mt-1 block"
                    title="Role colour"
                  />
                </div>
                {!creating && selectedId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    title="Delete role"
                    onClick={() => handleDelete(selectedId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <ScrollArea className="flex-1 min-h-0 -mr-2 pr-2">
                <div className="space-y-3">
                  {PERMISSION_SECTIONS.map((section) => (
                    <div key={section.title}>
                      <p className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground mb-0.5 px-2">
                        {section.title}
                      </p>
                      <div className="space-y-0.5">
                        {section.permissions.map((meta) => (
                          <PermissionRow
                            key={meta.key}
                            meta={meta}
                            value={draftPerms[meta.key]}
                            grantable={can(state, meta.key)}
                            onChange={(next) =>
                              setDraftPerms((prev) => ({ ...prev, [meta.key]: next }))
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <div className="flex justify-end gap-2 pt-3 shrink-0">
                {creating && (
                  <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                )}
                <Button size="sm" onClick={handleSave} disabled={!draftName.trim() || saving}>
                  {dirtyLabel}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">
                Select a role, or create one.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
