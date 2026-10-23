import { z } from "zod";

export const STATES = ["idle", "writing", "researching", "executing", "syncing", "waiting", "error", "offline"] as const;
export type State = (typeof STATES)[number];

/** States that fall back to idle when no report arrives within the TTL. */
export const WORKING_STATES: ReadonlySet<State> = new Set(["writing", "researching", "executing", "syncing", "waiting", "error"]);

export const occupantIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "id must be lowercase letters, digits, - or _ (max 40)");

export const statusBodySchema = z.object({
  state: z.enum(STATES),
  detail: z.string().max(2000).optional(),
  name: z.string().trim().min(1).max(40).optional(),
  kind: z.enum(["agent", "human"]).optional(),
});

export type StatusBody = z.infer<typeof statusBodySchema>;

export interface Occupant {
  id: string;
  name: string;
  kind: "agent" | "human";
  state: State;
  detail: string;
  updatedAt: string;
  /** The model this occupant is assigned, if any (never the provider or its key). */
  model: string | null;
  /** The job title from its soul (e.g. "Researcher"), if any. */
  role: string | null;
}

export interface OfficeEvent {
  id: number;
  occupantId: string;
  state: State;
  detail: string;
  at: string;
}
