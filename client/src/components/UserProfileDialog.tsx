import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile, apiListUploads, apiDeleteUpload, apiChangePassword, apiDeleteAccount, apiGetRecoveryCodes, apiSetupTotp, apiVerifyTotp, setAccessToken, setRefreshToken, setIsAdmin, setTotpVerified } from "@/lib/api";
import type { UploadRecord } from "@/lib/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, displayUserId } from "@/lib/utils";
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
  const { state, dispatch, openDM, updateProfile, setManualStatus, kickMember, banMember, setMemberRole, deleteAccount, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend, blockUser, unblockUser } = useAppContext();
  const isSelf = userId === state.userId;
  const username = displayUserId(userId) || displayName;
  const presence = state.userPresence[userId];
  const status = presence?.status || "offline";
  const customStatus = presence?.customStatus || "";
  const avatarUrl = presence?.avatarUrl || "";
  const about = presence?.about || "";
  const bannerUrl = presence?.bannerUrl || "";
  const initial = displayName[0]?.toUpperCase() || "?";

  const nicknameFromPresence = presence?.displayName || "";
  const [nicknameInput, setNicknameInput] = useState(nicknameFromPresence);
  const [statusInput, setStatusInput] = useState(customStatus);
  const [aboutInput, setAboutInput] = useState(about);
  const [avatarPreview, setAvatarPreview] = useState(avatarUrl);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [bannerPreview, setBannerPreview] = useState(bannerUrl);
  const [pendingBannerFile, setPendingBannerFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const [pendingFontFile, setPendingFontFile] = useState<File | null>(null);
  const nameFontUrl = presence?.nameFontUrl || "";
  const [activeTab, setActiveTab] = useState("profile");

  // My Files state
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(false);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);

  // Account tab state
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordTotpCode, setPasswordTotpCode] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [deleteTotpCode, setDeleteTotpCode] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Recovery codes state
  const [recoveryTotpCode, setRecoveryTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [showRecoveryInput, setShowRecoveryInput] = useState(false);

  // 2FA setup state
  const [totpSetupData, setTotpSetupData] = useState<{ totp_secret: string; totp_uri: string; totp_qr_base64: string } | null>(null);
  const [totpSetupCode, setTotpSetupCode] = useState("");
  const [totpSetupStep, setTotpSetupStep] = useState<"idle" | "qr" | "recovery">("idle");
  const [totpSetupLoading, setTotpSetupLoading] = useState(false);
  const [totpSetupError, setTotpSetupError] = useState<string | null>(null);
  const [totpSetupRecoveryCodes, setTotpSetupRecoveryCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (open) {
      setNicknameInput(nicknameFromPresence);
      setStatusInput(customStatus);
      setAboutInput(about);
      setAvatarPreview(avatarUrl);
      setPendingAvatarFile(null);
      setBannerPreview(bannerUrl);
      setPendingBannerFile(null);
      setPendingFontFile(null);
      setActiveTab("profile");
      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordTotpCode("");
      setPasswordMessage(null);
      setDeleteTotpCode("");
      setDeleteError(null);
      setConfirmDelete(false);
      setRecoveryTotpCode("");
      setRecoveryCodes(null);
      setRecoveryError(null);
      setShowRecoveryInput(false);
      setTotpSetupData(null);
      setTotpSetupCode("");
      setTotpSetupStep("idle");
      setTotpSetupError(null);
      setTotpSetupRecoveryCodes(null);
      setTotpSetupLoading(false);
    }
  }, [open, customStatus, about, avatarUrl, bannerUrl, nicknameFromPresence]);

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
    const member = state.roomMembers.find((m) => m.userId === userId);
    if (member?.joinedAt) return new Date(member.joinedAt);
    return null;
  }, [state.roomMembers, userId]);

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

  const handleBannerClick = () => {
    if (isSelf) bannerInputRef.current?.click();
  };

  const handleBannerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingBannerFile(file);
    setBannerPreview(URL.createObjectURL(file));
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
      let newBannerUrl: string | undefined;
      if (pendingBannerFile) {
        const uploaded = await apiUploadFile(pendingBannerFile);
        newBannerUrl = uploaded.url;
      }
      let newFontUrl: string | undefined;
      if (pendingFontFile) {
        const uploaded = await apiUploadFile(pendingFontFile);
        newFontUrl = uploaded.url;
      }
      updateProfile({
        avatarUrl: newAvatarUrl !== undefined ? newAvatarUrl : undefined,
        bannerUrl: newBannerUrl !== undefined ? newBannerUrl : undefined,
        about: aboutInput.trim(),
        customStatus: statusInput.trim(),
        displayName: nicknameInput.trim(),
        ...(newFontUrl !== undefined ? { nameFontUrl: newFontUrl } : {}),
      });
      onOpenChange(false);
    } finally {
      setUploading(false);
    }
  };

  const hasChanges =
    nicknameInput.trim() !== nicknameFromPresence ||
    statusInput.trim() !== customStatus ||
    aboutInput.trim() !== about ||
    pendingAvatarFile !== null ||
    pendingBannerFile !== null ||
    pendingFontFile !== null;

  const profileContent = (
    <div className="flex flex-col">
      {/* Banner */}
      <div
        className={cn("relative h-28 w-full overflow-hidden bg-secondary shrink-0", isSelf && "cursor-pointer group")}
        onClick={handleBannerClick}
      >
        {bannerPreview ? (
          <img src={bannerPreview} alt="Profile banner" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-muted to-secondary" />
        )}
        {/* Fade to dialog background */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background pointer-events-none" />
        {isSelf && (
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <span className="text-white text-xs font-medium">Change Banner</span>
          </div>
        )}
        <input
          ref={bannerInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleBannerChange}
        />
      </div>

      {/* Avatar — overlaps banner bottom */}
      <div className="px-5 -mt-9 mb-1 flex items-end gap-3">
        <div
          className={cn("relative shrink-0", isSelf && "cursor-pointer group")}
          onClick={handleAvatarClick}
        >
          <Avatar className="h-16 w-16 border-4 border-background">
            {avatarPreview && <AvatarImage src={avatarPreview} />}
            <AvatarFallback className="text-xl bg-secondary">
              {initial}
            </AvatarFallback>
          </Avatar>
          {isSelf && (
            <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="white">
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
      </div>

      {/* Rest of profile content */}
      <div className="flex flex-col items-center gap-4 px-5 pb-5">
        <div className="text-center space-y-1 w-full">
          <h2 className="text-lg font-semibold">{presence?.displayName || username}</h2>
          {presence?.displayName && (
            <p className="text-xs text-muted-foreground/70">{username}</p>
          )}
          <p className="text-sm text-muted-foreground">{userId}</p>
        </div>

      {isSelf ? (
        <>
        <div className="w-full space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Display Name</label>
          <Input
            value={nicknameInput}
            onChange={(e) => setNicknameInput(e.target.value)}
            placeholder="Set a display name..."
            className="text-sm"
            maxLength={32}
          />
        </div>
        <div className="w-full">
          <p className="text-xs font-medium text-muted-foreground mb-2">Status</p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-input bg-background text-sm hover:bg-accent/50 transition-colors">
                {(() => {
                  const active = STATUS_OPTIONS.find(
                    (o) => o.value === status ||
                      (o.value === "online" && status === "active") ||
                      (o.value === "away" && status === "idle")
                  ) ?? STATUS_OPTIONS[0];
                  return (
                    <>
                      <span className="flex items-center gap-2">
                        <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", active.color)} />
                        {active.label}
                      </span>
                      <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </>
                  );
                })()}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-[--radix-dropdown-menu-trigger-width]">
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setManualStatus(opt.value)}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", opt.color)} />
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </>
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
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Name Font</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-foreground truncate flex-1">
                {pendingFontFile
                  ? pendingFontFile.name
                  : nameFontUrl
                    ? decodeURIComponent(nameFontUrl.split("/").pop() || "Custom Font")
                    : "Default"}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => fontInputRef.current?.click()}
              >
                Upload
              </Button>
              {(nameFontUrl || pendingFontFile) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-destructive"
                  onClick={() => {
                    setPendingFontFile(null);
                    if (nameFontUrl) {
                      updateProfile({ nameFontUrl: "" });
                    }
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
            <input
              ref={fontInputRef}
              type="file"
              accept=".ttf,.otf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) {
                  alert("Font file must be under 2 MB");
                  return;
                }
                setPendingFontFile(file);
                e.target.value = "";
              }}
            />
            {(pendingFontFile || nameFontUrl) && (
              <p
                className="text-sm font-semibold mt-1"
                style={
                  pendingFontFile
                    ? { fontFamily: "pending-font-preview" }
                    : nameFontUrl
                      ? { fontFamily: `'user-font-${CSS.escape(userId)}'` }
                      : undefined
                }
                ref={(el) => {
                  if (el && pendingFontFile) {
                    const reader = new FileReader();
                    reader.onload = () => {
                      const url = reader.result as string;
                      const existing = document.getElementById("font-preview-style");
                      if (existing) existing.remove();
                      const style = document.createElement("style");
                      style.id = "font-preview-style";
                      style.textContent = `@font-face { font-family: 'pending-font-preview'; src: url('${url}'); }`;
                      document.head.appendChild(style);
                    };
                    reader.readAsDataURL(pendingFontFile);
                  }
                }}
              >
                {presence?.displayName || username}
              </p>
            )}
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
        <>
          <Button className="w-full mt-2" onClick={handleMessage}>
            Message
          </Button>

          {/* Friend / Block actions */}
          {(() => {
            const isFriend = state.friends.includes(userId);
            const isBlocked = state.blockedUsers.includes(userId);
            const hasOutgoing = state.outgoingFriendRequests.some((r) => r.userId === userId);
            const hasIncoming = state.incomingFriendRequests.some((r) => r.userId === userId);

            return (
              <div className="w-full space-y-1.5">
                {isBlocked ? (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={async () => {
                      await unblockUser(userId);
                    }}
                  >
                    Unblock
                  </Button>
                ) : isFriend ? (
                  <Button
                    variant="outline"
                    className="w-full text-orange-400 border-orange-400/30 hover:bg-orange-400/10"
                    onClick={async () => {
                      await removeFriend(userId);
                    }}
                  >
                    Remove Friend
                  </Button>
                ) : hasIncoming ? (
                  <div className="flex gap-2 w-full">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={async () => {
                        await rejectFriendRequest(userId);
                      }}
                    >
                      Reject
                    </Button>
                    <Button
                      className="flex-1"
                      onClick={async () => {
                        await acceptFriendRequest(userId);
                      }}
                    >
                      Accept Request
                    </Button>
                  </div>
                ) : hasOutgoing ? (
                  <Button variant="outline" className="w-full" disabled>
                    Request Sent
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={async () => {
                      await sendFriendRequest(userId);
                    }}
                  >
                    Add Friend
                  </Button>
                )}
                {!isBlocked && (
                  <Button
                    variant="outline"
                    className="w-full text-destructive border-destructive/30 hover:bg-destructive/10"
                    onClick={async () => {
                      if (confirm(`Block ${displayName}? This will also remove any friendship or pending requests.`)) {
                        await blockUser(userId);
                        onOpenChange(false);
                      }
                    }}
                  >
                    Block User
                  </Button>
                )}
              </div>
            );
          })()}

          {state.currentRoomId && (() => {
            const myRole = state.roomMembers.find(m => m.userId === state.userId)?.role;
            const targetRole = state.roomMembers.find(m => m.userId === userId)?.role;
            const isOwner = myRole === "owner";
            const isMod = myRole === "moderator";
            const canManage = (isOwner && targetRole !== "owner") ||
              (isMod && targetRole === "member");

            if (!canManage) return null;

            return (
              <div className="w-full space-y-1.5">
                {isOwner && targetRole === "member" && (
                  <Button
                    variant="outline"
                    className="w-full text-blue-400 border-blue-400/30 hover:bg-blue-400/10"
                    onClick={async () => {
                      await setMemberRole(state.currentRoomId!, userId, "moderator");
                      onOpenChange(false);
                    }}
                  >
                    Promote to Moderator
                  </Button>
                )}
                {isOwner && targetRole === "moderator" && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={async () => {
                      await setMemberRole(state.currentRoomId!, userId, "member");
                      onOpenChange(false);
                    }}
                  >
                    Demote to Member
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="w-full text-orange-400 border-orange-400/30 hover:bg-orange-400/10"
                  onClick={async () => {
                    if (confirm(`Kick ${displayName} from this room?`)) {
                      await kickMember(state.currentRoomId!, userId);
                      onOpenChange(false);
                    }
                  }}
                >
                  Kick
                </Button>
                <Button
                  variant="outline"
                  className="w-full text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={async () => {
                    if (confirm(`Ban ${displayName} from this room? They won't be able to rejoin.`)) {
                      await banMember(state.currentRoomId!, userId);
                      onOpenChange(false);
                    }
                  }}
                >
                  Ban
                </Button>
              </div>
            );
          })()}
        </>
      )}
      </div>
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

  const handleChangePassword = async () => {
    setPasswordMessage(null);
    if (newPassword.length < 6) {
      setPasswordMessage({ type: "error", text: "Password must be at least 6 characters" });
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordMessage({ type: "error", text: "Passwords do not match" });
      return;
    }
    if (!passwordTotpCode || passwordTotpCode.length !== 6) {
      setPasswordMessage({ type: "error", text: "Enter a 6-digit authenticator code" });
      return;
    }
    setChangingPassword(true);
    try {
      await apiChangePassword(passwordTotpCode, newPassword);
      setPasswordMessage({ type: "success", text: "Password changed successfully" });
      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordTotpCode("");
    } catch (err: any) {
      setPasswordMessage({ type: "error", text: err.message || "Failed to change password" });
    } finally {
      setChangingPassword(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleteError(null);
    if (!deleteTotpCode || deleteTotpCode.length !== 6) {
      setDeleteError("Enter a 6-digit authenticator code");
      return;
    }
    setDeletingAccount(true);
    try {
      await deleteAccount(deleteTotpCode);
      onOpenChange(false);
    } catch (err: any) {
      setDeleteError(err.message || "Failed to delete account");
    } finally {
      setDeletingAccount(false);
    }
  };

  const handleGetRecoveryCodes = async () => {
    setRecoveryError(null);
    if (!recoveryTotpCode || recoveryTotpCode.length !== 6) {
      setRecoveryError("Enter a 6-digit authenticator code");
      return;
    }
    setRecoveryLoading(true);
    try {
      const result = await apiGetRecoveryCodes(recoveryTotpCode);
      setRecoveryCodes(result.recovery_codes);
      setRecoveryTotpCode("");
    } catch (err: any) {
      setRecoveryError(err.message || "Failed to get recovery codes");
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleTotpSetupStart = async () => {
    setTotpSetupLoading(true);
    setTotpSetupError(null);
    try {
      const data = await apiSetupTotp();
      setTotpSetupData(data);
      setTotpSetupStep("qr");
    } catch (err: any) {
      setTotpSetupError(err.message || "Failed to set up 2FA");
    } finally {
      setTotpSetupLoading(false);
    }
  };

  const handleTotpSetupVerify = async () => {
    if (!totpSetupCode || totpSetupCode.length !== 6) {
      setTotpSetupError("Enter a 6-digit code");
      return;
    }
    setTotpSetupLoading(true);
    setTotpSetupError(null);
    try {
      const result = await apiVerifyTotp(state.userId!, totpSetupCode);
      // Update tokens from verify response
      setAccessToken(result.access_token);
      setRefreshToken(result.refresh_token);
      if (result.is_admin !== undefined) setIsAdmin(result.is_admin);
      dispatch({ type: "LOGIN", payload: { accessToken: result.access_token, userId: result.user_id } });
      dispatch({ type: "SET_IS_ADMIN", payload: !!result.is_admin });
      setTotpVerified(true);
      dispatch({ type: "SET_TOTP_VERIFIED", payload: true });
      if (result.recovery_codes && result.recovery_codes.length > 0) {
        setTotpSetupRecoveryCodes(result.recovery_codes);
        setTotpSetupStep("recovery");
      } else {
        setTotpSetupStep("idle");
        setTotpSetupData(null);
      }
    } catch (err: any) {
      setTotpSetupError(err.message || "Verification failed");
    } finally {
      setTotpSetupLoading(false);
      setTotpSetupCode("");
    }
  };

  const accountContent = (
    <div className="px-5 py-4 space-y-6">
      {/* Two-Factor Authentication */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Two-Factor Authentication</h3>
        {state.totpVerified ? (
          <div className="flex items-center gap-2 text-sm text-green-500">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            2FA is enabled
          </div>
        ) : totpSetupStep === "idle" ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Your account does not have two-factor authentication enabled. Set it up to add an extra layer of security.
            </p>
            {totpSetupError && <p className="text-xs text-destructive">{totpSetupError}</p>}
            <Button
              onClick={handleTotpSetupStart}
              disabled={totpSetupLoading}
              variant="outline"
              className="w-full"
            >
              {totpSetupLoading ? "Setting up..." : "Set Up 2FA"}
            </Button>
          </div>
        ) : totpSetupStep === "qr" && totpSetupData ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Scan this QR code with your authenticator app, then enter the 6-digit code below.
            </p>
            <div className="flex justify-center">
              <img
                src={`data:image/png;base64,${totpSetupData.totp_qr_base64}`}
                alt="TOTP QR Code"
                className="w-40 h-40 rounded border bg-white p-1"
              />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground text-center">Or enter this key manually:</p>
              <p className="text-xs font-mono text-center break-all select-all bg-muted/30 rounded px-2 py-1">
                {totpSetupData.totp_secret}
              </p>
            </div>
            <Input
              placeholder="6-digit code"
              value={totpSetupCode}
              onChange={(e) => setTotpSetupCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              maxLength={6}
              className="text-sm font-mono tracking-widest text-center"
            />
            {totpSetupError && <p className="text-xs text-destructive">{totpSetupError}</p>}
            <div className="flex gap-2">
              <Button
                onClick={() => { setTotpSetupStep("idle"); setTotpSetupData(null); setTotpSetupError(null); }}
                variant="outline"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleTotpSetupVerify}
                disabled={totpSetupLoading}
                className="flex-1"
              >
                {totpSetupLoading ? "Verifying..." : "Verify"}
              </Button>
            </div>
          </div>
        ) : totpSetupStep === "recovery" && totpSetupRecoveryCodes ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              2FA is now enabled! Save these recovery codes in a safe place. Each code can only be used once.
            </p>
            <div className="grid grid-cols-1 gap-1 p-3 rounded-md border bg-muted/30">
              {totpSetupRecoveryCodes.map((code, i) => (
                <div key={i} className="text-center text-sm font-mono tracking-[0.3em]">
                  {code}
                </div>
              ))}
            </div>
            <Button
              onClick={() => navigator.clipboard.writeText(totpSetupRecoveryCodes.join("\n"))}
              variant="outline"
              className="w-full"
              size="sm"
            >
              Copy All Codes
            </Button>
            <Button
              onClick={() => { setTotpSetupStep("idle"); setTotpSetupData(null); setTotpSetupRecoveryCodes(null); }}
              className="w-full"
              size="sm"
            >
              Done
            </Button>
          </div>
        ) : null}
      </div>

      {/* Change Password */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Change Password</h3>
        <div className="space-y-2">
          <Input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="text-sm"
          />
          <Input
            type="password"
            placeholder="Confirm new password"
            value={confirmNewPassword}
            onChange={(e) => setConfirmNewPassword(e.target.value)}
            className="text-sm"
          />
          <Input
            placeholder="Authenticator code"
            value={passwordTotpCode}
            onChange={(e) => setPasswordTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            maxLength={6}
            className="text-sm font-mono tracking-widest"
          />
        </div>
        {passwordMessage && (
          <p className={cn("text-xs", passwordMessage.type === "success" ? "text-green-500" : "text-destructive")}>
            {passwordMessage.text}
          </p>
        )}
        <Button
          onClick={handleChangePassword}
          disabled={changingPassword}
          className="w-full"
          variant="outline"
        >
          {changingPassword ? "Changing..." : "Change Password"}
        </Button>
      </div>

      {/* Recovery Codes */}
      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Recovery Codes</h3>
        <p className="text-xs text-muted-foreground">
          Recovery codes let you sign in if you lose access to your authenticator app. Each code can only be used once.
        </p>
        {recoveryCodes ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-1 p-3 rounded-md border bg-muted/30">
              {recoveryCodes.map((code, i) => (
                <div key={i} className="text-center text-sm font-mono tracking-[0.3em]">
                  {code}
                </div>
              ))}
            </div>
            <Button
              onClick={() => navigator.clipboard.writeText(recoveryCodes.join("\n"))}
              variant="outline"
              className="w-full"
              size="sm"
            >
              Copy All Codes
            </Button>
            <Button
              onClick={() => {
                setRecoveryCodes(null);
                setShowRecoveryInput(true);
              }}
              variant="outline"
              className="w-full text-orange-400 border-orange-400/30 hover:bg-orange-400/10"
              size="sm"
            >
              Regenerate Codes
            </Button>
          </div>
        ) : showRecoveryInput ? (
          <div className="space-y-2">
            <Input
              placeholder="Authenticator code"
              value={recoveryTotpCode}
              onChange={(e) => setRecoveryTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              maxLength={6}
              className="text-sm font-mono tracking-widest"
            />
            {recoveryError && (
              <p className="text-xs text-destructive">{recoveryError}</p>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setShowRecoveryInput(false);
                  setRecoveryTotpCode("");
                  setRecoveryError(null);
                }}
                variant="outline"
                className="flex-1"
                size="sm"
              >
                Cancel
              </Button>
              <Button
                onClick={handleGetRecoveryCodes}
                disabled={recoveryLoading}
                variant="outline"
                className="flex-1"
                size="sm"
              >
                {recoveryLoading ? "Loading..." : "Confirm"}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            onClick={() => setShowRecoveryInput(true)}
            variant="outline"
            className="w-full"
          >
            View Recovery Codes
          </Button>
        )}
      </div>

      {/* Delete Account */}
      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-semibold text-destructive">Danger Zone</h3>
        <p className="text-xs text-muted-foreground">
          Permanently delete your account. This action cannot be undone.
        </p>
        {!confirmDelete ? (
          <Button
            onClick={() => setConfirmDelete(true)}
            variant="outline"
            className="w-full text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            Delete Account
          </Button>
        ) : (
          <div className="space-y-2">
            <Input
              placeholder="Authenticator code"
              value={deleteTotpCode}
              onChange={(e) => setDeleteTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              maxLength={6}
              className="text-sm font-mono tracking-widest"
            />
            {deleteError && (
              <p className="text-xs text-destructive">{deleteError}</p>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setConfirmDelete(false);
                  setDeleteTotpCode("");
                  setDeleteError(null);
                }}
                variant="outline"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleDeleteAccount}
                disabled={deletingAccount}
                variant="destructive"
                className="flex-1"
              >
                {deletingAccount ? "Deleting..." : "Confirm Delete"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(
        "transition-all duration-200 p-0 overflow-hidden",
        isSelf && activeTab === "files" ? "sm:max-w-[440px]" : "sm:max-w-[340px]"
      )}>
        <DialogHeader className="sr-only">
          <DialogTitle>User Profile</DialogTitle>
        </DialogHeader>
        {isSelf ? (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsContent value="profile" className="mt-0">{profileContent}</TabsContent>
            <TabsContent value="files" className="mt-0 px-5 pb-5">{filesContent}</TabsContent>
            <TabsContent value="account" className="mt-0">{accountContent}</TabsContent>
            <div className="px-5 pb-4 border-t pt-3">
              <TabsList className="w-full">
                <TabsTrigger value="profile" className="flex-1">Profile</TabsTrigger>
                <TabsTrigger value="files" className="flex-1">My Files</TabsTrigger>
                <TabsTrigger value="account" className="flex-1">Account</TabsTrigger>
              </TabsList>
            </div>
          </Tabs>
        ) : (
          profileContent
        )}
      </DialogContent>
    </Dialog>
  );
}
