import { useState, useEffect, useCallback, useRef, type FormEvent } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetInviteInfo, apiAcceptInvite } from "@/lib/api";
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
import { HalftoneBackground } from "@/components/HalftoneBackground";
import { AuthImage } from "@/components/AuthImage";
import {
  hasInvalidUsernameChars,
  sanitizeUsernameInput,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  validateUsername,
} from "@/lib/username";

const CONNECTION_STEPS = [
  { ms: 0, text: "initializing handshake..." },
  { ms: 500, text: "verifying access credentials..." },
  { ms: 1000, text: "establishing encrypted channel..." },
  { ms: 1500, text: "routing to server endpoint..." },
  { ms: 2000, text: "syncing session state..." },
  { ms: 2500, text: "connection established." },
];
const TOTAL_DELAY_MS = 3500;

interface InvitePageProps {
  inviteCode: string;
}

export function InvitePage({ inviteCode }: InvitePageProps) {
  const { state, login, loadRooms, selectRoom } = useAppContext();
  const [inviteInfo, setInviteInfo] = useState<{
    room_name: string;
    icon_url: string;
    member_count: number;
  } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  // Login form state
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [nicknameWarning, setNicknameWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [visibleSteps, setVisibleSteps] = useState<number>(0);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [hovered, setHovered] = useState(false);
  const [btnHovered, setBtnHovered] = useState(false);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  const clearStepTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  // Fetch invite info
  useEffect(() => {
    apiGetInviteInfo(inviteCode)
      .then(setInviteInfo)
      .catch(() => setInviteError("This invite link is invalid or has expired."));
  }, [inviteCode]);

  // After login, handle pending invite
  useEffect(() => {
    if (state.accessToken && inviteInfo && !accepting) {
      setAccepting(true);
      (async () => {
        try {
          const { room_id } = await apiAcceptInvite(inviteCode);
          await loadRooms();
          await selectRoom(room_id);
          window.history.replaceState({}, "", "/");
        } catch {
          setInviteError("Failed to join room.");
        } finally {
          setAccepting(false);
        }
      })();
    }
  }, [state.accessToken]);

  const handleAccept = async () => {
    if (!state.accessToken) {
      setShowLogin(true);
      return;
    }
    setAccepting(true);
    try {
      const { room_id } = await apiAcceptInvite(inviteCode);
      await loadRooms();
      await selectRoom(room_id);
      window.history.replaceState({}, "", "/");
    } catch {
      setInviteError("Failed to join room.");
    } finally {
      setAccepting(false);
    }
  };

  const handleLogin = useCallback(
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

      if (!password) {
        setError("Password is required");
        return;
      }

      if (needsTotp && !totpCode) {
        setError("Authenticator code is required");
        return;
      }

      setLoading(true);
      setVisibleSteps(0);

      CONNECTION_STEPS.forEach((step, i) => {
        const t = setTimeout(() => {
          setVisibleSteps(i + 1);
        }, step.ms);
        timeoutsRef.current.push(t);
      });

      await new Promise((r) => setTimeout(r, TOTAL_DELAY_MS));
      clearStepTimeouts();

      try {
        const result = await login(name, password, needsTotp ? totpCode : undefined);
        if (result.requires_totp) {
          setNeedsTotp(true);
          setLoading(false);
          setVisibleSteps(0);
          return;
        }
        // The useEffect above will handle invite acceptance after login
      } catch (err: any) {
        setError(err.message || "Could not connect. Is the server running?");
        setLoading(false);
        setVisibleSteps(0);
      }
    },
    [nickname, password, totpCode, needsTotp, login, clearStepTimeouts],
  );

  useEffect(() => () => clearStepTimeouts(), [clearStepTimeouts]);

  // Error state
  if (inviteError) {
    return (
      <div className="relative flex min-h-screen items-center justify-center p-4">
        <HalftoneBackground />
        <Card
          className="relative z-10 w-full max-w-md p-0 rounded-md border-[1px] shadow-none overflow-hidden"
          style={{
            borderColor: "rgba(255, 120, 100, 0.25)",
            background: "rgba(10, 10, 10, 0.92)",
            backdropFilter: "blur(4px)",
          }}
        >
          <CardContent className="px-6 py-8 text-center">
            <div
              className="text-lg font-bold tracking-[0.08em] mb-3"
              style={{ color: "rgba(255, 120, 100, 0.8)" }}
            >
              Invalid Invite
            </div>
            <p
              className="text-sm tracking-wide mb-6"
              style={{ color: "rgba(180, 210, 255, 0.5)" }}
            >
              {inviteError}
            </p>
            <Button
              variant="outline"
              className="rounded-md border-[1px] text-xs uppercase tracking-[0.2em]"
              style={{
                borderColor: "rgba(180, 210, 255, 0.2)",
                color: "rgba(220, 230, 255, 0.8)",
                background: "rgba(180, 210, 255, 0.04)",
              }}
              onClick={() => {
                window.history.replaceState({}, "", "/");
                window.location.reload();
              }}
            >
              Go to Chatter
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Loading invite info
  if (!inviteInfo) {
    return (
      <div className="relative flex min-h-screen items-center justify-center p-4">
        <HalftoneBackground />
        <div
          className="text-sm tracking-wide animate-pulse"
          style={{ color: "rgba(180, 210, 255, 0.5)" }}
        >
          Loading invite...
        </div>
      </div>
    );
  }

  // Show login form
  if (showLogin && !state.accessToken) {
    return (
      <div className="relative flex min-h-screen items-center justify-center p-4">
        <HalftoneBackground />
        <Card
          className="relative z-10 w-full max-w-md p-0 rounded-md border-[1px] shadow-none overflow-hidden"
          style={{
            borderColor: hovered
              ? "rgba(180, 210, 255, 0.3)"
              : "rgba(180, 210, 255, 0.15)",
            boxShadow: hovered
              ? "0 0 40px rgba(180, 210, 255, 0.08), 0 0 80px rgba(180, 210, 255, 0.03)"
              : "0 0 20px rgba(180, 210, 255, 0.04)",
            background: "rgba(10, 10, 10, 0.92)",
            backdropFilter: "blur(4px)",
            transition: "border-color 0.4s ease, box-shadow 0.4s ease",
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <CardHeader className="text-center pb-0 pt-6 px-6">
            <div
              className="text-[10px] uppercase tracking-[0.3em] mb-4 text-left"
              style={{ color: "rgba(180, 210, 255, 0.35)" }}
            >
              Sign in to accept invite
            </div>
            <CardTitle
              className="text-2xl font-bold tracking-[0.08em]"
              style={{ color: "rgba(220, 230, 255, 0.95)" }}
            >
              Join {inviteInfo.room_name}
            </CardTitle>
            <CardDescription
              className="text-xs mt-2 tracking-[0.08em]"
              style={{ color: "rgba(180, 210, 255, 0.4)" }}
            >
              {loading ? "authenticating..." : "enter your credentials to continue"}
            </CardDescription>
            <div
              className="mt-4 h-px w-full"
              style={{ background: "rgba(180, 210, 255, 0.1)" }}
            />
          </CardHeader>
          <CardContent className="px-6 pt-5 pb-6">
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
                        color:
                          isLast && visible
                            ? "rgba(120, 230, 160, 0.9)"
                            : visible
                              ? "rgba(200, 220, 255, 0.75)"
                              : "transparent",
                      }}
                    >
                      <span
                        style={{
                          color:
                            isLast && visible
                              ? "rgba(120, 230, 160, 0.6)"
                              : "rgba(180, 210, 255, 0.3)",
                        }}
                      >
                        {isLast && visible ? "\u2713" : ">"}
                      </span>
                      <span>{step.text}</span>
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
              <form onSubmit={handleLogin} className="space-y-5">
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
                        setNicknameWarning("Please change your username: emojis and special characters are not allowed.");
                      } else if (nextNickname.length === USERNAME_MAX_LENGTH) {
                        setNicknameWarning(`Username max length reached (${USERNAME_MAX_LENGTH} characters).`);
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
                    className={`rounded-md border-[1px] bg-transparent h-10 text-sm tracking-wide placeholder:tracking-normal ${nicknameError ? "border-destructive" : ""}`}
                    style={{
                      borderColor: nicknameError ? undefined : "rgba(180, 210, 255, 0.12)",
                      color: "rgba(220, 230, 255, 0.85)",
                      caretColor: "rgba(180, 210, 255, 0.6)",
                    }}
                  />
                  {nicknameError && (
                    <p className="text-[10px] tracking-[0.08em]" style={{ color: "rgba(255, 120, 100, 0.8)" }}>
                      err: {nicknameError}
                    </p>
                  )}
                  {!nicknameError && nicknameWarning && (
                    <p className="text-[10px] tracking-[0.08em]" style={{ color: "rgba(255, 190, 90, 0.85)" }}>
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
                    password
                  </Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder=">"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    disabled={loading}
                    className="rounded-md border-[1px] bg-transparent h-10 text-sm tracking-[0.15em]"
                    style={{
                      borderColor: "rgba(180, 210, 255, 0.12)",
                      color: "rgba(220, 230, 255, 0.85)",
                      caretColor: "rgba(180, 210, 255, 0.6)",
                    }}
                  />
                </div>
                {needsTotp && (
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="totp"
                      className="text-[10px] uppercase tracking-[0.2em]"
                      style={{ color: "rgba(180, 210, 255, 0.4)" }}
                    >
                      {useRecoveryCode ? "recovery code" : "authenticator code"}
                    </Label>
                    {useRecoveryCode ? (
                      <Input
                        id="totp"
                        placeholder="A3K9M2X7"
                        value={totpCode}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
                          setTotpCode(v);
                          if (error) setError(null);
                        }}
                        maxLength={8}
                        autoFocus
                        disabled={loading}
                        className="rounded-md border-[1px] bg-transparent h-10 text-sm tracking-[0.3em] text-center font-mono"
                        style={{
                          borderColor: "rgba(180, 210, 255, 0.12)",
                          color: "rgba(220, 230, 255, 0.85)",
                          caretColor: "rgba(180, 210, 255, 0.6)",
                        }}
                      />
                    ) : (
                      <Input
                        id="totp"
                        placeholder="000000"
                        value={totpCode}
                        onChange={(e) => {
                          const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                          setTotpCode(v);
                          if (error) setError(null);
                        }}
                        maxLength={6}
                        autoFocus
                        disabled={loading}
                        className="rounded-md border-[1px] bg-transparent h-10 text-sm tracking-[0.3em] text-center font-mono"
                        style={{
                          borderColor: "rgba(180, 210, 255, 0.12)",
                          color: "rgba(220, 230, 255, 0.85)",
                          caretColor: "rgba(180, 210, 255, 0.6)",
                        }}
                      />
                    )}
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setUseRecoveryCode(!useRecoveryCode);
                          setTotpCode("");
                          setError(null);
                        }}
                        className="text-[10px] uppercase tracking-[0.15em] cursor-pointer bg-transparent border-0 p-0"
                        style={{ color: "rgba(180, 210, 255, 0.5)", transition: "color 0.2s" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(180, 210, 255, 0.85)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(180, 210, 255, 0.5)")}
                      >
                        {useRecoveryCode ? "use authenticator" : "use recovery code"}
                      </button>
                    </div>
                  </div>
                )}
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
                  className="w-full rounded-md h-10 text-xs uppercase tracking-[0.2em] font-normal border-[1px]"
                  variant="outline"
                  style={{
                    borderColor: btnHovered ? "rgba(180, 210, 255, 0.4)" : "rgba(180, 210, 255, 0.2)",
                    color: btnHovered ? "rgba(220, 230, 255, 1)" : "rgba(220, 230, 255, 0.8)",
                    background: btnHovered ? "rgba(180, 210, 255, 0.1)" : "rgba(180, 210, 255, 0.04)",
                    boxShadow: btnHovered ? "0 0 20px rgba(180, 210, 255, 0.06)" : "none",
                    transition: "border-color 0.25s, color 0.25s, background 0.25s, box-shadow 0.25s",
                  }}
                  onMouseEnter={() => setBtnHovered(true)}
                  onMouseLeave={() => setBtnHovered(false)}
                >
                  connect & join
                </Button>
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      window.history.replaceState({}, "", "/?action=register");
                      window.location.reload();
                    }}
                    className="text-[10px] uppercase tracking-[0.15em] cursor-pointer bg-transparent border-0 p-0"
                    style={{ color: "rgba(180, 210, 255, 0.5)", transition: "color 0.2s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(180, 210, 255, 0.85)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(180, 210, 255, 0.5)")}
                  >
                    create account
                  </button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
        <style>{`
          @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}</style>
      </div>
    );
  }

  // Accepting state (logged in, auto-joining)
  if (accepting) {
    return (
      <div className="relative flex min-h-screen items-center justify-center p-4">
        <HalftoneBackground />
        <div
          className="text-sm tracking-wide animate-pulse"
          style={{ color: "rgba(180, 210, 255, 0.5)" }}
        >
          Joining room...
        </div>
      </div>
    );
  }

  // Main invite card
  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <HalftoneBackground />
      <Card
        className="relative z-10 w-full max-w-md p-0 rounded-md border-[1px] shadow-none overflow-hidden"
        style={{
          borderColor: hovered
            ? "rgba(180, 210, 255, 0.3)"
            : "rgba(180, 210, 255, 0.15)",
          boxShadow: hovered
            ? "0 0 40px rgba(180, 210, 255, 0.08), 0 0 80px rgba(180, 210, 255, 0.03)"
            : "0 0 20px rgba(180, 210, 255, 0.04)",
          background: "rgba(10, 10, 10, 0.92)",
          backdropFilter: "blur(4px)",
          transition: "border-color 0.4s ease, box-shadow 0.4s ease",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <CardHeader className="text-center pb-0 pt-8 px-6">
          <div
            className="text-[10px] uppercase tracking-[0.3em] mb-6 text-center"
            style={{ color: "rgba(180, 210, 255, 0.35)" }}
          >
            Room Invite
          </div>

          {/* Room icon */}
          <div className="flex justify-center mb-4">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center overflow-hidden text-xl font-bold"
              style={{
                background: "rgba(180, 210, 255, 0.08)",
                border: "1px solid rgba(180, 210, 255, 0.15)",
                color: "rgba(220, 230, 255, 0.7)",
              }}
            >
              {inviteInfo.icon_url ? (
                <AuthImage src={inviteInfo.icon_url} alt="" className="w-full h-full object-cover" />
              ) : (
                inviteInfo.room_name.charAt(0).toUpperCase()
              )}
            </div>
          </div>

          <CardTitle
            className="text-xl font-bold tracking-[0.05em]"
            style={{ color: "rgba(220, 230, 255, 0.95)" }}
          >
            You've been invited to join
          </CardTitle>
          <div
            className="text-2xl font-bold tracking-[0.05em] mt-1"
            style={{ color: "rgba(180, 210, 255, 0.9)" }}
          >
            {inviteInfo.room_name}
          </div>
          <CardDescription
            className="text-xs mt-3 tracking-[0.08em]"
            style={{ color: "rgba(180, 210, 255, 0.4)" }}
          >
            {inviteInfo.member_count} member{inviteInfo.member_count !== 1 ? "s" : ""}
          </CardDescription>
        </CardHeader>

        <CardContent className="px-6 pt-6 pb-8">
          <Button
            onClick={handleAccept}
            disabled={accepting}
            className="w-full rounded-md h-10 text-xs uppercase tracking-[0.2em] font-normal border-[1px]"
            variant="outline"
            style={{
              borderColor: btnHovered ? "rgba(120, 230, 160, 0.5)" : "rgba(120, 230, 160, 0.25)",
              color: btnHovered ? "rgba(120, 230, 160, 1)" : "rgba(120, 230, 160, 0.85)",
              background: btnHovered ? "rgba(120, 230, 160, 0.1)" : "rgba(120, 230, 160, 0.04)",
              boxShadow: btnHovered ? "0 0 20px rgba(120, 230, 160, 0.08)" : "none",
              transition: "border-color 0.25s, color 0.25s, background 0.25s, box-shadow 0.25s",
            }}
            onMouseEnter={() => setBtnHovered(true)}
            onMouseLeave={() => setBtnHovered(false)}
          >
            {accepting ? "Joining..." : "Accept Invite"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
