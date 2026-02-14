import { useState, useCallback, useEffect, useRef, type FormEvent } from "react";
import { useAppContext } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HalftoneBackground } from "@/components/HalftoneBackground";
import {
  hasInvalidUsernameChars,
  sanitizeUsernameInput,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  validateUsername,
} from "@/lib/username";

const DEV_PASSWORD = "chatter-dev-pass";
const ACCESS_CODE = "ZGAF";

const CONNECTION_STEPS = [
  { ms: 0,    text: "initializing handshake..." },
  { ms: 900,  text: "verifying access credentials..." },
  { ms: 1800, text: "establishing encrypted channel..." },
  { ms: 2700, text: "routing to server endpoint..." },
  { ms: 3600, text: "syncing session state..." },
  { ms: 4500, text: "connection established." },
];
const TOTAL_DELAY_MS = 5000;

export function LoginScreen() {
  const { login, register } = useAppContext();
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [nicknameWarning, setNicknameWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [btnHovered, setBtnHovered] = useState(false);
  const [visibleSteps, setVisibleSteps] = useState<number>(0);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Clear any pending step timeouts
  const clearStepTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  const handleEnter = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const name = nickname.trim();
      setError(null);

      const usernameValidationError = validateUsername(name);
      if (usernameValidationError) {
        setNicknameError(usernameValidationError);
        return;
      }
      setNicknameError(null);
      setNicknameWarning(null);

      if (password !== ACCESS_CODE) {
        setError("Invalid access code");
        return;
      }

      setLoading(true);
      setVisibleSteps(0);

      // Schedule each connection step to appear
      CONNECTION_STEPS.forEach((step, i) => {
        const t = setTimeout(() => {
          setVisibleSteps(i + 1);
        }, step.ms);
        timeoutsRef.current.push(t);
      });

      // Wait the full dramatic delay, then actually authenticate
      await new Promise((r) => setTimeout(r, TOTAL_DELAY_MS));
      clearStepTimeouts();

      try {
        let registered = false;
        try {
          await register(name, DEV_PASSWORD);
          registered = true;
        } catch (regErr: any) {
          if (regErr.message?.includes("Cannot reach server")) {
            throw regErr;
          }
        }
        if (!registered) {
          await login(name, DEV_PASSWORD);
        }
      } catch (err: any) {
        setError(err.message || "Could not connect. Is the server running?");
        setLoading(false);
        setVisibleSteps(0);
      }
    },
    [nickname, password, login, register, clearStepTimeouts]
  );

  // Cleanup timeouts on unmount
  useEffect(() => () => clearStepTimeouts(), [clearStepTimeouts]);

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <HalftoneBackground />

      {/* Help icon — bottom right corner */}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="fixed bottom-5 right-5 z-20 flex h-8 w-8 items-center justify-center rounded-none border-[1px] text-xs cursor-pointer"
              style={{
                borderColor: "rgba(180, 210, 255, 0.15)",
                color: "rgba(180, 210, 255, 0.4)",
                background: "rgba(10, 10, 10, 0.6)",
                transition: "border-color 0.3s, color 0.3s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "rgba(180, 210, 255, 0.35)";
                e.currentTarget.style.color = "rgba(220, 230, 255, 0.8)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "rgba(180, 210, 255, 0.15)";
                e.currentTarget.style.color = "rgba(180, 210, 255, 0.4)";
              }}
            >
              ?
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="left"
            sideOffset={8}
            className="max-w-[240px] rounded-none border-[1px] text-[11px] leading-relaxed tracking-wide"
            style={{
              borderColor: "rgba(180, 210, 255, 0.2)",
              background: "rgba(10, 10, 10, 0.95)",
              color: "rgba(220, 230, 255, 0.75)",
            }}
          >
            <p className="font-bold mb-1" style={{ color: "rgba(220, 230, 255, 0.9)" }}>
              Chatter
            </p>
            <p>
              A lightweight self-hosted chat app. Pick a nickname, enter the
              access code, and start talking. Voice, text, reactions — all
              in real time.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Card
        className="relative z-10 w-full max-w-md p-0 rounded-none border-[1px] shadow-none overflow-hidden"
        style={{
          borderColor: loading
            ? `rgba(180, 210, 255, ${0.15 + (visibleSteps / CONNECTION_STEPS.length) * 0.45})`
            : hovered
            ? "rgba(180, 210, 255, 0.3)"
            : "rgba(180, 210, 255, 0.15)",
          boxShadow: loading
            ? (() => {
                const p = visibleSteps / CONNECTION_STEPS.length;
                const r1 = Math.round(40 + p * 120);
                const r2 = Math.round(80 + p * 220);
                const a1 = (0.04 + p * 0.18).toFixed(3);
                const a2 = (0.02 + p * 0.08).toFixed(3);
                return `0 0 ${r1}px rgba(180, 210, 255, ${a1}), 0 0 ${r2}px rgba(180, 210, 255, ${a2})`;
              })()
            : hovered
            ? "0 0 40px rgba(180, 210, 255, 0.08), 0 0 80px rgba(180, 210, 255, 0.03), inset 0 0 30px rgba(0,0,0,0.2)"
            : "0 0 20px rgba(180, 210, 255, 0.04), inset 0 0 30px rgba(0,0,0,0.3)",
          background: "rgba(10, 10, 10, 0.92)",
          backdropFilter: "blur(4px)",
          transition:
            "border-color 0.4s ease, box-shadow 0.4s ease, transform 0.3s ease",
          transform: hovered && !loading ? "translateY(-2px)" : "translateY(0)",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setHovered(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setHovered(false);
        }}
      >
        <CardHeader className="text-center pb-0 pt-6 px-6">
          <div
            className="text-[10px] uppercase tracking-[0.3em] mb-8 text-left"
            style={{ color: "rgba(180, 210, 255, 0.35)" }}
          >
            v0.1.0 - Internal Build
          </div>
          <CardTitle
            className="text-5xl font-bold tracking-[0.1em] uppercase"
            style={{ color: "rgba(220, 230, 255, 0.95)" }}
          >
            Chatter
          </CardTitle>
          <CardDescription
            className="text-xs mt-3 tracking-[0.08em]"
            style={{ color: "rgba(180, 210, 255, 0.4)" }}
          >
            {loading ? "authenticating..." : "what will you chat about?"}
          </CardDescription>
          <div
            className="mt-4 h-px w-full"
            style={{ background: "rgba(180, 210, 255, 0.1)" }}
          />
        </CardHeader>

        <CardContent className="px-6 pt-5 pb-6">
          {/* ── Connection sequence ── */}
          {loading ? (
            <div className="space-y-1" style={{ minHeight: "9rem" }}>
              {CONNECTION_STEPS.map((step, i) => {
                const visible = i < visibleSteps;
                const isLast = i === CONNECTION_STEPS.length - 1;
                const isCurrent = i === visibleSteps - 1;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-[11px] tracking-wide"
                    style={{
                      opacity: visible ? 1 : 0,
                      transform: visible ? "translateX(0)" : "translateX(-6px)",
                      transition: "opacity 0.3s ease, transform 0.3s ease",
                      color: isLast && visible
                        ? "rgba(120, 230, 160, 0.9)"
                        : visible
                        ? "rgba(200, 220, 255, 0.75)"
                        : "transparent",
                    }}
                  >
                    <span style={{ color: isLast && visible ? "rgba(120, 230, 160, 0.6)" : "rgba(180, 210, 255, 0.3)" }}>
                      {isLast && visible ? "✓" : ">"}
                    </span>
                    <span>{step.text}</span>
                    {/* blinking cursor on the current active line */}
                    {isCurrent && !isLast && (
                      <span
                        className="inline-block w-[6px] h-[11px] ml-0.5 align-middle"
                        style={{
                          background: "rgba(180, 210, 255, 0.6)",
                          animation: "blink 0.8s step-end infinite",
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {/* Progress bar */}
              <div
                className="mt-4 h-px w-full overflow-hidden"
                style={{ background: "rgba(180, 210, 255, 0.08)" }}
              >
                <div
                  className="h-full"
                  style={{
                    background: "rgba(180, 210, 255, 0.4)",
                    width: `${(visibleSteps / CONNECTION_STEPS.length) * 100}%`,
                    transition: "width 0.8s ease",
                  }}
                />
              </div>
            </div>
          ) : (
            /* ── Normal form ── */
            <form onSubmit={handleEnter} className="space-y-5">
              <div className="space-y-1.5">
                <Label
                  htmlFor="nickname"
                  className="text-[10px] uppercase tracking-[0.2em]"
                  style={{ color: "rgba(180, 210, 255, 0.4)" }}
                >
                  username
                </Label>
                <Input
                  id="nickname"
                  placeholder=">"
                  value={nickname}
                  onChange={(e) => {
                    const rawNickname = e.target.value;
                    const hadInvalidChars = hasInvalidUsernameChars(rawNickname);
                    const nextNickname = sanitizeUsernameInput(rawNickname);

                    setNickname(nextNickname);

                    if (hadInvalidChars) {
                      setNicknameWarning(
                        "Please change your username: emojis and special characters are not allowed."
                      );
                    } else if (nextNickname.length === USERNAME_MAX_LENGTH) {
                      setNicknameWarning(
                        `Username max length reached (${USERNAME_MAX_LENGTH} characters).`
                      );
                    } else {
                      setNicknameWarning(null);
                    }

                    if (nicknameError) {
                      setNicknameError(validateUsername(nextNickname));
                    }
                  }}
                  minLength={USERNAME_MIN_LENGTH}
                  maxLength={USERNAME_MAX_LENGTH}
                  pattern="[A-Za-z0-9_]+"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={loading}
                  autoFocus
                  className={`rounded-none border-[1px] bg-transparent h-10 text-sm tracking-wide placeholder:tracking-normal ${
                    nicknameError ? "border-destructive" : ""
                  }`}
                  style={{
                    borderColor: nicknameError
                      ? undefined
                      : "rgba(180, 210, 255, 0.12)",
                    color: "rgba(220, 230, 255, 0.85)",
                    caretColor: "rgba(180, 210, 255, 0.6)",
                  }}
                />
                {nicknameError && (
                  <p
                    className="text-[10px] tracking-[0.08em]"
                    style={{ color: "rgba(255, 120, 100, 0.8)" }}
                  >
                    err: {nicknameError}
                  </p>
                )}
                {!nicknameError && nicknameWarning && (
                  <p
                    className="text-[10px] tracking-[0.08em]"
                    style={{ color: "rgba(255, 190, 90, 0.85)" }}
                  >
                    warn: {nicknameWarning}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="password"
                  className="text-[10px] uppercase tracking-[0.2em]"
                  style={{ color: "rgba(180, 210, 255, 0.4)" }}
                >
                  access code
                </Label>
                <Input
                  id="password"
                  type="password"
                  placeholder=">"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error === "Invalid access code") setError(null);
                  }}
                  disabled={loading}
                  className="rounded-none border-[1px] bg-transparent h-10 text-sm tracking-[0.15em]"
                  style={{
                    borderColor: "rgba(180, 210, 255, 0.12)",
                    color: "rgba(220, 230, 255, 0.85)",
                    caretColor: "rgba(180, 210, 255, 0.6)",
                  }}
                />
              </div>

              {error && (
                <div
                  className="p-3 text-[11px] uppercase tracking-[0.08em] border-[1px]"
                  style={{
                    borderColor: "rgba(255, 120, 100, 0.25)",
                    background: "rgba(255, 120, 100, 0.05)",
                    color: "rgba(255, 120, 100, 0.8)",
                  }}
                >
                  &gt; {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={loading}
                className="w-full rounded-none h-10 text-xs uppercase tracking-[0.2em] font-normal border-[1px]"
                variant="outline"
                style={{
                  borderColor: btnHovered
                    ? "rgba(180, 210, 255, 0.4)"
                    : "rgba(180, 210, 255, 0.2)",
                  color: btnHovered
                    ? "rgba(220, 230, 255, 1)"
                    : "rgba(220, 230, 255, 0.8)",
                  background: btnHovered
                    ? "rgba(180, 210, 255, 0.1)"
                    : "rgba(180, 210, 255, 0.04)",
                  boxShadow: btnHovered
                    ? "0 0 20px rgba(180, 210, 255, 0.06)"
                    : "none",
                  transition:
                    "border-color 0.25s, color 0.25s, background 0.25s, box-shadow 0.25s",
                }}
                onMouseEnter={() => setBtnHovered(true)}
                onMouseLeave={() => setBtnHovered(false)}
              >
                connect
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* Blink keyframe */}
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
