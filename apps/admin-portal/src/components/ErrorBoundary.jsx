import { Component } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Catches render errors and failed lazy-page loads so the user never sees a blank screen.
 * `resetKey` clears the error when it changes (e.g. the route), so navigating away from a
 * broken page works without a full reload. A failed lazy import stays failed until the
 * page is reloaded, hence the Reload action.
 */
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled UI error:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto my-16 flex max-w-md flex-col items-center rounded-xl border border-red-200 bg-red-50 px-6 py-12 text-center">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-red-100 text-red-700">
          <TriangleAlert className="h-5 w-5" />
        </div>
        <h1 className="text-base font-semibold text-red-950">Something went wrong</h1>
        <p className="mt-1 text-sm text-red-900">This page couldn&apos;t be displayed. Reloading usually fixes it.</p>
        <Button className="mt-5" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    );
  }
}
