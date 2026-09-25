export const RESOLUTION_POLICIES = ['verified_recovery', 'provider_clear'] as const;
export type ResolutionPolicy = (typeof RESOLUTION_POLICIES)[number];
export type ResolutionBasis = 'verified_recovery' | 'provider_clear' | 'operator';
export type SignalClearProvenance = 'provider' | 'operator' | 'suppression' | 'unknown';
