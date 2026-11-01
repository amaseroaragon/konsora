/**
 * Permission approvals of runs (MCP-04, UI-11): what the agents ask to do outside their default
 * profile, and the human's decision. `permission.*` over the WebSocket refetches the list.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Api } from "./client.ts";
import { useApi } from "./projects.ts";

export type Approval = {
  id: string;
  run: string;
  project: string;
  task: string;
  tool: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  requested_at: string;
  state: "pending" | "allowed" | "denied" | "expired";
};

export type Decision = { run: string; id: string; decision: "allow" | "deny"; message?: string };

export const approvalsKey = ["approvals"] as const;

/** Every pending approval, of every project (the daemon keeps them in memory). */
export function useApprovals() {
  const api = useApi();
  return useQuery({
    queryKey: approvalsKey,
    queryFn: async () => (await api.get<{ approvals: Approval[] }>("/approvals")).approvals,
  });
}

/** `POST /runs/:run/permissions/:id` with `{decision, message?}`. */
export async function decideRequest(api: Api, input: Decision): Promise<void> {
  const message = input.message?.trim();
  await api.post(
    `/runs/${encodeURIComponent(input.run)}/permissions/${encodeURIComponent(input.id)}`,
    { decision: input.decision, ...(message ? { message } : {}) },
  );
}

export function withoutApproval(list: readonly Approval[] | undefined, id: string): Approval[] {
  return (list ?? []).filter((approval) => approval.id !== id);
}

/** Sends the decision; the approval leaves the list as soon as the daemon took it. */
export function useDecide() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Decision) => decideRequest(api, input),
    onSuccess: (_result, input) =>
      client.setQueryData<Approval[]>(approvalsKey, (list) => withoutApproval(list, input.id)),
    onSettled: () => client.invalidateQueries({ queryKey: approvalsKey }),
  });
}
