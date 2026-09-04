import { useState } from "react";
import { useAppContext } from "@/lib/store";
import { Trash2, Plus } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import type { RolePermissions } from "@/lib/api";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";

const DEFAULT_PERMS: RolePermissions = {
  send_messages: true,
  manage_channels: false,
  manage_roles: false,
  manage_messages: false,
  kick_members: false,
  ban_members: false,
  mention_everyone: false,
};

const PERM_LABELS: Record<keyof RolePermissions, string> = {
  send_messages: "Send Messages",
  manage_channels: "Manage Channels",
  manage_roles: "Manage Roles",
  manage_messages: "Manage Messages",
  kick_members: "Kick Members",
  ban_members: "Ban Members",
  mention_everyone: "Mention Everyone",
};

interface RoleManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RoleManagementDialog({ open, onOpenChange }: RoleManagementDialogProps) {
  const confirm = useConfirm();
  const { state, createRole, updateRole, deleteRole } = useAppContext();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const [newPerms, setNewPerms] = useState<RolePermissions>({ ...DEFAULT_PERMS });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editPerms, setEditPerms] = useState<RolePermissions>({ ...DEFAULT_PERMS });

  const roomId = state.currentRoomId;
  if (!roomId) return null;

  const roles = [...state.customRoles].sort((a, b) => a.position - b.position);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await createRole(roomId, newName.trim(), newColor, newPerms);
      setCreating(false);
      setNewName("");
      setNewColor("#6366f1");
      setNewPerms({ ...DEFAULT_PERMS });
    } catch (err: any) {
      toast.error(err.message || "Failed to create role");
    }
  };

  const startEdit = (roleId: string) => {
    const r = roles.find((x) => x.role_id === roleId);
    if (!r) return;
    setEditingId(roleId);
    setEditName(r.name);
    setEditColor(r.color || "#6366f1");
    setEditPerms({ ...DEFAULT_PERMS, ...r.permissions });
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    try {
      await updateRole(roomId, editingId, { name: editName.trim(), color: editColor, permissions: editPerms });
      setEditingId(null);
    } catch (err: any) {
      toast.error(err.message || "Failed to update role");
    }
  };

  const handleDelete = async (roleId: string) => {
    if (!(await confirm({ title: "Delete this role?", description: "It is removed from all members and channels.", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await deleteRole(roomId, roleId);
    } catch (err: any) {
      toast.error(err.message || "Failed to delete role");
    }
  };

  const renderPermsCheckboxes = (
    perms: RolePermissions,
    setPerms: (p: RolePermissions) => void
  ) => (
    <div className="grid grid-cols-2 gap-1">
      {(Object.keys(PERM_LABELS) as (keyof RolePermissions)[]).map((key) => (
        <label key={key} className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={perms[key]}
            onChange={(e) => setPerms({ ...perms, [key]: e.target.checked })}
            className="rounded border-input"
          />
          <span className="text-xs">{PERM_LABELS[key]}</span>
        </label>
      ))}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Roles</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-3 pr-2">
            {/* Existing roles */}
            {roles.map((r) => (
              <div key={r.role_id} className="rounded-md border p-2 space-y-2">
                {editingId === r.role_id ? (
                  <>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={editColor}
                        onChange={(e) => setEditColor(e.target.value)}
                        className="h-7 w-7 rounded cursor-pointer border-0 p-0"
                      />
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-7 text-sm"
                        onKeyDown={(e) => e.key === "Enter" && handleSaveEdit()}
                      />
                    </div>
                    <Label className="text-xs text-muted-foreground">Permissions</Label>
                    {renderPermsCheckboxes(editPerms, setEditPerms)}
                    <div className="flex gap-1 justify-end">
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                      <Button size="sm" className="h-6 text-xs" onClick={handleSaveEdit}>Save</Button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full shrink-0" style={{ background: r.color || "#6366f1" }} />
                    <span className="text-sm font-medium flex-1 truncate" style={{ color: r.color || undefined }}>{r.name}</span>
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => startEdit(r.role_id)}>Edit</Button>
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-destructive" onClick={() => handleDelete(r.role_id)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </div>
            ))}

            {roles.length === 0 && !creating && (
              <p className="text-xs text-muted-foreground text-center py-4">No custom roles yet</p>
            )}

            {/* Create form */}
            {creating ? (
              <div className="rounded-md border border-primary/50 p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={newColor}
                    onChange={(e) => setNewColor(e.target.value)}
                    className="h-7 w-7 rounded cursor-pointer border-0 p-0"
                  />
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Role name"
                    className="h-7 text-sm"
                    onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                    autoFocus
                  />
                </div>
                <Label className="text-xs text-muted-foreground">Permissions</Label>
                {renderPermsCheckboxes(newPerms, setNewPerms)}
                <div className="flex gap-1 justify-end">
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setCreating(false)}>Cancel</Button>
                  <Button size="sm" className="h-6 text-xs" onClick={handleCreate} disabled={!newName.trim()}>Create</Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full text-xs"
                onClick={() => setCreating(true)}
              >
                <Plus className="h-3 w-3 mr-1" /> Create Role
              </Button>
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
