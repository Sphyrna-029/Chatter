import { useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiUploadFile, type RoomEvent } from "@/lib/api";
import { AuthImage } from "@/components/AuthImage";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImagePlus, Loader2, MapPin, Trash2, Volume2 } from "lucide-react";
import { toast } from "sonner";
import {
  REMINDER_LEAD_MINUTES,
  fromLocalInputValue,
  nextHalfHour,
  toLocalInputValue,
} from "@/lib/eventTime";

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The event being edited, or null to schedule a new one. */
  event: RoomEvent | null;
}

/** Where an event happens: a voice channel in this room, or somewhere else
 *  entirely. They are mutually exclusive, so one control chooses between them
 *  rather than two competing fields. */
type Place = "channel" | "elsewhere";

const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

/** Covers are decoration, and a card 22rem wide cannot show more than this is
 *  worth. The server's own upload limit still applies on top. */
const MAX_COVER_BYTES = 8 * 1024 * 1024;

export function EventDialog({ open, onOpenChange, event }: EventDialogProps) {
  const { state, createEvent, updateEvent } = useAppContext();
  const editing = !!event;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [place, setPlace] = useState<Place>("elsewhere");
  const [channelId, setChannelId] = useState("");
  const [location, setLocation] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [saving, setSaving] = useState(false);
  // Three states, not one: the URL already saved, a file chosen but not yet
  // uploaded, and the local preview of that file. The upload happens on save
  // so picking an image and then cancelling leaves nothing behind.
  const [coverUrl, setCoverUrl] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const voiceChannels = useMemo(
    () => state.channels.filter((c) => c.channel_type === "voice"),
    [state.channels],
  );

  // Re-seed each time the dialog opens, not on every render: a re-render while
  // someone is typing must not throw their draft away.
  useEffect(() => {
    if (!open) return;
    if (event) {
      setName(event.name);
      setDescription(event.description);
      setChannelId(event.channel_id);
      setLocation(event.location);
      setPlace(event.channel_id ? "channel" : "elsewhere");
      setStartsAt(toLocalInputValue(event.starts_at));
      setEndsAt(event.ends_at > 0 ? toLocalInputValue(event.ends_at) : "");
      setCoverUrl(event.cover_url);
    } else {
      const start = nextHalfHour();
      setName("");
      setDescription("");
      setChannelId(voiceChannels[0]?.channel_id ?? "");
      setLocation("");
      setPlace(voiceChannels.length > 0 ? "channel" : "elsewhere");
      setStartsAt(toLocalInputValue(start));
      setEndsAt(toLocalInputValue(start + DEFAULT_LENGTH_MS));
      setCoverUrl("");
    }
    setCoverFile(null);
    setCoverPreview(null);
    setSaving(false);
    // voiceChannels is only read to pick a default, and re-seeding when the
    // channel list happens to change would wipe a half-typed event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, event]);

  const startMs = fromLocalInputValue(startsAt);
  const endMs = fromLocalInputValue(endsAt);
  const nameOk = name.trim().length > 0;
  const startOk = Number.isFinite(startMs);
  // An end before the start is the one mistake worth blocking rather than
  // explaining after the fact; everything else the server will take.
  const endOk = !endsAt || (Number.isFinite(endMs) && endMs > startMs);
  const canSave = nameOk && startOk && endOk && !saving;
  const hasCover = !!coverPreview || !!coverUrl;

  function pickCover(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Let the same file be chosen again after a removal; without this the
    // input holds the old value and fires no change event.
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("That file is not an image");
      return;
    }
    const serverLimit = state.uploadLimitBytes;
    const limit = serverLimit > 0 ? Math.min(serverLimit, MAX_COVER_BYTES) : MAX_COVER_BYTES;
    if (file.size > limit) {
      toast.error(`That image is too large (max ${Math.floor(limit / 1024 / 1024)}MB)`);
      return;
    }
    setCoverFile(file);
    const reader = new FileReader();
    reader.onload = () => setCoverPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  function removeCover() {
    setCoverFile(null);
    setCoverPreview(null);
    setCoverUrl("");
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    let cover = coverUrl;
    if (coverFile) {
      try {
        cover = (await apiUploadFile(coverFile)).url;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not upload the image");
        setSaving(false);
        return;
      }
    }
    const draft = {
      name: name.trim(),
      description: description.trim(),
      location: place === "elsewhere" ? location.trim() : "",
      channel_id: place === "channel" ? channelId : "",
      starts_at: startMs,
      ends_at: endsAt && Number.isFinite(endMs) ? endMs : 0,
      cover_url: cover,
    };
    try {
      if (event) {
        await updateEvent(event.event_id, draft);
        toast.success("Event updated");
      } else {
        await createEvent(draft);
        toast.success("Event scheduled");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the event");
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit event" : "Schedule an event"}</DialogTitle>
          <DialogDescription>
            Times are in your own timezone — everyone sees them in theirs. Anyone
            who says they are coming is reminded {REMINDER_LEAD_MINUTES} minutes
            before it starts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Empty, this is a slim strip — a cover is optional decoration and
              should not push the name field down a screen to offer itself.
              Once there is an image it grows to the 3:1 the card will show. */}
          <button
            type="button"
            onClick={() => coverInputRef.current?.click()}
            className={cn(
              "group relative flex w-full items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-muted-foreground/30 transition-colors hover:border-muted-foreground/60 cursor-pointer",
              hasCover ? "aspect-[3/1]" : "h-14",
            )}
            aria-label={hasCover ? "Replace the cover image" : "Add a cover image"}
          >
            {coverPreview ? (
              <img src={coverPreview} alt="" className="h-full w-full object-cover" />
            ) : coverUrl ? (
              <AuthImage src={coverUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <ImagePlus className="h-4 w-4" />
                <span className="text-xs">Add a cover image</span>
              </span>
            )}
            {hasCover && (
              <span className="absolute inset-0 hidden items-center justify-center bg-background/60 text-xs font-medium group-hover:flex">
                Replace
              </span>
            )}
          </button>
          {hasCover && (
            <button
              type="button"
              onClick={removeCover}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
            >
              <Trash2 className="h-3 w-3" />
              Remove cover
            </button>
          )}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={pickCover}
          />

          <div className="space-y-1.5">
            <Label htmlFor="event-name">Name</Label>
            <Input
              id="event-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Board game night"
              maxLength={120}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="event-start">Starts</Label>
              <Input
                id="event-start"
                type="datetime-local"
                className="px-2"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="event-end">
                Ends <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="event-end"
                type="datetime-local"
                className="px-2"
                value={endsAt}
                min={startsAt || undefined}
                onChange={(e) => setEndsAt(e.target.value)}
                aria-invalid={!endOk}
              />
            </div>
          </div>
          {!endOk && (
            <p className="text-xs text-destructive">An event cannot end before it starts.</p>
          )}

          <div className="space-y-1.5">
            <Label>Where</Label>
            <div className="flex gap-1.5">
              <Button
                type="button"
                size="sm"
                variant={place === "channel" ? "secondary" : "outline"}
                className="flex-1 h-8 text-xs"
                disabled={voiceChannels.length === 0}
                title={
                  voiceChannels.length === 0
                    ? "This room has no voice channels"
                    : "Meet in a voice channel"
                }
                onClick={() => setPlace("channel")}
              >
                <Volume2 className="h-3.5 w-3.5" />
                Voice channel
              </Button>
              <Button
                type="button"
                size="sm"
                variant={place === "elsewhere" ? "secondary" : "outline"}
                className="flex-1 h-8 text-xs"
                onClick={() => setPlace("elsewhere")}
              >
                <MapPin className="h-3.5 w-3.5" />
                Somewhere else
              </Button>
            </div>
            {place === "channel" ? (
              <select
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {voiceChannels.map((c) => (
                  <option key={c.channel_id} value={c.channel_id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="A link, an address, or anything else"
                maxLength={200}
              />
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="event-description">
              Details <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id="event-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is it, what to bring, anything people should know."
              rows={3}
              maxLength={4000}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {editing ? "Save changes" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
