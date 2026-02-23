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
import { Plus, ImagePlus, X, Search } from "lucide-react";

export function ForumArea() {
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

  const isOwnerOrMod = useCallback(() => {
    const members = state.roomMembers;
    const me = members.find((m) => m.userId === state.userId);
    return me?.role === "owner" || me?.role === "moderator";
  }, [state.roomMembers, state.userId]);

  const loadPosts = useCallback(async (append = false, before?: number) => {
    if (!roomId) return;
    setLoading(true);
    try {
      const data = await apiListForumPosts(roomId, 20, before);
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
      loadPosts();
    }
  }, [roomId, loadPosts]);

  // Debounced search
  useEffect(() => {
    if (!roomId) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    const q = searchQuery.trim();
    if (!q) {
      // Clear search, reload normal posts
      if (isSearching) {
        setIsSearching(false);
        loadPosts();
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
        setPosts((prev) => [detail.post, ...prev]);
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
    // Update comment counts and bump to top from real-time events
    const onCommentCreated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.room_id === roomId && !isSearching) {
        setPosts((prev) => {
          const updated = prev.map((p) =>
            p.post_id === detail.post_id
              ? { ...p, comment_count: p.comment_count + 1, last_activity: Date.now() }
              : p
          );
          // Re-sort by last_activity descending
          return updated.sort((a, b) => b.last_activity - a.last_activity);
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

    window.addEventListener("forum.post.created", onPostCreated);
    window.addEventListener("forum.post.deleted", onPostDeleted);
    window.addEventListener("forum.post.edited", onPostEdited);
    window.addEventListener("forum.comment.created", onCommentCreated);
    window.addEventListener("forum.comment.deleted", onCommentDeleted);
    return () => {
      window.removeEventListener("forum.post.created", onPostCreated);
      window.removeEventListener("forum.post.deleted", onPostDeleted);
      window.removeEventListener("forum.post.edited", onPostEdited);
      window.removeEventListener("forum.comment.created", onCommentCreated);
      window.removeEventListener("forum.comment.deleted", onCommentDeleted);
    };
  }, [roomId, selectedPostId, isSearching]);

  const handleDeletePost = async (postId: string) => {
    if (!roomId || !confirm("Delete this post?")) return;
    try {
      await apiDeleteForumPost(roomId, postId);
    } catch (e: any) {
      alert(e.message || "Failed to delete post");
    }
  };

  const handleLoadMore = () => {
    if (posts.length > 0) {
      const oldest = posts[posts.length - 1];
      loadPosts(true, oldest.last_activity);
    }
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
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5 shrink-0">
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
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      let imageUrl: string | undefined;
      if (imageFile) {
        const uploaded = await apiUploadFile(imageFile);
        imageUrl = uploaded.url;
      }
      await apiCreateForumPost(roomId, title.trim(), body, imageUrl);
      setTitle("");
      setBody("");
      setImageFile(null);
      setImagePreview(null);
      onOpenChange(false);
    } catch (e: any) {
      alert(e.message || "Failed to create post");
    } finally {
      setSubmitting(false);
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onload = () => setImagePreview(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
            <Label>Image (Optional)</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelect}
            />
            {imagePreview ? (
              <div className="relative inline-block">
                <img src={imagePreview} alt="" className="max-h-32 rounded-md" />
                <button
                  onClick={() => { setImageFile(null); setImagePreview(null); }}
                  className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full p-0.5 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="gap-1.5"
              >
                <ImagePlus className="w-4 h-4" />
                Add Image
              </Button>
            )}
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
