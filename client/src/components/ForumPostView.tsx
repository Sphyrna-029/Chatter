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
  forumVideos,
  type ForumPost,
  type ForumComment,
} from "@/lib/api";
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn, displayUserId } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, Trash2, ImagePlus, X, Send, Pencil, Check,
  CornerUpLeft, ChevronDown, ChevronRight, MessageSquare,
} from "lucide-react";
import { EmojiPicker } from "@/components/EmojiPicker";
import { ForumMarkdown } from "@/components/ForumMarkdown";
import { ForumMediaGallery } from "@/components/ForumMediaGallery";
import { usePendingFiles, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";
import { buildCommentThread, countReplies, MAX_THREAD_INDENT, type ForumCommentNode } from "@/lib/forumThread";
import { IMAGE_AND_VIDEO_ACCEPT, isImageOrVideoFile } from "@/lib/mediaTypes";
import { useUploadQueue } from "@/hooks/useUploadQueue";
import { UploadProgressOverlay } from "@/components/UploadProgressOverlay";
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  /** The comment being answered, or null to answer the post itself. */
  const [replyingTo, setReplyingTo] = useState<ForumComment | null>(null);
  /** Comment ids whose replies are folded away. */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // The discussion is meant to sit behind the post, not compete with it, so it
  // is one fold away — open by default, because hidden is not the same as
  // secondary.
  const [discussionOpen, setDiscussionOpen] = useState(true);
  /** A comment just posted from here, to be scrolled to once it lands. */
  const [landingCommentId, setLandingCommentId] = useState<string | null>(null);

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
  const { progress: uploadProgress, uploadAll, reset: resetUploadProgress } = useUploadQueue();

  const stageCommentImages = useCallback((incoming: File[]) => {
    const pictures = incoming.filter(isImageOrVideoFile);
    if (pictures.length < incoming.length) {
      toast.error("A comment takes images and videos only");
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
        `A comment holds ${MAX_ATTACHMENTS} files — ${rejected} ${rejected === 1 ? "was" : "were"} left off`,
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
        setComments((prev) => {
          // The same rule the server applies on the next load: a comment with
          // replies under it leaves a tombstone, because dropping it outright
          // would cut its replies out of the thread in front of the reader.
          // Whether the tombstone should then go too, once its last living
          // reply is deleted, is left to that next load.
          const holdsReplies = prev.some((c) => c.parent_id === detail.comment_id);
          if (!holdsReplies) {
            return prev.filter((c) => c.comment_id !== detail.comment_id);
          }
          return prev.map((c) =>
            c.comment_id === detail.comment_id
              ? { ...c, deleted: true, author: "", body: "", image_url: "", image_urls: [], video_urls: [] }
              : c,
          );
        });
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

  // Take the writer to what they just wrote. Scrolling to the end of the list
  // was right while every comment was appended there; a reply is threaded in
  // beside its parent instead, and may be nowhere near the bottom.
  useEffect(() => {
    if (!landingCommentId) return;
    if (!comments.some((c) => c.comment_id === landingCommentId)) return;
    const el = document.getElementById(`forum-comment-${landingCommentId}`);
    el?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    setLandingCommentId(null);
  }, [landingCommentId, comments]);

  const startReply = useCallback((comment: ForumComment) => {
    setReplyingTo(comment);
    setDiscussionOpen(true);
    // Focused rather than merely shown: the composer is at the far end of the
    // page from a reply button deep in a thread.
    requestAnimationFrame(() => commentInputRef.current?.focus());
  }, []);

  const toggleFold = useCallback((commentId: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(commentId)) next.add(commentId);
      return next;
    });
  }, []);

  const handleSubmitComment = async () => {
    if (!commentBody.trim() && commentImages.length === 0) return;
    setSubmitting(true);
    try {
      // Uploaded in the order they were staged, then split by kind: the post
      // and the comment keep pictures and clips in separate lists because they
      // are laid out differently, not because they were added separately.
      // Progress lands on the staged tiles, which stay up until this is done.
      const outcomes = await uploadAll(commentImages, async (file, onProgress) => {
        const { url } = await apiUploadFile(file, onProgress);
        return url;
      });
      const failed = outcomes.filter((o) => o.url === null);
      if (failed.length > 0) {
        // Posting the rest would quietly drop the others; everything is still
        // staged, so the comment can go again as it stands.
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
      // The server wants a body; a comment that is only media says so.
      const count = imageUrls.length + videoUrls.length;
      const body =
        commentBody.trim() ||
        (count > 1 ? `(${count} attachments)` : count === 1 ? "(attachment)" : "");
      const { comment_id } = await apiCreateForumComment(
        roomId,
        postId,
        body,
        imageUrls,
        videoUrls,
        replyingTo?.comment_id,
      );
      setCommentBody("");
      clearCommentImages();
      resetUploadProgress();
      setReplyingTo(null);
      // A reply lands wherever its parent is, which is rarely the bottom.
      setLandingCommentId(comment_id);
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

  const thread = buildCommentThread(comments);

  /**
   * One comment and everything hanging off it.
   *
   * A plain recursive function rather than a component: every branch needs the
   * edit, fold and reply state this closure already has, and threading a dozen
   * callbacks down an arbitrarily deep tree buys nothing.
   */
  function renderComment(node: ForumCommentNode) {
    const comment = node.comment;
    const replyCount = countReplies(node);
    const isFolded = folded.has(comment.comment_id);
    const isEditing = editingCommentId === comment.comment_id;
    const isReplyTarget = replyingTo?.comment_id === comment.comment_id;
    const canDeleteComment = comment.author === state.userId || isOwnerOrMod();
    const isCommentAuthor = comment.author === state.userId;
    // The post's author, answering in their own thread, is worth marking.
    const isThreadAuthor = comment.author === post!.author;

    return (
      <div key={comment.comment_id}>
        <div
          id={`forum-comment-${comment.comment_id}`}
          className={cn(
            "group rounded-md border p-2.5 transition-colors",
            isReplyTarget && "border-primary/60 bg-primary/5",
            comment.deleted && "border-dashed",
          )}
        >
          {comment.deleted ? (
            // Kept only because replies hang off it; saying so beats a gap in
            // the thread where an answer's question used to be.
            <p className="ui-hint italic">Comment deleted</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{displayUserId(comment.author)}</span>
                {isThreadAuthor && (
                  <span className="rounded bg-secondary px-1 py-px text-3xs font-medium text-muted-foreground">
                    author
                  </span>
                )}
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
                      title="Delete comment"
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
                      if (e.key === "Escape") cancelEditingComment();
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

              <ForumMediaGallery
                images={forumImages(comment)}
                videos={forumVideos(comment)}
                className="mt-2"
                compact
              />
            </>
          )}

          <div className="mt-1.5 flex items-center gap-3">
            {!comment.deleted && (
              <button
                onClick={() => startReply(comment)}
                className="flex items-center gap-1 text-3xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <CornerUpLeft className="w-3 h-3" />
                Reply
              </button>
            )}
            {replyCount > 0 && (
              <button
                onClick={() => toggleFold(comment.comment_id)}
                className="flex items-center gap-1 text-3xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                {isFolded ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </button>
            )}
          </div>
        </div>

        {node.replies.length > 0 && !isFolded && (
          <div
            className={cn(
              "mt-2 space-y-2",
              // The rail stops stepping in after a few levels: a long
              // back-and-forth would otherwise walk off the right of a phone,
              // and by then the rail says less than the reply button did.
              node.depth < MAX_THREAD_INDENT ? "ml-3 border-l pl-3" : "border-l pl-3",
            )}
          >
            {node.replies.map(renderComment)}
          </div>
        )}
      </div>
    );
  }

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
        <div className="p-4 space-y-4">
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
                <h1 className="text-2xl font-bold leading-tight flex-1">{post.title}</h1>
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

          {/* Post body, then its pictures — the post is what the page is for,
              so it gets the room and reads in the order an article does. */}
          {!editingPost && post.body && (
            <ForumMarkdown content={post.body} className="text-base leading-relaxed" />
          )}
          {!editingPost && (
            <ForumMediaGallery images={forumImages(post)} videos={forumVideos(post)} />
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

          {/* Discussion — behind the post, not beside it: a rule, a quieter
              heading, and a fold, so the page is the post first. */}
          <div className="border-t pt-3">
            <button
              onClick={() => setDiscussionOpen((open) => !open)}
              className="flex w-full items-center gap-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              {discussionOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <MessageSquare className="w-3.5 h-3.5" />
              Discussion
              <span className="tabular-nums">{comments.length}</span>
            </button>

            {discussionOpen && (
              <div className="mt-3 space-y-2">
                {thread.length === 0 && (
                  <p className="ui-hint py-2">
                    Nothing here yet. Say the first thing.
                  </p>
                )}
                {thread.map(renderComment)}
              </div>
            )}
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
        <div>
          {replyingTo && (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1 text-xs">
              <CornerUpLeft className="w-3 h-3 shrink-0 text-primary" />
              <span className="shrink-0">
                Replying to <span className="font-medium">{displayUserId(replyingTo.author)}</span>
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {replyingTo.body}
              </span>
              <button
                onClick={() => setReplyingTo(null)}
                className="shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
                title="Reply to the post instead"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          {commentImages.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {commentImages.map((pending, i) => (
                <div key={pending.id} className="relative">
                  {pending.file.type.startsWith("video/") ? (
                    <video
                      src={pending.previewUrl ?? ""}
                      muted
                      playsInline
                      preload="metadata"
                      className="h-16 w-16 rounded-md border border-border bg-black object-cover"
                    />
                  ) : (
                    <img
                      src={pending.previewUrl ?? ""}
                      alt={pending.file.name}
                      className="h-16 w-16 rounded-md border border-border object-cover"
                    />
                  )}
                  <UploadProgressOverlay progress={uploadProgress[pending.id]} />
                  {!submitting && (
                    <button
                      onClick={() => removeCommentImage(i)}
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
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={IMAGE_AND_VIDEO_ACCEPT}
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
                  ? `Add images or videos (${commentImagesRemaining} of ${MAX_ATTACHMENTS} left)`
                  : `${MAX_ATTACHMENTS} files is the limit`
              }
            >
              <ImagePlus className="w-4 h-4" />
            </Button>
            <Textarea
              ref={commentInputRef}
              placeholder={replyingTo ? `Reply to ${displayUserId(replyingTo.author)}…` : "Write a comment..."}
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
