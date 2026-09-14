import { useCallback, useEffect, useState } from "react";
import {
  SCREEN_CONTENT_CHANGE_EVENT,
  loadScreenContentMode,
  storeScreenContentMode,
  type ScreenContentMode,
} from "@/lib/webrtc";

/**
 * Shared access to what the sharer says they are sharing.
 *
 * The same arrangement as the frame rate and bitrate preferences beside it:
 * localStorage with a window event, so every surface rendering the control and
 * the publisher itself stay in step without prop drilling.
 */
export function useScreenContentMode() {
  const [screenContent, setScreenContentState] =
    useState<ScreenContentMode>(loadScreenContentMode);

  useEffect(() => {
    const handler = () => setScreenContentState(loadScreenContentMode());
    window.addEventListener(SCREEN_CONTENT_CHANGE_EVENT, handler);
    return () => window.removeEventListener(SCREEN_CONTENT_CHANGE_EVENT, handler);
  }, []);

  const setScreenContent = useCallback((mode: ScreenContentMode) => {
    storeScreenContentMode(mode);
    window.dispatchEvent(new CustomEvent(SCREEN_CONTENT_CHANGE_EVENT));
  }, []);

  return { screenContent, setScreenContent };
}
