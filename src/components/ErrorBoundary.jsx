import { Component } from 'react';

/**
 * Generic React error boundary.
 *
 * Catches render-time errors in its subtree and displays a
 * recovery UI instead of crashing the entire app.
 *
 * Props:
 *   - fallback: (optional) custom fallback element
 *   - name:     (optional) label for the console error log
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    const label = this.props.name || 'ErrorBoundary';
    console.error(`[${label}] Caught render error:`, error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-red-400 text-sm font-medium">Something went wrong</div>
          <div className="text-gray-500 text-xs max-w-md">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </div>
          <button
            onClick={this.handleRetry}
            className="mt-2 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 border border-gray-700 transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
