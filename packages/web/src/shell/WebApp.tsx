import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, createApi } from "../api/client.ts";
import { ApiContext } from "../api/projects.ts";
import { LimitsLink, LimitsPage } from "./LimitsPage.tsx";
import { ProjectPage } from "./ProjectPage.tsx";
import { ProjectsPage } from "./ProjectsPage.tsx";
import { QueueLink, QueuePage } from "./QueuePage.tsx";
import type { Route } from "./route.ts";
import { NoSession, Shell } from "./Shell.tsx";

/** The real app over the daemon. Without a token, or once the daemon rejects it, it asks for `konsora ui`. */
export function WebApp({ token, route }: { token: string | null; route: Route }) {
  const [expired, setExpired] = useState(false);
  const [setup] = useState(() => {
    const onError = (error: unknown) => {
      if (error instanceof ApiError && error.unauthorized) setExpired(true);
    };
    return {
      api: token ? createApi(token) : null,
      queries: new QueryClient({
        queryCache: new QueryCache({ onError }),
        mutationCache: new MutationCache({ onError }),
        defaultOptions: {
          queries: {
            retry: (count, error) => !(error instanceof ApiError && error.status > 0) && count < 2,
          },
        },
      }),
    };
  });
  if (!setup.api || expired) return <NoSession expired={expired} />;
  return (
    <ApiContext.Provider value={setup.api}>
      <QueryClientProvider client={setup.queries}>
        <Shell
          home={route.name === "projects"}
          nav={
            <>
              <QueueLink current={route.name === "queue"} />
              <LimitsLink current={route.name === "limits"} />
            </>
          }
        >
          {route.name === "project" ? (
            <ProjectPage key={route.id} id={route.id} view={route.view} task={route.task} />
          ) : route.name === "limits" ? (
            <LimitsPage />
          ) : route.name === "queue" ? (
            <QueuePage />
          ) : (
            <ProjectsPage />
          )}
        </Shell>
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}
