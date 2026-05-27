// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

interface ProjectChipProps {
  projectName: string;
  popoverId: string;
  disabled?: boolean;
}

export function ProjectChip({ projectName, popoverId, disabled }: ProjectChipProps) {
  return (
    <button
      type="button"
      className="chat-model-chip"
      popoverTarget={popoverId}
      disabled={disabled}
      aria-label={`Project: ${projectName}. Change project.`}
      title="Change project"
    >
      <span className="chat-model-chip-provider">Project</span>
      <span className="chat-model-chip-sep" aria-hidden="true">
        ·
      </span>
      <span className="chat-model-chip-name">{projectName}</span>
      <span className="chat-model-chip-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}
