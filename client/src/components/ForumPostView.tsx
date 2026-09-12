import { useState, useEffect, useRef, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import {
  apiGetForumPost,
  apiCreateForumComment,
  apiDeleteForumComment,
  apiEditForumPost,
  apiEditForumComment,
  apiUploadFile,
  apiAddReaction,
  forumImages,
  type ForumPost,
  type ForumComment,
} from "@/lib/api";
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn, displayUserId } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Trash2, ImagePlus, X, Send, Pencil, Check } from "lucide-react";
import { EmojiPicker } from "@/components/EmojiPicker";
import { ForumMarkdown } from "@/components/ForumMarkdown";
import { ForumImageGallery } from "@/components/ForumImageGallery";
import { usePendingFiles, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";
import { scrollBehavior } from "@/lib/theme/display";

function isCustomEmojiUrl(s: string) {
  return s.startsWith("/") || s.startsWith("http");
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString();
}

interface ForumPostViewProps {
  roomId: string;
  postId: string;
  onBack: () => void;
}

export function ForumPostView({ roomId, postId, onBack }: ForumPostViewProps) {
  const confirm = useConfirm();
  const { state } = useAppContext();
  const [post, setPost] = useState<ForumPost | null>(null);
  const [comments, setComments] = useState<ForumComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const commentsEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Edit state for post
  const [editingPost, setEditingPost] = useState(false);
  const [editPostTitle, setEditPostTitle] = useState("");
  const [editPostBody, setEditPostBody] = useState("");
  const [savingPost, setSavingPost] = useState(false);

  // Edit state for comments (keyed by comment_id)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");
  const [savingComment, setSavingComment] = useState(false);

  const {
    files: commentImages,
    addMany: addCommentImages,
    remove: removeCommentImage,
    clear: clearCommentImages,
    remaining: commentImagesRemaining,
  } = usePendingFiles();

  const stageCommentImages = useCallback((incoming: File[]) => {
    const pictures = incoming.filter((f) => f.type.startsWith("image/"));
    if (pictures.length < incoming.length) {
      toast.error("A comment takes images only");
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
          ? `That image is over the ${mb} MB limit`
          : `${tooBig} images are over the ${mb} MB limit`,
      );
    }
    if (small.length === 0) return;
    const { rejected } = addCommentImages(small);
    if (rejected > 0) {
      toast.error(
        `A comment holds ${MAX_ATTACHMENTS} images — ${rejected} ${rejected === 1 ? "was" : "were"} left off`,
      );
    }
  }, [addCommentImages, state.uploadLimitBytes]);

  const isOwnerOrMod = useCallback(() => {
    const members = state.roomMembers;
    const me = members.find((m) => m.userId === state.userId);
    return me?.role === "owner" || me?.role === "moderator";
  }, [state.roomMembers, state.userId]);

  const loadPost = useCallback(async () => {
    try {
      const data = await apiGetForumPost(roomId, postId);
      setPost(data.post);
      setComments(data.comments);
    } catch {
      // Post may have been deleted
    }
  }, [roomId, postId]);

  useEffect(() => {
    loadPost();
  }, [loadPost]);

  // Listen for real-time events
  useEffect(() => {
    const onCommentCreated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.post_id === postId) {
        setComments((prev) => [...prev, detail.comment]);
        setPost((prev) =>
          prev ? { ...prev, comment_count: prev.comment_count + 1 } : prev
        );
      }
    };
    const onCommentDeleted = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.post_id === postId) {
        setComments((prev) =>
          prev.filter((c) => c.comment_id !== detail.comment_id)
        );
        setPost((prev) =>
          prev ? { ...prev, comment_count: Math.max(0, prev.comment_count - 1) } : prev
        );
      }
    };
    const onPostDeleted = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.post_id === postId) {
        onBack();
      }
    };
    const onPostEdited = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.post_id === postId) {
        setPost((prev) =>
          prev
            ? {
                ...prev,
                title: detail.title ?? prev.title,
                body: detail.body ?? prev.body,
                edited: true,
                edited_at: detail.edited_at ?? prev.edited_at,
              }
            : prev
        );
      }
    };
    const onCommentEdited = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.post_id === postId) {
        setComments((prev) =>
          prev.map((c) =>
            c.comment_id === detail.comment_id
              ? { ...c, body: detail.body, edited: true, edited_at: detail.edited_at }
              : c
          )
        );
      }
    };

    window.addEventListener("forum.comment.created", onCommentCreated);
    window.addEventListener("forum.comment.deleted", onCommentDeleted);
    window.addEventListener("forum.post.deleted", onPostDeleted);
    window.addEventListener("forum.post.edited", onPostEdited);
    window.addEventListener("forum.comment.edited", onCommentEdited);
    return () => {
      window.removeEventListener("forum.comment.created", onCommentCreated);
      window.removeEventListener("forum.comment.deleted", onCommentDeleted);
      window.removeEventListener("forum.post.deleted", onPostDeleted);
      window.removeEventListener("forum.post.edited", onPostEdited);
      window.removeEventListener("forum.comment.edited", onCommentEdited);
    };
  }, [postId, onBack]);

  // Scroll to bottom on new comment
  useEffect(() => {
    commentsEndRef.current?.scrollIntoView({ behavior: scrollBehavior() });
  }, [comments.length]);

  const handleSubmitComment = async () => {
    if (!commentBody.trim() && commentImages.length === 0) return;
    setSubmitting(true);
    try {
      const urls: string[] = [];
      for (const pending of commentImages) {
        const uploaded = await apiUploadFile(pending.file);
        urls.push(uploaded.url);
      }
      // The server wants a body; a comment that is only pictures says so.
      const body =
        commentBody.trim() ||
        (urls.length > 1 ? `(${urls.length} images)` : urls.length === 1 ? "(image)" : "");
      await apiCreateForumComment(roomId, postId, body, urls);
      setCommentBody("");
      clearCommentImages();
    } catch (e: any) {
      toast.error(e.message || "Failed to post comment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!(await confirm({ title: "Delete this comment?", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await apiDeleteForumComment(roomId, postId, commentId);
    } catch (e: any) {
      toast.error(e.message || "Failed to delete comment");
    }
  };

  const handleReaction = async (emoji: string) => {
    try {
      await apiAddReaction(roomId, postId, emoji);
      loadPost();
    } catch {}
    setShowEmojiPicker(false);
  };

  const handleCommentImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    stageCommentImages(picked);
  };

  // Dropping images onto the comment box, the same as everywhere else.
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
    stageCommentImages(Array.from(e.dataTransfer.files ?? []));
  };

  // Post editing
  const startEditingPost = () => {
    if (!post) return;
    setEditPostTitle(post.title);
    setEditPostBody(post.body);
    setEditingPost(true);
  };

  const cancelEditingPost = () => {
    setEditingPost(false);
    setEditPostTitle("");
    setEditPostBody("");
  };

  const saveEditPost = async () => {
    if (!post || !editPostTitle.trim()) return;
    setSavingPost(true);
    try {
      await apiEditForumPost(roomId, postId, editPostTitle.trim(), editPostBody);
      setEditingPost(false);
    } catch (e: any) {
      toast.error(e.message || "Failed to edit post");
    } finally {
      setSavingPost(false);
    }
  };

  // Comment editing
  const startEditingComment = (comment: ForumComment) => {
    setEditingCommentId(comment.comment_id);
    setEditCommentBody(comment.body);
  };

  const cancelEditingComment = () => {
    setEditingCommentId(null);
    setEditCommentBody("");
  };

  const saveEditComment = async (commentId: string) => {
    if (!editCommentBody.trim()) return;
    setSavingComment(true);
    try {
      await apiEditForumComment(roomId, postId, commentId, editCommentBody.trim());
      setEditingCommentId(null);
      setEditCommentBody("");
    } catch (e: any) {
      toast.error(e.message || "Failed to edit comment");
    } finally {
      setSavingComment(false);
    }
  };

  if (!post) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }

  const authorDisplay = displayUserId(post.author);
  const isPostAuthor = post.author === state.userId;
  const reactionEntries = Object.entries(post.reactions || {});
  const customEmojis = state.currentRoomId
    ? (state.roomInfoMap[state.currentRoomId]?.custom_emojis ?? [])
    : [];
  const emojiAliases = state.currentRoomId
    ? (state.roomInfoMap[state.currentRoomId]?.emoji_aliases ?? {})
    : {};

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 space-y-4">
          {/* Post images */}
          <ForumImageGallery images={forumImages(post)} />

          {/* Post title & meta */}
          {editingPost ? (
            <div className="space-y-3">
              <Input
                value={editPostTitle}
                onChange={(e) => setEditPostTitle(e.target.value)}
                maxLength={200}
                placeholder="Post title"
              />
              <Textarea
                value={editPostBody}
                onChange={(e) => setEditPostBody(e.target.value)}
                maxLength={4000}
                rows={4}
                placeholder="Post body..."
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveEditPost} disabled={savingPost || !editPostTitle.trim()} className="gap-1.5">
                  <Check className="w-3 h-3" />
                  {savingPost ? "Saving..." : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEditingPost}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-start gap-2">
                <h1 className="text-xl font-bold flex-1">{post.title}</h1>
                {isPostAuthor && (
                  <button
                    onClick={startEditingPost}
                    className="text-muted-foreground hover:text-foreground transition-colors mt-1 cursor-pointer"
                    title="Edit post"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {authorDisplay} · {formatTime(post.created_at)}
                {post.edited && (
                  <span className="ml-1" title={post.edited_at ? `Edited ${formatTime(post.edited_at)}` : "Edited"}>
                    (edited)
                  </span>
                )}
              </p>
            </div>
          )}

          {/* Post body */}
          {!editingPost && post.body && (
            <ForumMarkdown content={post.body} className="text-sm" />
          )}

          {/* Reactions */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {reactionEntries.map(([emoji, userIds]) =>
              userIds.length > 0 ? (
                <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    key={emoji}
                    onClick={() => handleReaction(emoji)}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors cursor-pointer ${
                      userIds.includes(state.userId ?? "")
                        ? "border-primary/50 bg-primary/10"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {isCustomEmojiUrl(emoji) ? (
                      <img src={emoji} alt="emoji" className="inline-block h-4 w-4 object-contain" />
                    ) : (
                      emoji
                    )}
                    <span className="text-muted-foreground font-medium">{userIds.length}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {userIds.map(id => (
                    <p key={id}>{displayUserId(id)}</p>
                  ))}
                </TooltipContent>
              </Tooltip>
              ) : null
            )}
            <div className="relative">
              <button
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                className="inline-flex items-center justify-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                +
              </button>
              {showEmojiPicker && (
                <div className="absolute top-full left-0 mt-1 z-50 rounded-md border bg-popover shadow-md">
                  <EmojiPicker
                    onSelect={handleReaction}
                    roomCustomEmojis={customEmojis}
                    emojiAliases={emojiAliases}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Comments separator */}
          <div className="border-t pt-4">
            <h2 className="text-sm font-semibold mb-3">
              Comments ({comments.length})
            </h2>

            {/* Comment list */}
            <div className="space-y-3">
              {comments.map((comment) => {
                const cAuthor = displayUserId(comment.author);
                const canDeleteComment = comment.author === state.userId || isOwnerOrMod();
                const isCommentAuthor = comment.author === state.userId;
                const isEditing = editingCommentId === comment.comment_id;
                return (
                  <div
                    key={comment.comment_id}
                    className="group flex gap-2 rounded-md border p-2.5"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{cAuthor}</span>
                        <span className="ui-meta">
                          {formatTime(comment.created_at)}
                          {comment.edited && (
                            <span className="ml-1" title={comment.edited_at ? `Edited ${formatTime(comment.edited_at)}` : "Edited"}>
                              (edited)
                            </span>
                          )}
                        </span>
                        <div className="can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity ml-auto flex items-center gap-1">
                          {isCommentAuthor && !isEditing && (
                            <button
                              onClick={() => startEditingComment(comment)}
                              className="text-muted-foreground hover:text-foreground cursor-pointer"
                              title="Edit comment"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          )}
                          {canDeleteComment && (
                            <button
                              onClick={() => handleDeleteComment(comment.comment_id)}
                              className="text-muted-foreground hover:text-destructive cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      {isEditing ? (
                        <div className="mt-1 space-y-2">
                          <Textarea
                            value={editCommentBody}
                            onChange={(e) => setEditCommentBody(e.target.value)}
                            maxLength={2000}
                            rows={2}
                            className="min-h-[40px] max-h-[120px] resize-none text-sm"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                saveEditComment(comment.comment_id);
                              }
                              if (e.key === "Escape") {
                                cancelEditingComment();
                              }
                            }}
                          />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => saveEditComment(comment.comment_id)} disabled={savingComment || !editCommentBody.trim()} className="h-7 text-xs gap-1">
                              <Check className="w-3 h-3" />
                              {savingComment ? "Saving..." : "Save"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={cancelEditingComment} className="h-7 text-xs">
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <ForumMarkdown content={comment.body} className="text-sm mt-1" />
                      )}
                      <ForumImageGallery
                        images={forumImages(comment)}
                        className="mt-2"
                        compact
                      />
                    </div>
                  </div>
                );
              })}
              <div ref={commentsEndRef} />
            </div>
          </div>
        </div>
      </div>

      {/* Comment input */}
      <div
        className={cn(
          "border-t p-3 shrink-0 transition-colors",
          dragging && "outline-2 outline-dashed outline-primary -outline-offset-2 bg-primary/5",
        )}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div className="max-w-3xl mx-auto">
          {commentImages.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {commentImages.map((pending, i) => (
                <div key={i} className="relative">
                  <img
                    src={pending.previewUrl ?? ""}
                    alt={pending.file.name}
                    className="h-16 w-16 rounded-md border border-border object-cover"
                  />
                  <button
                    onClick={() => removeCommentImage(i)}
                    className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground cursor-pointer"
                    title={`Remove ${pending.file.name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleCommentImageSelect}
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              disabled={commentImagesRemaining === 0}
              onClick={() => fileInputRef.current?.click()}
              title={
                commentImagesRemaining > 0
                  ? `Add images (${commentImagesRemaining} of ${MAX_ATTACHMENTS} left)`
                  : `${MAX_ATTACHMENTS} images is the limit`
              }
            >
              <ImagePlus className="w-4 h-4" />
            </Button>
            <Textarea
              placeholder="Write a comment..."
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmitComment();
                }
              }}
              className="min-h-[40px] max-h-[120px] resize-none"
              rows={1}
            />
            <Button
              size="icon"
              className="shrink-0"
              onClick={handleSubmitComment}
              disabled={submitting || (!commentBody.trim() && commentImages.length === 0)}
            
            aria-label="Post comment">
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
