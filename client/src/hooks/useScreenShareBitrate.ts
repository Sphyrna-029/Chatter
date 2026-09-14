import { useCallback, useEffect, useState } from "react";
import {
  SCREEN_BITRATE_CHANGE_EVENT,
  clampScreenShareBitrate,
  defaultScreenShareBitrate,
  loadScreenShareBitrate,
  storeScreenShareBitrate,
} from "@/lib/webrtc";
import { useScreenShareFps } from "./useScreenShareFps";

/**
 * Shared access to the screen share bitrate ceiling.
 *
 * The same arrangement as {@link useScreenShareFps} and for the same reason:
 * the control appears on more than one surface and the publisher has to react
 * to it too, so the value lives in localStorage and changes are announced on a
 * window event rather than threaded through props.
 *
 * Depends on the frame rate only for the value to show before anyone has
 * chosen one — see `loadScreenShareBitrate`.
 */
export function useScreenShareBitrate() {
  const { screenFps } = useScreenShareFps();
  const [screenBitrate, setScreenBitrateState] = useState(() =>
    loadScreenShareBitrate(screenFps),
  );

  useEffect(() => {
    const handler = () => setScreenBitrateState(loadScreenShareBitrate(screenFps));
    window.addEventListener(SCREEN_BITRATE_CHANGE_EVENT, handler);
    // The frame rate moves the *unset* default, so a change to it has to be
    // read back too. Once a value is stored this is a no-op.
    handler();
    return () => window.removeEventListener(SCREEN_BITRATE_CHANGE_EVENT, handler);
  }, [screenFps]);

  const setScreenBitrate = useCallback(
    (bps: number) => {
      storeScreenShareBitrate(
        clampScreenShareBitrate(bps, defaultScreenShareBitrate(screenFps)),
      );
      window.dispatchEvent(new CustomEvent(SCREEN_BITRATE_CHANGE_EVENT));
    },
    [screenFps],
  );

  return { screenBitrate, setScreenBitrate };
}
