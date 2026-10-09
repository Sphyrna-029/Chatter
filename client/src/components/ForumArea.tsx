import { useState, useEffect, useCallback, useRef } from "react";
import { useAppContext } from "@/lib/store";
import {
  apiListForumPosts,
  apiCreateForumPost,
  apiDeleteForumPost,
  apiSearchForumPosts,
  apiUploadFile,
  type ForumPost,
  type ForumTag,
} from "@/lib/api";
import { ForumTagChip, ForumTagPicker, ManageForumTagsDialog } from "./ForumTags";
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
import { Plus, Paperclip, X, Search, ArrowUpDown, Tags } from "lucide-react";
import { usePendingFiles, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";
import { clipboardFiles } from "@/lib/clipboardFiles";
import { sortForumAttachments } from "@/lib/mediaTypes";
import { StagedForumFile } from "@/components/ForumMediaGallery";
import { useUploadQueue } from "@/hooks/useUploadQueue";
import { UploadProgressOverlay } from "./UploadProgressOverlay";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";
import { MentionMenu } from "./MentionMenu";
import { useTextareaMentions } from "@/hooks/useTextareaMentions";

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
  // Each forum channel keeps its own posts. No channel is a room that is a
  // forum itself, whose posts belong to the room.
  const forumChannel = state.channels.find(
    (c) => c.channel_id === state.currentChannelId && c.channel_type === "forum",
  );
  const channelId = forumChannel?.channel_id ?? null;
  const viewKey = roomId ? `${roomId}|${channelId ?? ""}` : null;
  const channelTags = forumChannel?.forum_tags ?? [];
  // Whoever set the forum up decides its tags, as does anyone who can manage
  // the room's channels (the server checks the same two things).
  const canManageTags =
    !!forumChannel &&
    (forumChannel.created_by === state.userId || !!state.myPermissions?.manage_channels);

  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  /** Only posts wearing this tag, or null for all of them. */
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const loadedViewRef = useRef<string | null>(null);

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

  // The tag is passed rather than read from state: a caller that has just set
  // the filter would otherwise load with the one before it.
  const loadPosts = useCallback(async (sort: SortMode, append = false, before?: number, tag: string | null = null) => {
    if (!roomId) return;
    setLoading(true);
    try {
      const data = await apiListForumPosts(roomId, 20, before, sort, channelId, tag);
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
  }, [roomId, channelId]);

  // Load posts when the room or forum channel changes. A post asked for from
  // outside (and parked until this view was the one showing) is opened here.
  useEffect(() => {
    if (viewKey && viewKey !== loadedViewRef.current) {
      loadedViewRef.current = viewKey;
      setSelectedPostId(takePendingForumPost(roomId, channelId));
      setPosts([]);
      setSearchQuery("");
      setIsSearching(false);
      setSortMode("activity");
      setTagFilter(null);
      loadPosts("activity");
    }
  }, [viewKey, roomId, channelId, loadPosts]);

  // Reload when sort mode changes
  const handleSortChange = (mode: SortMode) => {
    if (mode === sortMode) return;
    setSortMode(mode);
    setSearchQuery("");
    setIsSearching(false);
    setPosts([]);
    loadPosts(mode, false, undefined, tagFilter);
  };

  const handleTagFilter = (tag: string | null) => {
    if (tag === tagFilter) return;
    setTagFilter(tag);
    setSearchQuery("");
    setIsSearching(false);
    setPosts([]);
    loadPosts(sortMode, false, undefined, tag);
  };

  // Debounced search
  useEffect(() => {
    if (!roomId) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    const q = searchQuery.trim();
    if (!q) {
      if (isSearching) {
        setIsSearching(false);
        loadPosts(sortMode, false, undefined, tagFilter);
      }
      return;
    }

    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true);
      setLoading(true);
      try {
        const data = await apiSearchForumPosts(roomId, q, undefined, channelId);
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
  }, [searchQuery, roomId, channelId]);

  // Listen for real-time events
  useEffect(() => {
    const onPostCreated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Every forum channel in the room hears the broadcast; only the one the
      // post was written in lists it.
      const inThisChannel = (detail.channel_id || null) === channelId;
      const passesFilter = !tagFilter || (detail.post?.tags ?? []).includes(tagFilter);
      if (detail.room_id === roomId && inThisChannel && passesFilter && detail.post && !isSearching) {
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
              ? { ...p, title: detail.title ?? p.title, body: detail.body ?? p.body, tags: detail.tags ?? p.tags, edited: true, edited_at: detail.edited_at }
              : p
          )
        );
      }
    };

    const onOpenPost = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // A post in another channel stays parked until that channel is showing.
      if (detail.roomId !== roomId || (detail.channelId ?? null) !== channelId) return;
      // Clear the parked request too, so returning to this room later does not
      // re-open the post.
      takePendingForumPost(roomId, channelId);
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
  }, [roomId, channelId, selectedPostId, isSearching, sortMode, tagFilter]);

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
    loadPosts(sortMode, true, cursor, tagFilter);
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
          <h2 className="font-semibold text-sm truncate">
            {forumChannel?.name || roomInfo?.name || "Forum"}
          </h2>
          {(forumChannel ? forumChannel.topic : roomInfo?.topic) && (
            <p className="text-xs text-muted-foreground truncate">
              {forumChannel ? forumChannel.topic : roomInfo?.topic}
            </p>
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
          {canManageTags && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setManageTagsOpen(true)}
              className="gap-1.5 shrink-0 h-8 text-xs"
              title="Set up this forum's tags"
            >
              <Tags className="w-3.5 h-3.5" />
              Tags
            </Button>
          )}
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5 shrink-0 h-8">
            <Plus className="w-4 h-4" />
            New Post
          </Button>
        </div>
      </div>

      {/* Filter by tag. Search is not filtered on the server, so its results
          are narrowed below instead. */}
      {channelTags.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto px-4 py-2 border-b shrink-0">
          <ForumTagChip
            tag={{ tag_id: "", name: "All", color: "" }}
            selected={tagFilter === null}
            onClick={() => handleTagFilter(null)}
          />
          {channelTags.map((t) => (
            <ForumTagChip
              key={t.tag_id}
              tag={t}
              selected={tagFilter === t.tag_id}
              onClick={() => handleTagFilter(tagFilter === t.tag_id ? null : t.tag_id)}
            />
          ))}
        </div>
      )}

      {/* Posts list. Full width, like every other list in the app: a row is a
          thumbnail, a title and two lines of excerpt, and capping it at 768px
          left most of a wide window empty either side of it. */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-2">
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

          {posts
            .filter((post) => !isSearching || !tagFilter || (post.tags ?? []).includes(tagFilter))
            .map((post) => {
            const canDelete = post.author === state.userId || isOwnerOrMod();
            return (
              <ForumPostCard
                key={post.post_id}
                post={post}
                onClick={() => setSelectedPostId(post.post_id)}
                onDelete={() => handleDeletePost(post.post_id)}
                canDelete={canDelete}
                tags={channelTags}
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
        channelId={channelId}
        tags={channelTags}
      />

      {forumChannel && (
        <ManageForumTagsDialog
          open={manageTagsOpen}
          onOpenChange={setManageTagsOpen}
          roomId={roomId}
          channelId={forumChannel.channel_id}
          tags={channelTags}
        />
      )}
    </div>
  );
}

// ─── Create Post Dialog ─────────────────────────────────────────────────────

function CreatePostDialog({
  open,
  onOpenChange,
  roomId,
  channelId,
  tags,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  channelId: string | null;
  tags: ForumTag[];
}) {
  const { state } = useAppContext();
  const [title, setTitle] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const bodyMentions = useTextareaMentions(setBody);
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
    // Any file goes: pictures and clips land in the gallery, the rest are
    // downloads.
    const pictures = incoming;
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
      const { imageUrls, videoUrls, fileUrls } = sortForumAttachments(
        outcomes.map((o) => ({ file: o.file.file, url: o.url! })),
      );
      await apiCreateForumPost(roomId, title.trim(), body, imageUrls, videoUrls, fileUrls, channelId, selectedTags);
      setTitle("");
      setBody("");
      setSelectedTags([]);
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
        // The dialog hears Escape before the textarea does, so with the
        // mention menu open it would close the whole post instead of the menu.
        onEscapeKeyDown={(e) => {
          if (!bodyMentions.open) return;
          e.preventDefault();
          bodyMentions.close();
        }}
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
            <div className="relative">
              {bodyMentions.open && (
                <MentionMenu
                  matches={bodyMentions.matches}
                  selectedIdx={bodyMentions.selectedIdx}
                  onSelect={bodyMentions.complete}
                />
              )}
              <Textarea
                id="post-body"
                placeholder="Write your post content..."
                value={body}
                onChange={bodyMentions.onChange}
                onKeyDown={bodyMentions.onKeyDown}
                onBlur={bodyMentions.close}
                onPaste={(e) => {
                  const files = clipboardFiles(e);
                  if (files.length === 0) return;
                  e.preventDefault();
                  stageImages(files);
                }}
                maxLength={4000}
                rows={4}
              />
            </div>
          </div>
          <ForumTagPicker tags={tags} value={selectedTags} onChange={setSelectedTags} />
          <div className="space-y-2">
            <Label>
              Attachments (Optional)
              {images.length > 0 && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {images.length} of {MAX_ATTACHMENTS}
                </span>
              )}
            </Label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleImageSelect}
            />
            {images.length > 0 && (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                {images.map((pending, i) => (
                  <div key={pending.id} className="group relative">
                    <StagedForumFile
                      file={pending.file}
                      previewUrl={pending.previewUrl}
                      className="aspect-square w-full"
                    />
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
              <Paperclip className="w-4 h-4" />
              {images.length === 0
                ? "Add Files"
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
