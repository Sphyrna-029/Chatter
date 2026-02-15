import { useState, useEffect, useRef } from "react";
import { useAppContext } from "@/lib/store";
import { AppSidebar } from "./AppSidebar";
import { ChatArea } from "./ChatArea";
import { MembersPanel } from "./MembersPanel";
import { VoiceControls } from "./VoiceControls";
import { ScreenShareViewer, ScreenShareHeader } from "./ScreenShareViewer";
import { CreateRoomDialog, JoinRoomDialog } from "./RoomDialogs";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";

export function ChatLayout() {
  const { state, loadRooms } = useAppContext();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const viewerContainerRef = useRef<HTMLDivElement>(null);

  // Load rooms on mount
  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const showViewer =
    state.screenViewerOpen &&
    state.inVoiceChannel &&
    state.activeScreenSharers.some((id) => id !== state.userId);

  return (
    <>
      <SidebarProvider>
        <div className="flex h-screen w-full">
          <AppSidebar
            onCreateRoom={() => setCreateOpen(true)}
            onJoinRoom={() => setJoinOpen(true)}
          />

          <SidebarInset className="flex flex-1 flex-col min-w-0">
            {/* Voice controls at top of main area */}
            <VoiceControls />

            {/* Main content: chat + members */}
            <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
              {showViewer ? (
                <div ref={viewerContainerRef} className="flex-1 flex flex-col min-h-0">
                  {/* Header lives outside the resizable panels — always visible */}
                  <ScreenShareHeader containerRef={viewerContainerRef} />

                  <ResizablePanelGroup
                    orientation="vertical"
                    className="flex-1"
                  >
                    <ResizablePanel defaultSize={50} minSize={15}>
                      <div className="h-full flex flex-col min-h-0">
                        <ScreenShareViewer />
                      </div>
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize={50} minSize={15}>
                      <div className="h-full flex flex-col min-h-0">
                        <ChatArea />
                      </div>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              ) : (
                <ChatArea />
              )}
              <MembersPanel />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
      <JoinRoomDialog open={joinOpen} onOpenChange={setJoinOpen} />
      <Toaster />
    </>
  );
}
