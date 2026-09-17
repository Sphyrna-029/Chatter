import { useState } from "react";
import { useAppContext } from "@/lib/store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  DURATION_CHOICES,
  MAX_OPTION_LEN,
  MAX_OPTIONS,
  MAX_QUESTION_LEN,
  MIN_OPTIONS,
} from "@/lib/polls";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

/** Two blank answers to start: the fewest a poll can have, so the form opens
 *  showing exactly what has to be filled in. */
const EMPTY_OPTIONS = ["", ""];

/** An hour — long enough for a room to notice, short enough to be answered
 *  the same afternoon. */
const DEFAULT_MINUTES = 60;

export function PollDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        {/* The form is its own component so it mounts with the dialog and
            starts blank every time. Resetting the fields from an effect would
            be the same thing said twice — once in the initial state and once
            in the reset — and the two can drift. */}
        <PollForm
          onDone={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function PollForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const { createPoll } = useAppContext();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(EMPTY_OPTIONS);
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [multiSelect, setMultiSelect] = useState(false);
  const [saving, setSaving] = useState(false);

  const filled = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const duplicated =
    new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const ready =
    question.trim().length > 0 && filled.length >= MIN_OPTIONS && !duplicated;

  const setOption = (index: number, value: string) =>
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));

  const addOption = () =>
    setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, ""]));

  const removeOption = (index: number) =>
    setOptions((prev) =>
      prev.length <= MIN_OPTIONS ? prev : prev.filter((_, i) => i !== index),
    );

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      await createPoll({
        question: question.trim(),
        options: filled,
        duration_minutes: minutes,
        multi_select: multiSelect,
      });
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create the poll",
      );
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create a poll</DialogTitle>
        <DialogDescription>
          It posts in this channel, and the results are posted back here when it
          ends.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="poll-question">Question</Label>
          <Input
            id="poll-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What should we play on Friday?"
            maxLength={MAX_QUESTION_LEN}
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label>Answers</Label>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                value={option}
                onChange={(e) => setOption(index, e.target.value)}
                placeholder={`Answer ${index + 1}`}
                maxLength={MAX_OPTION_LEN}
                // Enter adds the next answer rather than submitting: the
                // form is a list being filled in, and a stray Enter posting
                // a half-written poll cannot be taken back.
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (index === options.length - 1) addOption();
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                disabled={options.length <= MIN_OPTIONS}
                onClick={() => removeOption(index)}
                title={
                  options.length <= MIN_OPTIONS
                    ? `A poll needs at least ${MIN_OPTIONS} answers`
                    : "Remove this answer"
                }
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full text-xs"
              onClick={addOption}
            >
              <Plus className="mr-1 h-3 w-3" />
              Add an answer
            </Button>
          )}
          {duplicated && (
            <p className="text-xs text-destructive">
              Two answers are the same — the result could not say which one won.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>Runs for</Label>
          <div className="flex flex-wrap gap-1.5">
            {DURATION_CHOICES.map((choice) => (
              <Button
                key={choice.minutes}
                type="button"
                size="sm"
                variant={minutes === choice.minutes ? "secondary" : "outline"}
                className={cn(
                  "h-8 text-xs",
                  minutes === choice.minutes && "border-primary/50",
                )}
                onClick={() => setMinutes(choice.minutes)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label htmlFor="poll-multi">Allow more than one answer</Label>
            <p className="text-xs text-muted-foreground">
              Everyone can tick several. The bars stay a share of the people who
              voted, not of the votes.
            </p>
          </div>
          <Switch
            id="poll-multi"
            checked={multiSelect}
            onCheckedChange={setMultiSelect}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!ready || saving}>
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Create poll
        </Button>
      </DialogFooter>
    </>
  );
}
