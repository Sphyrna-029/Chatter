import { useCallback, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { desktop, type DesktopAppSettings, type DesktopSettings } from "@/lib/desktop/bridge";

type Program = { exe: string; name: string };

/**
 * The desktop app's own settings — startup, games, updates, which server it
 * connects to — as a tab of the settings dialog, the way Discord keeps its
 * app settings among the rest. Drawn only inside the app.
 */
export function DesktopSettingsTab({ api }: { api: DesktopSettings }) {
  const [settings, setSettings] = useState<DesktopAppSettings | null>(null);
  const [running, setRunning] = useState<Program[]>([]);

  const loadRunning = useCallback(() => void api.runningApps().then(setRunning).catch(() => {}), [api]);

  useEffect(() => {
    void api.get().then(setSettings).catch((err) => console.error("Could not load desktop settings:", err));
    loadRunning();
  }, [api, loadRunning]);

  const save = (update: Partial<DesktopAppSettings>) =>
    void api.set(update).then(setSettings).catch((err) => console.error("Could not save desktop settings:", err));

  if (!settings) return null;

  const toggle = (key: "startWithSystem" | "startMinimized" | "shareGameActivity" | "autoUpdate", label: string, hint: string, disabled = false) => (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={settings[key]} disabled={disabled} onCheckedChange={(v) => save({ [key]: v })} />
    </div>
  );

  const addable = running.filter((p) => !settings.extraGames.some((g) => g.exe === p.exe));

  return (
    <>
      {toggle("startWithSystem", "Open on Startup", "Start Chatter when you sign in to your computer")}
      {toggle("startMinimized", "Start Minimized", "Opened at sign-in, stay in the tray", !settings.startWithSystem)}

      {toggle("shareGameActivity", "Show Game Activity", "Show the game you're playing next to your name")}

      <div className="space-y-2">
        <Label>Added Games</Label>
        <p className="text-xs text-muted-foreground">
          Programs that count as games, beyond the ones Chatter recognises.
        </p>
        {settings.extraGames.length > 0 && (
          <ul className="space-y-1">
            {settings.extraGames.map((game) => (
              <li key={game.exe} className="flex items-center justify-between gap-2 rounded-md border border-input px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate" title={game.exe}>{game.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => save({ extraGames: settings.extraGames.filter((g) => g.exe !== game.exe) })}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <select
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value=""
            onChange={(e) => {
              const program = addable.find((p) => p.exe === e.target.value);
              if (program) save({ extraGames: [...settings.extraGames, program] });
            }}
          >
            <option value="">Add a running program…</option>
            {addable.map((p) => (
              <option key={p.exe} value={p.exe}>
                {p.name}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" className="h-auto" onClick={loadRunning}>
            Refresh
          </Button>
        </div>
      </div>

      {toggle("autoUpdate", "Automatic Updates", "Download and install new versions of the app")}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label>Version</Label>
          <p className="text-xs text-muted-foreground">Chatter Desktop {desktop?.appVersion}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => api.checkForUpdates()}>
          Check for Updates
        </Button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label>Server</Label>
          <p className="truncate text-xs text-muted-foreground">{window.location.host}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => api.changeServer()}>
          Change Server
        </Button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label>Logs</Label>
          <p className="text-xs text-muted-foreground">For bug reports</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => api.openLogs()}>
          Open Logs Folder
        </Button>
      </div>
    </>
  );
}
