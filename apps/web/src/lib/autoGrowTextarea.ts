// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// CHAT_INPUT_MAX_HEIGHT is mirrored by `.chat-input { max-height }` in app.css —
// change both together.
export const CHAT_INPUT_MIN_HEIGHT = 44;
export const CHAT_INPUT_MAX_HEIGHT = 320;

export function clampTextareaHeight(
  contentHeight: number,
  min = CHAT_INPUT_MIN_HEIGHT,
  max = CHAT_INPUT_MAX_HEIGHT,
): number {
  return Math.min(max, Math.max(min, contentHeight));
}

export function resizeTextareaToContent(
  el: HTMLTextAreaElement,
  min = CHAT_INPUT_MIN_HEIGHT,
  max = CHAT_INPUT_MAX_HEIGHT,
): void {
  el.style.height = "auto";
  el.style.height = `${clampTextareaHeight(el.scrollHeight, min, max)}px`;
}
