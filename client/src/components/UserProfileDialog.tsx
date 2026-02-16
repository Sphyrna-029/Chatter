import { useMemo, useState, useEffect, useRef } from "react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile } from "@/lib/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UserProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  displayName: string;
}

export function UserProfileDialog({
  open,
  onOpenChange,
  userId,
  displayName,
}: UserProfileDialogProps) {
  const { state, openDM, updateProfile } = useAppContext();
  const isSelf = userId === state.userId;
  const presence = state.userPresence[userId];
  const status = presence?.status || "offline";
  const customStatus = presence?.customStatus || "";
  const avatarUrl = presence?.avatarUrl || "";
  const about = presence?.about || "";
  const initial = displayName[0]?.toUpperCase() || "?";

  const [statusInput, setStatusInput] = useState(customStatus);
  const [aboutInput, setAboutInput] = useState(about);
  const [avatarPreview, setAvatarPreview] = useState(avatarUrl);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setStatusInput(customStatus);
      setAboutInput(about);
      setAvatarPreview(avatarUrl);
      setPendingAvatarFile(null);
    }
  }, [open, customStatus, about, avatarUrl]);

  const joinDate = useMemo(() => {
    const joinMsg = state.messages.find(
      (m) =>
        m.content.msgtype === "m.system" &&
        m.sender === userId &&
        m.content.body.includes("has joined")
    );
    if (!joinMsg) return null;
    return new Date(joinMsg.origin_server_ts);
  }, [state.messages, userId]);

  const handleMessage = async () => {
    await openDM(userId);
    onOpenChange(false);
  };

  const handleAvatarClick = () => {
    if (isSelf) fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
    e.target.value = "";
  };

  const handleSave = async () => {
    setUploading(true);
    try {
      let newAvatarUrl: string | undefined;
      if (pendingAvatarFile) {
        const uploaded = await apiUploadFile(pendingAvatarFile);
        newAvatarUrl = uploaded.url;
      }
      updateProfile({
        avatarUrl: newAvatarUrl !== undefined ? newAvatarUrl : undefined,
        about: aboutInput.trim(),
        customStatus: statusInput.trim(),
      });
      onOpenChange(false);
    } finally {
      setUploading(false);
    }
  };

  const hasChanges =
    statusInput.trim() !== customStatus ||
    aboutInput.trim() !== about ||
    pendingAvatarFile !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[340px]">
        <DialogHeader>
          <DialogTitle className="sr-only">User Profile</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-2">
          <div
            className={cn("relative", isSelf && "cursor-pointer group")}
            onClick={handleAvatarClick}
          >
            <Avatar className="h-20 w-20">
              {avatarPreview && <AvatarImage src={avatarPreview} />}
              <AvatarFallback className="text-2xl bg-secondary">
                {initial}
              </AvatarFallback>
            </Avatar>
            {isSelf && (
              <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 16 16" fill="white">
                  <path d="M10.5 8.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z" />
                  <path d="M2 4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1.172a2 2 0 0 1-1.414-.586l-.828-.828A2 2 0 0 0 9.172 2H6.828a2 2 0 0 0-1.414.586l-.828.828A2 2 0 0 1 3.172 4H2zm.5 2a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1zm9 2.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z" />
                </svg>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          <div className="text-center space-y-1">
            <h2 className="text-lg font-semibold">{displayName}</h2>
            <p className="text-sm text-muted-foreground">{userId}</p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full",
                status === "active" && "bg-green-500",
                status === "idle" && "bg-yellow-500",
                status === "offline" && "bg-muted-foreground"
              )}
            />
            <span className="text-sm capitalize">{status}</span>
          </div>

          {isSelf ? (
            <div className="w-full space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Custom Status</label>
                <Input
                  value={statusInput}
                  onChange={(e) => setStatusInput(e.target.value)}
                  placeholder="Set a status..."
                  className="text-sm"
                  maxLength={80}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">About Me</label>
                <Textarea
                  value={aboutInput}
                  onChange={(e) => setAboutInput(e.target.value)}
                  placeholder="Tell others about yourself..."
                  className="text-sm resize-none"
                  maxLength={200}
                  rows={3}
                />
                <p className="text-[10px] text-muted-foreground text-right">{aboutInput.length}/200</p>
              </div>
              <Button
                className="w-full"
                onClick={handleSave}
                disabled={!hasChanges || uploading}
              >
                {uploading ? "Saving..." : "Save"}
              </Button>
            </div>
          ) : (
            <>
              {customStatus && (
                <p className="text-sm text-muted-foreground italic">"{customStatus}"</p>
              )}
              {about && (
                <div className="w-full space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">About Me</label>
                  <p className="text-sm text-foreground">{about}</p>
                </div>
              )}
            </>
          )}

          {joinDate && (
            <p className="text-xs text-muted-foreground">
              Joined{" "}
              {joinDate.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          )}

          {!isSelf && (
            <Button className="w-full mt-2" onClick={handleMessage}>
              Message
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
