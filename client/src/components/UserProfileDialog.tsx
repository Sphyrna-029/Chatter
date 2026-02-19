import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile, apiListUploads, apiDeleteUpload } from "@/lib/api";
import type { UploadRecord } from "@/lib/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STATUS_OPTIONS = [
  { value: "online", label: "Online", color: "bg-green-500" },
  { value: "away", label: "Away", color: "bg-yellow-500" },
  { value: "dnd", label: "Do Not Disturb", color: "bg-red-500" },
  { value: "offline", label: "Invisible", color: "bg-muted-foreground" },
] as const;

function statusColor(status: string) {
  if (status === "active" || status === "online") return "bg-green-500";
  if (status === "idle" || status === "away") return "bg-yellow-500";
  if (status === "dnd") return "bg-red-500";
  return "bg-muted-foreground";
}

function statusLabel(status: string) {
  if (status === "active" || status === "online") return "Online";
  if (status === "idle" || status === "away") return "Away";
  if (status === "dnd") return "Do Not Disturb";
  return "Offline";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isImageFile(filename: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg|bmp|ico|avif)$/i.test(filename);
}

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
  const { state, openDM, updateProfile, setManualStatus } = useAppContext();
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
  const [activeTab, setActiveTab] = useState("profile");

  // My Files state
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(false);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStatusInput(customStatus);
      setAboutInput(about);
      setAvatarPreview(avatarUrl);
      setPendingAvatarFile(null);
      setActiveTab("profile");
    }
  }, [open, customStatus, about, avatarUrl]);

  const fetchUploads = useCallback(async () => {
    setLoadingUploads(true);
    try {
      const files = await apiListUploads();
      setUploads(files);
    } catch {
      // ignore
    } finally {
      setLoadingUploads(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "files" && isSelf) {
      fetchUploads();
    }
  }, [activeTab, isSelf, fetchUploads]);

  const handleDeleteUpload = async (url: string) => {
    setDeletingUrl(url);
    try {
      await apiDeleteUpload(url);
      setUploads((prev) => prev.filter((f) => f.url !== url));
    } catch {
      // ignore
    } finally {
      setDeletingUrl(null);
    }
  };

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

  const profileContent = (
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

      {isSelf ? (
        <div className="w-full">
          <p className="text-xs font-medium text-muted-foreground mb-2">Status</p>
          <div className="grid grid-cols-2 gap-1.5">
            {STATUS_OPTIONS.map((opt) => {
              const isActive = status === opt.value ||
                (opt.value === "online" && status === "active") ||
                (opt.value === "away" && status === "idle");
              return (
                <button
                  key={opt.value}
                  onClick={() => setManualStatus(opt.value)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors cursor-pointer text-left",
                    isActive
                      ? "bg-accent text-foreground font-medium"
                      : "hover:bg-accent/50 text-muted-foreground"
                  )}
                >
                  <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", opt.color)} />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className={cn("h-2.5 w-2.5 rounded-full", statusColor(status))} />
          <span className="text-sm">{statusLabel(status)}</span>
        </div>
      )}

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
  );

  const filesContent = (
    <div className="py-2">
      {loadingUploads ? (
        <p className="text-sm text-muted-foreground text-center py-8">Loading files...</p>
      ) : uploads.length === 0 ? (
        <div className="text-center py-8">
          <svg className="mx-auto h-10 w-10 text-muted-foreground/50 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
          </svg>
          <p className="text-sm text-muted-foreground">No uploaded files yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Files you upload in chat will appear here</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 max-h-[360px] overflow-y-auto pr-1">
          {uploads.map((file) => (
            <div
              key={file.url}
              className="group relative border rounded-lg overflow-hidden bg-muted/30"
            >
              {isImageFile(file.filename) ? (
                <a href={file.url} target="_blank" rel="noopener noreferrer">
                  <img
                    src={file.url}
                    alt={file.filename}
                    className="w-full h-24 object-cover"
                  />
                </a>
              ) : (
                <a
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full h-24 flex flex-col items-center justify-center gap-1 px-2"
                >
                  <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  <span className="text-xs text-muted-foreground truncate max-w-full">{file.filename}</span>
                </a>
              )}
              <div className="px-2 py-1.5 space-y-0.5">
                <p className="text-xs font-medium truncate" title={file.filename}>{file.filename}</p>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    {formatFileSize(file.size)} &middot;{" "}
                    {new Date(file.uploaded_at * 1000).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <button
                    onClick={() => handleDeleteUpload(file.url)}
                    disabled={deletingUrl === file.url}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-destructive/20 text-destructive"
                    title="Delete file"
                  >
                    {deletingUrl === file.url ? (
                      <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07l-2.83 2.83M9.76 14.24l-2.83 2.83m11.14 0l-2.83-2.83M9.76 9.76L6.93 6.93" />
                      </svg>
                    ) : (
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(
        "transition-all duration-200",
        isSelf && activeTab === "files" ? "sm:max-w-[440px]" : "sm:max-w-[340px]"
      )}>
        <DialogHeader>
          <DialogTitle className="sr-only">User Profile</DialogTitle>
        </DialogHeader>
        {isSelf ? (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full">
              <TabsTrigger value="profile" className="flex-1">Profile</TabsTrigger>
              <TabsTrigger value="files" className="flex-1">My Files</TabsTrigger>
            </TabsList>
            <TabsContent value="profile">{profileContent}</TabsContent>
            <TabsContent value="files">{filesContent}</TabsContent>
          </Tabs>
        ) : (
          profileContent
        )}
      </DialogContent>
    </Dialog>
  );
}
