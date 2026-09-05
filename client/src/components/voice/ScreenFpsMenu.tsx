import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { useScreenShareFps } from "@/hooks/useScreenShareFps";

interface ScreenFpsMenuProps {
  /** Rendered as the trigger. Should look at home in its surrounding toolbar. */
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}

/**
 * Frame rate picker for screen sharing. Reads and writes the shared preference
 * directly, so every surface that renders one stays in step and a change lands
 * on an in-progress share straight away.
 */
export function ScreenFpsMenu({ children, align = "end" }: ScreenFpsMenuProps) {
  const { screenFps, setScreenFps } = useScreenShareFps();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuLabel>Screen share quality</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(screenFps)}
          onValueChange={(v) => setScreenFps(Number(v) as 30 | 60)}
        >
          <DropdownMenuRadioItem value="30">30 FPS</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="60">60 FPS</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
