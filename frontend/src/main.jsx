import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { Buffer } from "buffer";

if (!window.Buffer) {
  window.Buffer = Buffer;
}
if (!window.global) {
  window.global = window;
}
if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}
if (!window.process) {
  window.process = { env: {} };
}
if (!globalThis.process) {
  globalThis.process = { env: {} };
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui", color: "#e6eef6", background: "#0b0f14", minHeight: "100vh" }}>
          <h2>Frontend Error</h2>
          <p>Something crashed during render. The error message is below:</p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#111827", padding: 12, borderRadius: 8 }}>
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <p>Open DevTools → Console for the full stack trace.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function GlobalErrorListener({ onError }) {
  React.useEffect(() => {
    const handler = (event) => {
      const err = event?.error || event?.reason || event?.message || "Unknown error";
      onError(err);
    };
    window.addEventListener("error", handler);
    window.addEventListener("unhandledrejection", handler);
    return () => {
      window.removeEventListener("error", handler);
      window.removeEventListener("unhandledrejection", handler);
    };
  }, [onError]);
  return null;
}

function Root() {
  const [fatal, setFatal] = React.useState(null);
  if (fatal) {
    return (
      <div style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui", color: "#e6eef6", background: "#0b0f14", minHeight: "100vh" }}>
        <h2>Frontend Error</h2>
        <pre style={{ whiteSpace: "pre-wrap", background: "#111827", padding: 12, borderRadius: 8 }}>
          {fatal?.message || String(fatal)}
        </pre>
        <p>Open DevTools → Console for the full stack trace.</p>
      </div>
    );
  }
  return (
    <React.StrictMode>
      <GlobalErrorListener onError={setFatal} />
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
