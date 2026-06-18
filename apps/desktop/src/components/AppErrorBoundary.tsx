import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { log } from "../infrastructure/logger";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log("error", "ui_unhandled_error", {
      name: error.name,
      message: error.message,
      componentStack: info.componentStack ?? "",
    });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="fatal-error">
        <AlertTriangle size={30} />
        <h1>Auto Gen Studio hit an unexpected error</h1>
        <p>Your project data has not been deleted. Reload the interface to continue.</p>
        <button className="primary" onClick={() => window.location.reload()}>
          <RotateCcw size={17} /> Reload interface
        </button>
        <details>
          <summary>Technical details</summary>
          <pre>{this.state.error.message}</pre>
        </details>
      </main>
    );
  }
}
