import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, color: '#f87171', fontFamily: 'monospace', background: '#0a0e1a', minHeight: '100vh' }}>
          <h2 style={{ color: '#f87171', marginBottom: 16 }}>Dashboard Error</h2>
          <p style={{ color: '#94a3b8', marginBottom: 8 }}>Something went wrong. Error details:</p>
          <pre style={{ background: '#111827', border: '1px solid #334155', borderRadius: 8, padding: 16, fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#fca5a5' }}>
            {String(this.state.error)}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => { localStorage.clear(); window.location.reload(); }}
            style={{ marginTop: 16, padding: '8px 20px', borderRadius: 8, border: '1px solid #f8717144', background: '#f8717111', color: '#f87171', fontSize: 13, cursor: 'pointer' }}
          >
            Clear Data &amp; Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
