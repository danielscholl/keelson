// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Stable per-rib accent hue derived from the rib id, so a rib's badge is the
// same color everywhere (catalog card, runs row, filter chip) without the rib
// having to declare one. 45% lightness reads on both light and dark surfaces.
export function ribAccentHue(ribId: string): number {
  let h = 0;
  for (let i = 0; i < ribId.length; i++) {
    h = (h * 31 + ribId.charCodeAt(i)) % 360;
  }
  return h;
}

export interface RibAccent {
  color: string;
  bg: string;
  border: string;
}

export function ribAccent(ribId: string): RibAccent {
  const h = ribAccentHue(ribId);
  return {
    color: `hsl(${h} 60% 45%)`,
    bg: `hsl(${h} 60% 45% / 0.12)`,
    border: `hsl(${h} 60% 45% / 0.35)`,
  };
}
