import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { useScreenShareFps } from "@/hooks/useScreenShareFps";
import { useScreenShareBitrate } from "@/hooks/useScreenShareBitrate";
import { useScreenContentMode } from "@/hooks/useScreenContentMode";
import {
  SCREEN_BITRATE_MAX_BPS,
  SCREEN_BITRATE_MIN_BPS,
  SCREEN_BITRATE_STEP_BPS,
  formatScreenBitrate,
  type ScreenContentMode,
} from "@/lib/webrtc";

interface ScreenFpsMenuProps {
  /** Rendered as the trigger. Should look at home in its surrounding toolbar. */
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}

/**
 * Quality controls for screen sharing: frame rate, and the bitrate ceiling.
 *
 * Both read and write the shared preferences directly, so every surface that
 * renders one stays in step and a change lands on an in-progress share straight
 * away.
 */
export function ScreenFpsMenu({ children, align = "end" }: ScreenFpsMenuProps) {
  const { screenFps, setScreenFps } = useScreenShareFps();
  const { screenBitrate, setScreenBitrate } = useScreenShareBitrate();
  const { screenContent, setScreenContent } = useScreenContentMode();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-60">
        <DropdownMenuLabel>Screen share quality</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(screenFps)}
          onValueChange={(v) => setScreenFps(Number(v) as 30 | 60)}
        >
          <DropdownMenuRadioItem value="30">30 FPS</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="60">60 FPS</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        {/* What the encoder gives up when it cannot have both. Sharing an
            editor and sharing a film want opposite answers, and there is no
            way to tell which from the capture itself. */}
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Optimise for
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={screenContent}
          onValueChange={(v) => setScreenContent(v as ScreenContentMode)}
        >
          <DropdownMenuRadioItem value="detail">Text &amp; detail</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="motion">Video &amp; motion</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        {/* Not a menu item: a slider inside one would be dragged by the
            keyboard navigation and dismissed by the pointer handling. */}
        <div
          className="px-2 py-1.5"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-xs font-medium">Bitrate</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatScreenBitrate(screenBitrate)}
            </span>
          </div>
          <Slider
            value={[screenBitrate]}
            min={SCREEN_BITRATE_MIN_BPS}
            max={SCREEN_BITRATE_MAX_BPS}
            step={SCREEN_BITRATE_STEP_BPS}
            onValueChange={([bps]) => setScreenBitrate(bps)}
            aria-label="Screen share bitrate"
          />
          <p className="mt-2 text-3xs leading-snug text-muted-foreground">
            A ceiling, not a target — the encoder uses what the picture needs.
            Lower it if your upload cannot keep up.
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
