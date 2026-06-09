import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { agentSocket } from "../lib/agentSocket.js";
import { api, selfUpdateApi } from "../lib/api.js";
import "../styles/error-boundary.css";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  isSpawningAgent: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      isSpawningAgent: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleRefresh = (): void => {
    window.location.reload();
  };

  handleSpawnAgent = async (): Promise<void> => {
    this.setState({ isSpawningAgent: true });

    try {
      // Get buildover's app root path
      const info = await selfUpdateApi.getInfo();
      const buildoverPath = info.appRoot;

      // Create a new chat in buildover's repo with full permissions
      const chat = await api.createChat(buildoverPath, "claude-sonnet-4-5", "bypassPermissions");

      // Build the error details for the agent
      const errorMessage = this.state.error?.message ?? "Unknown error";
      const errorStack = this.state.error?.stack ?? "No stack trace available";
      const componentStack = this.state.errorInfo?.componentStack ?? "No component stack available";

      const prompt = `Buildover has crashed with a compilation or runtime error. Please investigate and fix the issue.

## Error Details

**Error Message:**
\`\`\`
${errorMessage}
\`\`\`

**Stack Trace:**
\`\`\`
${errorStack}
\`\`\`

**Component Stack:**
\`\`\`
${componentStack}
\`\`\`

## Instructions

1. Analyze the error to understand what went wrong
2. Search for the relevant files in the codebase
3. Fix the issue (could be a syntax error, type error, missing import, etc.)
4. Verify the fix compiles correctly

The error likely occurred because an agent was modifying Buildover itself. Common issues include:
- TypeScript compilation errors
- Missing imports or circular dependencies
- React component errors
- Invalid JSX syntax
- Type mismatches`;

      // Subscribe to the chat
      agentSocket.send({
        type: "subscribe",
        chatId: chat.id,
        repoPath: buildoverPath,
        withReplay: true,
      });

      // Send the error report after a brief delay to ensure subscription is active
      setTimeout(() => {
        agentSocket.send({
          type: "user_message",
          chatId: chat.id,
          repoPath: buildoverPath,
          text: prompt,
          model: "claude-sonnet-4-5",
          permissionMode: "bypassPermissions",
        });
      }, 400);

      // Show success feedback briefly before refresh
      setTimeout(() => {
        alert("Agent spawned successfully! The page will refresh to show the agent's work.");
        this.handleRefresh();
      }, 1000);
    } catch (err) {
      console.error("Failed to spawn agent:", err);
      alert(`Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`);
      this.setState({ isSpawningAgent: false });
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const errorMessage = this.state.error?.message ?? "Unknown error";
      const errorStack = this.state.error?.stack ?? "";

      return (
        <div className="error-boundary">
          <div className="error-boundary-content">
            <img
              src="/icon.png"
              alt="Buildover"
              className="error-boundary-logo"
            />
            <h1 className="error-boundary-title">
              <span className="error-boundary-brand-dot" />
              buildover crashed
            </h1>
            <p className="error-boundary-subtitle">
              Something went wrong during compilation or runtime
            </p>

            <div className="error-boundary-error">
              <div className="error-boundary-error-header">Error Details</div>
              <div className="error-boundary-error-message">{errorMessage}</div>
              {errorStack && (
                <details className="error-boundary-error-stack">
                  <summary>Stack trace</summary>
                  <pre>{errorStack}</pre>
                </details>
              )}
            </div>

            <div className="error-boundary-actions">
              <button
                className="error-boundary-button error-boundary-button--primary"
                onClick={this.handleSpawnAgent}
                disabled={this.state.isSpawningAgent}
              >
                {this.state.isSpawningAgent ? (
                  <>
                    <span className="error-boundary-spinner" />
                    Spawning agent...
                  </>
                ) : (
                  "Spawn agent to fix"
                )}
              </button>
              <button
                className="error-boundary-button error-boundary-button--secondary"
                onClick={this.handleRefresh}
                disabled={this.state.isSpawningAgent}
              >
                Refresh page
              </button>
            </div>

            <p className="error-boundary-hint">
              This usually happens when an agent modifies Buildover itself.
              <br />
              Try spawning an agent to automatically fix the issue, or refresh to
              see if it resolves.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
