/** UI-13: the questions agents are waiting on, across every linked project. */
import type { Note } from "@konsora/core";
import { useQuery } from "@tanstack/react-query";
import type { BoardTask } from "./board.ts";
import { useApi } from "./projects.ts";

export const questionsKey = ["questions"] as const;

export type PendingQuestion = { task: BoardTask; question: Note };
export type QuestionGroup = { project: { id: string; name: string }; questions: PendingQuestion[] };
export type PendingQuestions = { projects: QuestionGroup[]; total: number };

/** How often the count is refreshed when no project event says so sooner. */
const POLL_MS = 15_000;

export function useQuestions() {
  const api = useApi();
  return useQuery({
    queryKey: questionsKey,
    queryFn: () => api.get<PendingQuestions>("/questions"),
    refetchInterval: POLL_MS,
  });
}
