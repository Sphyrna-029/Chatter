import { useCallback, useEffect, useState } from "react";
import {
  SCREEN_FPS_CHANGE_EVENT,
  loadScreenShareFps,
  storeScreenShareFps,
} from "@/lib/webrtc";

/**
 * Shared access to the screen share frame rate preference.
 *
 * The control appears on several surfaces at once (the voice panel, the share
 * viewer, the voice toolbar) and the publisher has to react to it too, so the
 * value lives in localStorage and changes are announced on a window event
 * rather than threaded through props.
 */
export function useScreenShareFps() {
  const [screenFps, setScreenFpsState] = useState<30 | 60>(loadScreenShareFps);

  useEffect(() => {
    const handler = () => setScreenFpsState(loadScreenShareFps());
    window.addEventListener(SCREEN_FPS_CHANGE_EVENT, handler);
    return () => window.removeEventListener(SCREEN_FPS_CHANGE_EVENT, handler);
  }, []);

  const setScreenFps = useCallback((fps: 30 | 60) => {
    storeScreenShareFps(fps);
    window.dispatchEvent(new CustomEvent(SCREEN_FPS_CHANGE_EVENT));
  }, []);

  return { screenFps, setScreenFps };
}
