import { createContext, useCallback, useContext, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  /** Optional detail line under the title. */
  description?: string;
  /** Label for the confirming action. Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  /** A second question the confirm carries, asked as a checkbox. */
  checkbox?: ConfirmCheckbox;
}

export interface ConfirmCheckbox {
  label: string;
  /** Smaller line under the label, for what the choice means. */
  hint?: string;
  /** Where the box starts each time the dialog opens. Defaults to unticked. */
  defaultChecked?: boolean;
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

/**
 * Asking with a checkbox answers with both halves; asking without one keeps
 * answering with the plain boolean every existing caller reads.
 */
type ConfirmFn = {
  (options: ConfirmOptions & { checkbox: ConfirmCheckbox }): Promise<ConfirmResult>;
  (options: ConfirmOptions): Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Replaces window.confirm for destructive actions.
 *
 * Native confirm blocks the page with browser chrome that looks nothing like
 * the app, so this renders the same question as a themed dialog. It resolves
 * a promise rather than returning synchronously, so callers await it:
 *
 *     if (!(await confirm({ title: "Delete this channel?" }))) return;
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [checked, setChecked] = useState(false);
  const resolveRef = useRef<((value: boolean | ConfirmResult) => void) | null>(null);
  // What settle reads to tell which shape of answer was asked for. The state
  // above cannot serve: settle is built once and would close over whatever
  // `options` held at the time, which is null.
  const optionsRef = useRef<ConfirmOptions | null>(null);

  const ask = useCallback((opts: ConfirmOptions) => {
    setOptions(opts);
    optionsRef.current = opts;
    // A fresh question starts from its own default, never from whatever the
    // last one was left on.
    setChecked(opts.checkbox?.defaultChecked ?? false);
    return new Promise<boolean | ConfirmResult>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);
  // The overloads are what callers see: ask with a checkbox and both answers
  // come back, ask without one and the boolean does. One implementation
  // cannot state that itself.
  const confirm = ask as ConfirmFn;

  const settle = useCallback((result: boolean, checkedNow: boolean) => {
    const asked = optionsRef.current?.checkbox != null;
    setOptions(null);
    optionsRef.current = null;
    resolveRef.current?.(asked ? { confirmed: result, checked: checkedNow } : result);
    resolveRef.current = null;
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={options !== null}
        // Dismissing by escape or backdrop is a "no", and must still settle the
        // promise or the caller would hang forever.
        onOpenChange={(open) => !open && settle(false, checked)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{options?.title}</DialogTitle>
            {options?.description && (
              <DialogDescription>{options.description}</DialogDescription>
            )}
          </DialogHeader>
          {options?.checkbox && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="mt-0.5 rounded border-input"
              />
              <span className="text-sm">
                {options.checkbox.label}
                {options.checkbox.hint && (
                  <span className="block text-xs text-muted-foreground">
                    {options.checkbox.hint}
                  </span>
                )}
              </span>
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false, checked)}>
              {options?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={options?.destructive ? "destructive" : "default"}
              onClick={() => settle(true, checked)}
              autoFocus
            >
              {options?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/**
 * Ask the user to confirm an action. Outside a ConfirmProvider this falls back
 * to window.confirm so a stray caller still behaves correctly.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return (
    ctx ??
    ((async (opts: ConfirmOptions) => {
      const confirmed = window.confirm(
        opts.description ? `${opts.title}\n\n${opts.description}` : opts.title,
      );
      // Native confirm has nowhere to put a second question, so the checkbox
      // answers with its default.
      return opts.checkbox
        ? { confirmed, checked: opts.checkbox.defaultChecked ?? false }
        : confirmed;
    }) as ConfirmFn)
  );
}
