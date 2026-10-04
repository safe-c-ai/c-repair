import type { ModelMode } from '../bridge/overrideEnv';

export interface OnboardingState {
  connectionConfigured: boolean;
  apiModelSelected: boolean;
  bridgePrepared: boolean;
}

/** Completion follows saved credentials / a ready runtime, never an opened wizard. */
export function onboardingState(mode: ModelMode, hasApiKey: boolean, apiModelSelected: boolean, bridgeReady: boolean): OnboardingState {
  return {
    connectionConfigured: mode === 'local' ? bridgeReady : hasApiKey,
    apiModelSelected: mode !== 'local' && apiModelSelected,
    bridgePrepared: bridgeReady,
  };
}
