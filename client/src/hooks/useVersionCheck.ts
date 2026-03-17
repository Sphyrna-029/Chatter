import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 60_000;

export function useVersionCheck() {
  const initialVersionRef = useRef<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    async function fetchVersion(): Promise<string | null> {
      try {
        const res = await fetch("/api/version");
        if (!res.ok) return null;
        const data = await res.json();
        return data.version ?? null;
      } catch {
        return null;
      }
    }

    async function check() {
      const version = await fetchVersion();
      if (!version) {
        timer = setTimeout(check, POLL_INTERVAL_MS);
        return;
      }

      if (initialVersionRef.current === null) {
        initialVersionRef.current = version;
      } else if (version !== initialVersionRef.current) {
        window.location.reload();
        return;
      }

      timer = setTimeout(check, POLL_INTERVAL_MS);
    }

    check();
    return () => clearTimeout(timer);
  }, []);
}
