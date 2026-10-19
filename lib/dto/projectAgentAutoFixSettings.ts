// The project's AGENT AUTO-FIX switch (Story MOTIR-8981 · MOTIR-9060) — what the
// Hosted agent settings room reads and what the flip returns.

export interface ProjectAgentAutoFixSettingsDto {
  /** The STORED value of `Project.agentAutoFixEnabled`, never a computed default. */
  agentAutoFixEnabled: boolean;
}

/** The PATCH body: an absent key means unchanged. */
export interface UpdateProjectAgentAutoFixSettingsInput {
  agentAutoFixEnabled?: boolean;
}
