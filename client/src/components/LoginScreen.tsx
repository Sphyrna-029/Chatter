import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type FormEvent,
} from "react";
import { useAppContext } from "@/lib/store";
import { apiCheckUsername, apiVerifyTotp, apiGetServerInfo, getAccessToken, setAccessToken, setRefreshToken, setIsAdmin } from "@/lib/api";
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

type Step = "login" | "register" | "totp-setup" | "recovery-codes";

const CONNECTION_STEPS = [
  { ms: 0, text: "initializing handshake..." },
  { ms: 500, text: "verifying credentials..." },
  { ms: 1000, text: "establishing encrypted channel..." },
  { ms: 1500, text: "routing to server endpoint..." },
  { ms: 2000, text: "syncing session state..." },
  { ms: 2500, text: "connection established." },
];
const TOTAL_DELAY_MS = 3500;

export function LoginScreen() {
  const { login, register, dispatch } = useAppContext();
  const [step, setStep] = useState<Step>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("action") === "register") {
      window.history.replaceState({}, "", "/");
      return "register";
    }
    return "login";
  });

  // Login fields
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);

  // Register fields
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [serverInviteOnly, setServerInviteOnly] = useState(false);
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [checkingUsername, setCheckingUsername] = useState(false);
  const usernameCheckTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // TOTP setup
  const [totpSecret, setTotpSecret] = useState("");
  const [totpQrBase64, setTotpQrBase64] = useState("");
  const [totpVerifyCode, setTotpVerifyCode] = useState("");
  const [registeredUserId, setRegisteredUserId] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  // Common
  const [error, setError] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [nicknameWarning, setNicknameWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [btnHovered, setBtnHovered] = useState(false);
  const [visibleSteps, setVisibleSteps] = useState<number>(0);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearStepTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  // Fetch server info when switching to register step
  useEffect(() => {
    if (step === "register") {
      apiGetServerInfo().then((info) => setServerInviteOnly(info.invite_only)).catch(() => {});
    }
  }, [step]);

  // Username availability check (debounced)
  const checkUsernameAvailability = useCallback((name: string) => {
    if (usernameCheckTimeout.current) clearTimeout(usernameCheckTimeout.current);
    const trimmed = name.trim();
    if (trimmed.length < USERNAME_MIN_LENGTH) {
      setUsernameAvailable(null);
      return;
    }
    const validationError = validateUsername(trimmed);
    if (validationError) {
      setUsernameAvailable(null);
      return;
    }
    setCheckingUsername(true);
    usernameCheckTimeout.current = setTimeout(async () => {
      try {
        const result = await apiCheckUsername(trimmed);
        setUsernameAvailable(result.available);
      } catch {
        setUsernameAvailable(null);
      } finally {
        setCheckingUsername(false);
      }
    }, 400);
  }, []);

  const runConnectionAnimation = useCallback(async () => {
    setVisibleSteps(0);
    CONNECTION_STEPS.forEach((s, i) => {
      const t = setTimeout(() => setVisibleSteps(i + 1), s.ms);
      timeoutsRef.current.push(t);
    });
    await new Promise((r) => setTimeout(r, TOTAL_DELAY_MS));
    clearStepTimeouts();
  }, [clearStepTimeouts]);

  // ── Login handler ──
  const handleLogin = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const name = username.trim();
      setError(null);

      const usernameValidationError = validateUsername(name);
      if (usernameValidationError) {
        setNicknameError(usernameValidationError);
        return;
      }
      setNicknameError(null);

      if (!password) {
        setError("Password is required");
        return;
      }

      if (needsTotp && !totpCode) {
        setError("TOTP code is required");
        return;
      }

      setLoading(true);
      await runConnectionAnimation();

      try {
        const result = await login(name, password, needsTotp ? totpCode : undefined);
        if (result.requires_totp) {
          setNeedsTotp(true);
          setLoading(false);
          setVisibleSteps(0);
          return;
        }
      } catch (err: any) {
        setError(err.message || "Could not connect.");
        setLoading(false);
        setVisibleSteps(0);
      }
    },
    [username, password, totpCode, needsTotp, login, runConnectionAnimation],
  );

  // ── Register handler ──
  const handleRegister = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const name = regUsername.trim();
      setError(null);

      const usernameValidationError = validateUsername(name);
      if (usernameValidationError) {
        setNicknameError(usernameValidationError);
        return;
      }
      setNicknameError(null);

      if (regPassword.length < 6) {
        setError("Password must be at least 6 characters");
        return;
      }

      if (regPassword !== regConfirm) {
        setError("Passwords do not match");
        return;
      }

      if (usernameAvailable === false) {
        setError("Username is taken");
        return;
      }

      setLoading(true);

      try {
        const data = await register(name, regPassword, regConfirm, serverInviteOnly ? inviteCode : undefined);
        setTotpSecret(data.totp_secret);
        setTotpQrBase64(data.totp_qr_base64);
        setRegisteredUserId(data.user_id);
        setStep("totp-setup");
        setError(null);
      } catch (err: any) {
        setError(err.message || "Registration failed");
      } finally {
        setLoading(false);
      }
    },
    [regUsername, regPassword, regConfirm, usernameAvailable, register],
  );

  // ── TOTP verify handler ──
  const handleTotpVerify = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!totpVerifyCode || totpVerifyCode.length !== 6) {
        setError("Enter a 6-digit code from your authenticator app");
        return;
      }

      setLoading(true);
      await runConnectionAnimation();

      try {
        const result = await apiVerifyTotp(registeredUserId, totpVerifyCode);
        // Store tokens from verify response
        setAccessToken(result.access_token);
        setRefreshToken(result.refresh_token);
        if (result.is_admin !== undefined) setIsAdmin(result.is_admin);
        // Show recovery codes before completing login
        if (result.recovery_codes && result.recovery_codes.length > 0) {
          setRecoveryCodes(result.recovery_codes);
          setStep("recovery-codes");
          setLoading(false);
          setVisibleSteps(0);
          return;
        }
        // No recovery codes, complete login directly
        dispatch({
          type: "LOGIN",
          payload: { accessToken: result.access_token, userId: result.user_id },
        });
        dispatch({ type: "SET_IS_ADMIN", payload: !!result.is_admin });
        dispatch({ type: "SET_TOTP_VERIFIED", payload: true });
      } catch (err: any) {
        setError(err.message || "Verification failed");
        setLoading(false);
        setVisibleSteps(0);
      }
    },
    [totpVerifyCode, registeredUserId, dispatch, runConnectionAnimation],
  );

  useEffect(() => () => clearStepTimeouts(), [clearStepTimeouts]);

  // ── Shared styles ──
  const inputStyle = {
    borderColor: "rgba(180, 210, 255, 0.12)",
    color: "rgba(220, 230, 255, 0.85)",
    caretColor: "rgba(180, 210, 255, 0.6)",
  };

  const labelClass = "text-[10px] uppercase tracking-[0.2em]";
  const labelStyle = { color: "rgba(180, 210, 255, 0.4)" };

  const renderUsernameInput = (
    value: string,
    onChange: (v: string) => void,
    autoFocus?: boolean,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor="username" className={labelClass} style={labelStyle}>
        username
      </Label>
      <Input
        id="username"
        placeholder=">"
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          const hadInvalid = hasInvalidUsernameChars(raw);
          const next = sanitizeUsernameInput(raw);
          onChange(next);

          if (hadInvalid) {
            setNicknameWarning("Emojis and special characters are not allowed.");
          } else if (next.length === USERNAME_MAX_LENGTH) {
            setNicknameWarning(`Max length reached (${USERNAME_MAX_LENGTH}).`);
          } else {
            setNicknameWarning(null);
          }

          if (nicknameError) setNicknameError(validateUsername(next));
        }}
        minLength={USERNAME_MIN_LENGTH}
        maxLength={USERNAME_MAX_LENGTH}
        pattern="[A-Za-z0-9_]+"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={loading}
        autoFocus={autoFocus}
        className={`rounded-none border-[1px] bg-transparent h-10 text-sm tracking-wide placeholder:tracking-normal ${nicknameError ? "border-destructive" : ""}`}
        style={{
          borderColor: nicknameError ? undefined : inputStyle.borderColor,
          color: inputStyle.color,
          caretColor: inputStyle.caretColor,
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
  );

  const renderPasswordInput = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={labelClass} style={labelStyle}>
        {label}
      </Label>
      <Input
        id={id}
        type="password"
        placeholder=">"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (error) setError(null);
        }}
        disabled={loading}
        className="rounded-none border-[1px] bg-transparent h-10 text-sm tracking-[0.15em]"
        style={inputStyle}
      />
    </div>
  );

  const renderError = () =>
    error ? (
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
    ) : null;

  const renderButton = (text: string) => (
    <Button
      type="submit"
      disabled={loading}
      className="w-full rounded-none h-10 text-xs uppercase tracking-[0.2em] font-normal border-[1px]"
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
      {text}
    </Button>
  );

  const renderLink = (text: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] uppercase tracking-[0.15em] cursor-pointer bg-transparent border-0 p-0"
      style={{ color: "rgba(180, 210, 255, 0.5)", transition: "color 0.2s" }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(180, 210, 255, 0.85)")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(180, 210, 255, 0.5)")}
    >
      {text}
    </button>
  );

  const renderConnectionSequence = () => (
    <div className="space-y-1" style={{ minHeight: "9rem" }}>
      {CONNECTION_STEPS.map((s, i) => {
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
                : visible ? "rgba(200, 220, 255, 0.75)" : "transparent",
            }}
          >
            <span style={{ color: isLast && visible ? "rgba(120, 230, 160, 0.6)" : "rgba(180, 210, 255, 0.3)" }}>
              {isLast && visible ? "\u2713" : ">"}
            </span>
            <span>{s.text}</span>
            {isCurrent && !isLast && (
              <span
                className="inline-block w-[6px] h-[11px] ml-0.5 align-middle"
                style={{ background: "rgba(180, 210, 255, 0.6)", animation: "blink 0.8s step-end infinite" }}
              />
            )}
          </div>
        );
      })}
      <div className="mt-4 h-px w-full overflow-hidden" style={{ background: "rgba(180, 210, 255, 0.08)" }}>
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
  );

  // ── Step content ──
  const renderStepContent = () => {
    if (loading && step !== "totp-setup") return renderConnectionSequence();
    if (loading && step === "totp-setup") return renderConnectionSequence();

    switch (step) {
      case "login":
        return (
          <form onSubmit={handleLogin} className="space-y-5">
            {renderUsernameInput(username, setUsername, true)}
            {renderPasswordInput("password", "password", password, setPassword)}

            {needsTotp && (
              <div className="space-y-1.5">
                <Label htmlFor="totp" className={labelClass} style={labelStyle}>
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
                    className="rounded-none border-[1px] bg-transparent h-10 text-sm tracking-[0.3em] text-center font-mono"
                    style={inputStyle}
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
                    className="rounded-none border-[1px] bg-transparent h-10 text-sm tracking-[0.3em] text-center font-mono"
                    style={inputStyle}
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

            {renderError()}
            {renderButton("connect")}

            <div className="flex justify-center pt-1">
              {renderLink("create account", () => {
                setStep("register");
                setError(null);
                setNicknameError(null);
                setNicknameWarning(null);
                setNeedsTotp(false);
                setTotpCode("");
              })}
            </div>
          </form>
        );

      case "register":
        return (
          <form onSubmit={handleRegister} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="reg-username" className={labelClass} style={labelStyle}>
                username
              </Label>
              <Input
                id="reg-username"
                placeholder=">"
                value={regUsername}
                onChange={(e) => {
                  const raw = e.target.value;
                  const hadInvalid = hasInvalidUsernameChars(raw);
                  const next = sanitizeUsernameInput(raw);
                  setRegUsername(next);

                  if (hadInvalid) {
                    setNicknameWarning("Emojis and special characters are not allowed.");
                  } else if (next.length === USERNAME_MAX_LENGTH) {
                    setNicknameWarning(`Max length reached (${USERNAME_MAX_LENGTH}).`);
                  } else {
                    setNicknameWarning(null);
                  }

                  if (nicknameError) setNicknameError(validateUsername(next));
                  checkUsernameAvailability(next);
                }}
                minLength={USERNAME_MIN_LENGTH}
                maxLength={USERNAME_MAX_LENGTH}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={loading}
                autoFocus
                className={`rounded-none border-[1px] bg-transparent h-10 text-sm tracking-wide placeholder:tracking-normal ${nicknameError ? "border-destructive" : ""}`}
                style={{
                  borderColor: nicknameError ? undefined : inputStyle.borderColor,
                  color: inputStyle.color,
                  caretColor: inputStyle.caretColor,
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
              {!nicknameError && !nicknameWarning && regUsername.trim().length >= USERNAME_MIN_LENGTH && (
                <p className="text-[10px] tracking-[0.08em]" style={{
                  color: checkingUsername
                    ? "rgba(180, 210, 255, 0.4)"
                    : usernameAvailable === true
                      ? "rgba(120, 230, 160, 0.8)"
                      : usernameAvailable === false
                        ? "rgba(255, 120, 100, 0.8)"
                        : "transparent",
                }}>
                  {checkingUsername
                    ? "checking..."
                    : usernameAvailable === true
                      ? "username available"
                      : usernameAvailable === false
                        ? "username taken"
                        : ""}
                </p>
              )}
            </div>

            {renderPasswordInput("reg-password", "password", regPassword, setRegPassword)}
            {renderPasswordInput("reg-confirm", "confirm password", regConfirm, setRegConfirm)}

            {serverInviteOnly && (
              <div className="space-y-1.5">
                <Label htmlFor="invite-code" className={labelClass} style={labelStyle}>
                  invite code
                </Label>
                <Input
                  id="invite-code"
                  placeholder=">"
                  value={inviteCode}
                  onChange={(e) => {
                    setInviteCode(e.target.value);
                    if (error) setError(null);
                  }}
                  disabled={loading}
                  className="rounded-none border-[1px] bg-transparent h-10 text-sm tracking-[0.15em] font-mono"
                  style={inputStyle}
                />
                <p className="text-[10px] tracking-[0.08em]" style={{ color: "rgba(180, 210, 255, 0.4)" }}>
                  this server requires an invite code to register
                </p>
              </div>
            )}

            {renderError()}
            {renderButton("register")}

            <div className="flex justify-center pt-1">
              {renderLink("back to login", () => {
                setStep("login");
                setError(null);
                setNicknameError(null);
                setNicknameWarning(null);
                setUsernameAvailable(null);
              })}
            </div>
          </form>
        );

      case "totp-setup":
        return (
          <form onSubmit={handleTotpVerify} className="space-y-5">
            <div className="text-center space-y-3">
              <p className="text-[11px] tracking-wide" style={{ color: "rgba(200, 220, 255, 0.7)" }}>
                Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
              </p>

              {totpQrBase64 && (
                <div className="flex justify-center">
                  <div className="p-3 bg-white rounded-sm">
                    <img
                      src={`data:image/png;base64,${totpQrBase64}`}
                      alt="TOTP QR Code"
                      className="w-40 h-40"
                      style={{ imageRendering: "pixelated" }}
                    />
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-[0.15em]" style={{ color: "rgba(180, 210, 255, 0.35)" }}>
                  or enter this key manually
                </p>
                <div
                  className="px-3 py-2 border-[1px] text-xs font-mono tracking-[0.15em] select-all cursor-text break-all"
                  style={{
                    borderColor: "rgba(180, 210, 255, 0.12)",
                    color: "rgba(220, 230, 255, 0.75)",
                    background: "rgba(180, 210, 255, 0.03)",
                  }}
                >
                  {totpSecret}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="totp-verify" className={labelClass} style={labelStyle}>
                verification code
              </Label>
              <Input
                id="totp-verify"
                placeholder="000000"
                value={totpVerifyCode}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setTotpVerifyCode(v);
                  if (error) setError(null);
                }}
                maxLength={6}
                autoFocus
                disabled={loading}
                className="rounded-none border-[1px] bg-transparent h-10 text-sm tracking-[0.3em] text-center font-mono"
                style={inputStyle}
              />
            </div>

            {renderError()}
            {renderButton("verify & connect")}
          </form>
        );

      case "recovery-codes":
        return (
          <div className="space-y-5">
            <div className="text-center space-y-3">
              <p className="text-[11px] tracking-wide" style={{ color: "rgba(200, 220, 255, 0.7)" }}>
                Save these recovery codes in a safe place. Each code can only be used once to sign in if you lose access to your authenticator app.
              </p>
            </div>

            <div
              className="grid grid-cols-1 gap-1.5 p-3 border-[1px]"
              style={{
                borderColor: "rgba(180, 210, 255, 0.12)",
                background: "rgba(180, 210, 255, 0.03)",
              }}
            >
              {recoveryCodes.map((code, i) => (
                <div
                  key={i}
                  className="text-center text-sm font-mono tracking-[0.3em] py-1"
                  style={{ color: "rgba(220, 230, 255, 0.85)" }}
                >
                  {code}
                </div>
              ))}
            </div>

            <Button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(recoveryCodes.join("\n"));
              }}
              className="w-full rounded-none h-8 text-[10px] uppercase tracking-[0.2em] font-normal border-[1px]"
              variant="outline"
              style={{
                borderColor: "rgba(180, 210, 255, 0.15)",
                color: "rgba(180, 210, 255, 0.6)",
                background: "rgba(180, 210, 255, 0.03)",
              }}
            >
              copy all codes
            </Button>

            <Button
              type="button"
              onClick={() => {
                const token = getAccessToken();
                if (token && registeredUserId) {
                  dispatch({
                    type: "LOGIN",
                    payload: { accessToken: token, userId: registeredUserId },
                  });
                  dispatch({ type: "SET_TOTP_VERIFIED", payload: true });
                }
              }}
              className="w-full rounded-none h-10 text-xs uppercase tracking-[0.2em] font-normal border-[1px]"
              variant="outline"
              style={{
                borderColor: "rgba(120, 230, 160, 0.25)",
                color: "rgba(120, 230, 160, 0.85)",
                background: "rgba(120, 230, 160, 0.04)",
              }}
            >
              I've saved my codes - continue
            </Button>
          </div>
        );
    }
  };

  const subtitle = () => {
    if (loading) return "authenticating...";
    switch (step) {
      case "login": return needsTotp ? (useRecoveryCode ? "enter recovery code" : "enter authenticator code") : "what will you chat about?";
      case "register": return "create your account";
      case "totp-setup": return "set up two-factor auth";
      case "recovery-codes": return "save your recovery codes";
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center p-4">
      <HalftoneBackground />

      {/* Help icon */}
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
              A lightweight self-hosted chat app. Create an account, set up
              two-factor authentication, and start chatting. Voice, text,
              reactions -- all in real time.
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
          transition: "border-color 0.4s ease, box-shadow 0.4s ease, transform 0.3s ease",
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
            {subtitle()}
          </CardDescription>
          <div
            className="mt-4 h-px w-full"
            style={{ background: "rgba(180, 210, 255, 0.1)" }}
          />
        </CardHeader>

        <CardContent className="px-6 pt-5 pb-6">
          {renderStepContent()}
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
