'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { LABEL, MONO } from './ui';

type State = { error: Error | null; attempt: number };

/**
 * Contains map failures (no WebGL, MapLibre init errors, a crash while rendering the scene) so
 * the queue and detail panel keep working. "Retry" remounts the map.
 */
export class MapErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[dispatch] map failed; queue and detail panel unaffected', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0b0b0c] px-6 text-center">
          <div className={LABEL}>Map unavailable</div>
          <p className={`${MONO} max-w-[420px] text-[12px] text-neutral-400`}>{this.state.error.message}</p>
          <p className="text-[12px] text-neutral-500">The queue and incident details still work.</p>
          <button
            type="button"
            onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}
            className="mt-1 rounded-[2px] border border-neutral-700 bg-neutral-900 px-3 py-1 text-[12px] text-neutral-100 hover:bg-neutral-800"
          >
            Retry
          </button>
        </div>
      );
    }
    // A new key after Retry gives the map a fresh mount.
    return <div key={this.state.attempt} className="contents">{this.props.children}</div>;
  }
}
