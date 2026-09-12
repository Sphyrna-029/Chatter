import { useState, useEffect, useCallback, useRef } from "react";
import { useAppContext } from "@/lib/store";
import {
  apiListForumPosts,
  apiCreateForumPost,
  apiDeleteForumPost,
  apiSearchForumPosts,
  apiUploadFile,
  type ForumPost,
} from "@/lib/api";
import { ForumPostCard } from "./ForumPostCard";
import { ForumPostView } from "./ForumPostView";
import { FORUM_POST_OPEN_EVENT, takePendingForumPost } from "@/lib/pendingForumPost";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, ImagePlus, X, Search, ArrowUpDown } from "lucide-react";
import { usePendingFiles, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";
import { IMAGE_AND_VIDEO_ACCEPT, isImageOrVideoFile } from "@/lib/mediaTypes";
import { useUploadQueue } from "@/hooks/useUploadQueue";
import { UploadProgressOverlay } from "./UploadProgressOverlay";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";

type SortMode = "activity" | "newest" | "oldest" | "popular";

const sortLabels: Record<SortMode, string> = {
  activity: "Active",
  newest: "Newest",
  oldest: "Oldest",
  popular: "Popular",
};

export function ForumArea() {
  const confirm = useConfirm();
  const { state } = useAppContext();
  const roomId = state.currentRoomId;
  const roomInfo = roomId ? state.roomInfoMap[roomId] : null;

  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const loadedRoomRef = useRef<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sort state
  const [sortMode, setSortMode] = useState<SortMode>("activity");

  const isOwnerOrMod = useCallback(() => {
    const members = state.roomMembers;
    const me = members.find((m) => m.userId === state.userId);
    return me?.role === "owner" || me?.role === "moderator";
  }, [state.roomMembers, state.userId]);

  const loadPosts = useCallback(async (sort: SortMode, append = false, before?: number) => {
    if (!roomId) return;
    setLoading(true);
    try {
      const data = await apiListForumPosts(roomId, 20, before, sort);
      if (append) {
        setPosts((prev) => [...prev, ...data.posts]);
      } else {
        setPosts(data.posts);
      }
      setHasMore(data.has_more);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  // Load posts when room changes
  useEffect(() => {
    if (roomId && roomId !== loadedRoomRef.current) {
      loadedRoomRef.current = roomId;
      setSelectedPostId(null);
      setPosts([]);
      setSearchQuery("");
      setIsSearching(false);
      setSortMode("activity");
      loadPosts("activity");
    }
  }, [roomId, loadPosts]);

  // Reload when sort mode changes
  const handleSortChange = (mode: SortMode) => {
    if (mode === sortMode) return;
    setSortMode(mode);
    setSearchQuery("");
    setIsSearching(false);
    setPosts([]);
    loadPosts(mode);
  };

  // Debounced search
  useEffect(() => {
    if (!roomId) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    const q = searchQuery.trim();
    if (!q) {
      if (isSearching) {
        setIsSearching(false);
        loadPosts(sortMode);
      }
      return;
    }

    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true);
      setLoading(true);
      try {
        const data = await apiSearchForumPosts(roomId, q);
        setPosts(data.posts);
        setHasMore(false);
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchQuery, roomId]);

  // Listen for real-time events
  useEffect(() => {
    const onPostCreated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.room_id === roomId && detail.post && !isSearching) {
        if (sortMode === "oldest") {
          // New posts go to the end for oldest-first sort
          setPosts((prev) => [...prev, detail.post]);
        } else {
          setPosts((prev) => [detail.post, ...prev]);
        }
      }
    };
    const onPostDeleted = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.room_id === roomId) {
        setPosts((prev) => prev.filter((p) => p.post_id !== detail.post_id));
        if (selectedPostId === detail.post_id) {
          setSelectedPostId(null);
        }
      }
    };
    const onCommentCreated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.room_id === roomId && !isSearching) {
        setPosts((prev) => {
          const updated = prev.map((p) =>
            p.post_id === detail.post_id
              ? { ...p, comment_count: p.comment_count + 1, last_activity: Date.now() }
              : p
          );
          // Only re-sort if we're in activity mode
          if (sortMode === "activity") {
            return updated.sort((a, b) => b.last_activity - a.last_activity);
          }
          return updated;
        });
      }
    };
    const onCommentDeleted = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.room_id === roomId) {
        setPosts((prev) =>
          prev.map((p) =>
            p.post_id === detail.post_id
              ? { ...p, comment_count: Math.max(0, p.comment_count - 1) }
              : p
          )
        );
      }
    };
    const onPostEdited = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.room_id === roomId) {
        setPosts((prev) =>
          prev.map((p) =>
            p.post_id === detail.post_id
              ? { ...p, title: detail.title ?? p.title, body: detail.body ?? p.body, edited: true, edited_at: detail.edited_at }
              : p
          )
        );
      }
    };

    const onOpenPost = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.roomId !== roomId) return;
      // Clear the parked request too, so returning to this room later does not
      // re-open the post.
      takePendingForumPost(roomId);
      setSelectedPostId(detail.postId);
    };

    window.addEventListener(FORUM_POST_OPEN_EVENT, onOpenPost);
    window.addEventListener("forum.post.created", onPostCreated);
    window.addEventListener("forum.post.deleted", onPostDeleted);
    window.addEventListener("forum.post.edited", onPostEdited);
    window.addEventListener("forum.comment.created", onCommentCreated);
    window.addEventListener("forum.comment.deleted", onCommentDeleted);
    return () => {
      window.removeEventListener(FORUM_POST_OPEN_EVENT, onOpenPost);
      window.removeEventListener("forum.post.created", onPostCreated);
      window.removeEventListener("forum.post.deleted", onPostDeleted);
      window.removeEventListener("forum.post.edited", onPostEdited);
      window.removeEventListener("forum.comment.created", onCommentCreated);
      window.removeEventListener("forum.comment.deleted", onCommentDeleted);
    };
  }, [roomId, selectedPostId, isSearching, sortMode]);

  // A request that arrived before this component mounted — selecting the room
  // is what mounts it, so the event above would have had no listener.
  useEffect(() => {
    const postId = takePendingForumPost(roomId);
    if (postId) setSelectedPostId(postId);
  }, [roomId]);

  const handleDeletePost = async (postId: string) => {
    if (!roomId) return;
    if (!(await confirm({ title: "Delete this post?", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await apiDeleteForumPost(roomId, postId);
    } catch (e: any) {
      toast.error(e.message || "Failed to delete post");
    }
  };

  const handleLoadMore = () => {
    if (posts.length === 0) return;
    const last = posts[posts.length - 1];
    // Use the correct cursor field based on sort mode
    let cursor: number;
    switch (sortMode) {
      case "newest":
      case "oldest":
        cursor = last.created_at;
        break;
      case "popular":
        cursor = last.comment_count;
        break;
      default: // "activity"
        cursor = last.last_activity;
        break;
    }
    loadPosts(sortMode, true, cursor);
  };

  if (!roomId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Select a room to view
      </div>
    );
  }

  // Post detail view
  if (selectedPostId) {
    return (
      <ForumPostView
        roomId={roomId}
        postId={selectedPostId}
        onBack={() => setSelectedPostId(null)}
      />
    );
  }

  // Post list view
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0 gap-3">
        <div className="min-w-0 shrink-0">
          <h2 className="font-semibold text-sm truncate">{roomInfo?.name || "Forum"}</h2>
          {roomInfo?.topic && (
            <p className="text-xs text-muted-foreground truncate">{roomInfo.topic}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-1 justify-end">
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search posts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 shrink-0 h-8 text-xs">
                <ArrowUpDown className="w-3.5 h-3.5" />
                {sortLabels[sortMode]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(Object.keys(sortLabels) as SortMode[]).map((mode) => (
                <DropdownMenuItem
                  key={mode}
                  onClick={() => handleSortChange(mode)}
                  className={sortMode === mode ? "font-semibold" : ""}
                >
                  {sortLabels[mode]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5 shrink-0 h-8">
            <Plus className="w-4 h-4" />
            New Post
          </Button>
        </div>
      </div>

      {/* Posts list */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto space-y-2">
          {posts.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">
              {isSearching ? (
                <p className="text-sm">No posts match your search</p>
              ) : (
                <>
                  <p className="text-sm">No posts yet</p>
                  <p className="text-xs mt-1">Be the first to create a post!</p>
                </>
              )}
            </div>
          )}

          {posts.map((post) => {
            const canDelete = post.author === state.userId || isOwnerOrMod();
            return (
              <ForumPostCard
                key={post.post_id}
                post={post}
                onClick={() => setSelectedPostId(post.post_id)}
                onDelete={() => handleDeletePost(post.post_id)}
                canDelete={canDelete}
              />
            );
          })}

          {hasMore && !isSearching && (
            <div className="text-center py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLoadMore}
                disabled={loading}
              >
                {loading ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Create post dialog */}
      <CreatePostDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        roomId={roomId}
      />
    </div>
  );
}

// ─── Create Post Dialog ─────────────────────────────────────────────────────

function CreatePostDialog({
  open,
  onOpenChange,
  roomId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
}) {
  const { state } = useAppContext();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { progress: uploadProgress, uploadAll, reset: resetUploadProgress } = useUploadQueue();

  const {
    files: images,
    addMany: addImages,
    remove: removeImage,
    clear: clearImages,
    remaining: imagesRemaining,
  } = usePendingFiles();

  const stageImages = useCallback((incoming: File[]) => {
    const pictures = incoming.filter(isImageOrVideoFile);
    if (pictures.length < incoming.length) {
      toast.error("A post takes images and videos only");
    }
    // Checked here rather than on submit: uploads run one after another, so an
    // image the server will refuse would otherwise be found out only after the
    // ones before it had already been sent.
    const limit = state.uploadLimitBytes;
    const small = limit > 0 ? pictures.filter((f) => f.size <= limit) : pictures;
    const tooBig = pictures.length - small.length;
    if (tooBig > 0) {
      const mb = Math.round(limit / 1024 / 1024);
      toast.error(
        tooBig === 1
          ? `That file is over the ${mb} MB limit`
          : `${tooBig} files are over the ${mb} MB limit`,
      );
    }
    if (small.length === 0) return;
    const { rejected } = addImages(small);
    if (rejected > 0) {
      toast.error(
        `A post holds ${MAX_ATTACHMENTS} files — ${rejected} ${rejected === 1 ? "was" : "were"} left off`,
      );
    }
  }, [addImages, state.uploadLimitBytes]);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      // Uploaded in order so the post shows them in the order they were added,
      // then split by kind: pictures and clips are laid out differently. Each
      // tile in the grid above carries its own progress while this runs.
      const outcomes = await uploadAll(images, async (file, onProgress) => {
        const { url } = await apiUploadFile(file, onProgress);
        return url;
      });
      const failed = outcomes.filter((o) => o.url === null);
      if (failed.length > 0) {
        // Posting the rest would quietly drop what they picked, so stop and
        // leave the dialog as it was — everything is still staged.
        toast.error(
          failed.length === 1
            ? `${failed[0].file.file.name} could not be uploaded`
            : `${failed.length} files could not be uploaded`,
        );
        return;
      }
      const imageUrls: string[] = [];
      const videoUrls: string[] = [];
      for (const outcome of outcomes) {
        (outcome.file.file.type.startsWith("video/") ? videoUrls : imageUrls).push(outcome.url!);
      }
      await apiCreateForumPost(roomId, title.trim(), body, imageUrls, videoUrls);
      setTitle("");
      setBody("");
      clearImages();
      resetUploadProgress();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || "Failed to create post");
    } finally {
      setSubmitting(false);
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    stageImages(picked);
  };

  // Dropping images straight onto the dialog, the same as the composers.
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    stageImages(Array.from(e.dataTransfer.files ?? []));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "transition-colors",
          dragging && "outline-2 outline-dashed outline-primary -outline-offset-2 bg-primary/5",
        )}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <DialogHeader>
          <DialogTitle>Create New Post</DialogTitle>
          <DialogDescription>
            Share something with the community.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="post-title">Title</Label>
            <Input
              id="post-title"
              placeholder="Post title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="post-body">Body (Optional)</Label>
            <Textarea
              id="post-body"
              placeholder="Write your post content..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={4000}
              rows={4}
            />
          </div>
          <div className="space-y-2">
            <Label>
              Images and videos (Optional)
              {images.length > 0 && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {images.length} of {MAX_ATTACHMENTS}
                </span>
              )}
            </Label>
            <input
              ref={fileInputRef}
              type="file"
              accept={IMAGE_AND_VIDEO_ACCEPT}
              multiple
              className="hidden"
              onChange={handleImageSelect}
            />
            {images.length > 0 && (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                {images.map((pending, i) => (
                  <div key={pending.id} className="group relative">
                    {pending.file.type.startsWith("video/") ? (
                      <video
                        src={pending.previewUrl ?? ""}
                        muted
                        playsInline
                        preload="metadata"
                        className="aspect-square w-full rounded-md border border-border bg-black object-cover"
                      />
                    ) : (
                      <img
                        src={pending.previewUrl ?? ""}
                        alt={pending.file.name}
                        className="aspect-square w-full rounded-md border border-border object-cover"
                      />
                    )}
                    <UploadProgressOverlay progress={uploadProgress[pending.id]} />
                    {!submitting && (
                      <button
                        onClick={() => removeImage(i)}
                        className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground cursor-pointer"
                        title={`Remove ${pending.file.name}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={imagesRemaining === 0}
              className="gap-1.5"
            >
              <ImagePlus className="w-4 h-4" />
              {images.length === 0
                ? "Add Images or Videos"
                : imagesRemaining === 0
                  ? `${MAX_ATTACHMENTS} files is the limit`
                  : `Add more (${imagesRemaining} left)`}
            </Button>
            <p className="ui-hint">Or drop them anywhere on this dialog.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!title.trim() || submitting}>
            {submitting ? "Creating..." : "Create Post"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
