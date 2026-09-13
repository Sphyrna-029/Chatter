import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorPane } from "@/components/ErrorPane";

/**
 * Catches a render error so it costs one pane rather than the whole app.
 *
 * Nothing in this client used to catch one. React unmounts the root when a
 * render throws with no boundary above it, which left the page showing the
 * body background and nothing else — the "app goes grey" that came of changing
 * channels, because changing channels is when a code-split view is fetched and
 * first rendered.
 *
 * A class because this is the one thing hooks cannot do: `getDerivedStateFromError`
 * has no hook equivalent.
 */

interface Props {
  children: ReactNode;
  /**
   * Change this to clear a caught error — the channel being viewed, say. A
   * boundary that stayed broken after navigating away from whatever broke it
   * would strand the reader on the error it had already shown them.
   */
  resetKey?: string;
  /** Replaces the default pane, for a boundary that is not a whole view. */
  fallback?: (state: { error: Error; reset: () => void }) => ReactNode;
  /** Named in the console, so one of several boundaries can be told apart. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The only record there is. Without it a caught error is quieter than the
    // crash it replaced, which would be a poor trade.
    console.error(
      `[${this.props.label ?? "ErrorBoundary"}] ${error.message}`,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback({ error, reset: this.reset });
    return <ErrorPane error={error} reset={this.reset} />;
  }
}
