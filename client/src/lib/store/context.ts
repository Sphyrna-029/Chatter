import { createContext, useContext, useMemo } from "react";
import type { AppContextValue, AppState } from "./types";

/** Actions never change identity, so components that only dispatch (toolbars,
 *  dialogs, menus) can subscribe to this alone and skip every state render. */
export type AppActions = Omit<AppContextValue, "state">;

export const AppActionsContext = createContext<AppActions | null>(null);
export const AppStateContext = createContext<AppState | null>(null);

/** Actions only — stable across every state change. */
export function useAppActions(): AppActions {
  const ctx = useContext(AppActionsContext);
  if (!ctx) throw new Error("useAppActions must be within AppProvider");
  return ctx;
}

/** State only — re-renders the caller whenever any slice of state changes. */
export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be within AppProvider");
  return ctx;
}

export function useAppContext(): AppContextValue {
  const actions = useAppActions();
  const state = useAppState();
  return useMemo(() => ({ ...actions, state }), [actions, state]);
}
