import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface CameraSelectModalProps {
  open: boolean;
  onClose: () => void;
  onStart: (deviceId: string, fps: 30 | 60) => void;
}

const FPS_OPTIONS: Array<30 | 60> = [30, 60];

export function CameraSelectModal({ open, onClose, onStart }: CameraSelectModalProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [fps, setFps] = useState<30 | 60>(30);
  // null while unknown — browsers that do not report track capabilities get
  // both options rather than a silently missing one.
  const [maxDeviceFps, setMaxDeviceFps] = useState<number | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [permissionError, setPermissionError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Cameras often report 59.94 (NTSC) rather than a flat 60, so allow a
  // little slack instead of hiding the option from them.
  const supports60 = maxDeviceFps === null || maxDeviceFps >= 59;

  // When modal opens, request permission then enumerate devices
  useEffect(() => {
    if (!open) {
      stopPreview();
      return;
    }
    setPermissionError(false);
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        // Permission granted — enumerate to get labels
        return navigator.mediaDevices.enumerateDevices().then((all) => {
          const cams = all.filter((d) => d.kind === "videoinput");
          setDevices(cams);
          const defaultId = cams[0]?.deviceId || "";
          setSelectedDeviceId(defaultId);
          // Stop the initial permission stream; we'll start a preview with the selected device
          stream.getTracks().forEach((t) => t.stop());
        });
      })
      .catch(() => {
        setPermissionError(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Start/restart preview when selected device changes
  useEffect(() => {
    if (!open || !selectedDeviceId) return;
    stopPreview();

    const constraints: MediaStreamConstraints = {
      video: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
    };
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        setPreviewStream(stream);
        const track = stream.getVideoTracks()[0];
        const max = track?.getCapabilities?.().frameRate?.max;
        setMaxDeviceFps(typeof max === "number" ? max : null);
      })
      .catch(() => {
        setPreviewStream(null);
        setMaxDeviceFps(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId, open]);

  // Attach stream to video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = previewStream;
      if (previewStream) videoRef.current.play().catch(() => {});
    }
  }, [previewStream]);

  function stopPreview() {
    setPreviewStream((prev) => {
      if (prev) prev.getTracks().forEach((t) => t.stop());
      return null;
    });
  }

  function handleStart() {
    stopPreview();
    onStart(selectedDeviceId, supports60 ? fps : 30);
    onClose();
  }

  function handleClose() {
    stopPreview();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Select Camera</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {permissionError ? (
            <p className="text-sm text-destructive">
              Camera access was denied. Please allow camera access in your browser settings.
            </p>
          ) : (
            <>
              {devices.length > 1 && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-muted-foreground">Camera device</label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                  >
                    {devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${d.deviceId.slice(0, 8)}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">Frame rate</label>
                <div className="flex gap-2">
                  {FPS_OPTIONS.map((option) => {
                    const disabled = option === 60 && !supports60;
                    return (
                      <Button
                        key={option}
                        type="button"
                        size="sm"
                        variant={fps === option && !disabled ? "default" : "outline"}
                        disabled={disabled}
                        onClick={() => setFps(option)}
                        className="flex-1 text-xs"
                      >
                        {option} FPS
                      </Button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {supports60
                    ? "60 FPS is smoother but uses more bandwidth."
                    : "This camera only reports support for 30 FPS."}
                </p>
              </div>

              <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
                {previewStream ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
                    {selectedDeviceId ? "Loading preview..." : "No camera found"}
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleStart}
              disabled={permissionError || !selectedDeviceId}
            >
              Start Camera
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
