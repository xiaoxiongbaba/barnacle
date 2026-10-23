// From Habblaud's client/src/world/layout/types.ts: only the type props.ts needs.
export interface ExteriorProp {
  kind: 'tree' | 'pine' | 'bush' | 'flowers' | 'lamp' | 'bench' | 'rock' | 'hedge' | 'parasol' | 'totem' | 'paving';
  /** World px: bottom centre (the base). */
  x: number;
  y: number;
  seed: number;
  slot?: number;
  whenRoom?: number;
}
