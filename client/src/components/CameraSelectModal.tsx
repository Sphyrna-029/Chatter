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
  onStart: (deviceId: string) => void;
}

export function CameraSelectModal({ open, onClose, onStart }: CameraSelectModalProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [permissionError, setPermissionError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

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
      })
      .catch(() => {
        setPreviewStream(null);
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
    onStart(selectedDeviceId);
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
