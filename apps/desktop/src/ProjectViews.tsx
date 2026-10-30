import { useState } from "react";
import Conversations from "./Conversations";
import Debates from "./Debates";

export default function ProjectViews({ projectId }: { projectId: string }) {
  const [view, setView] = useState<"chats" | "debates">("chats");
  return (
    <>
      <nav className="project-views" aria-label="Secciones del proyecto">
        <button aria-pressed={view === "chats"} onClick={() => setView("chats")}>Conversaciones</button>
        <button aria-pressed={view === "debates"} onClick={() => setView("debates")}>Debate</button>
      </nav>
      {view === "chats" ? <Conversations projectId={projectId} /> : <Debates projectId={projectId} />}
    </>
  );
}
