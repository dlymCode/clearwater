/** Round to 2 decimals (0.01 ft: removes float noise without inventing precision). The one home for this. */
export const round2 = (x: number): number => Math.round(x * 100) / 100;
