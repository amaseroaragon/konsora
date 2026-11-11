import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "../src/i18n/index.ts";
import {
  Button,
  Field,
  Matrix,
  Menu,
  StateBadge,
  Tabs,
  TaskCard,
  taskStates,
} from "../src/ui/index.ts";

const html = (node: React.ReactNode) => renderToStaticMarkup(node);

describe("i18n", () => {
  it("fills placeholders and keeps unknown ones visible", () => {
    expect(t("card.blockedBy", { ids: "CORE-01" })).toBe("Bloqueada por CORE-01");
    expect(t("card.blockedBy")).toBe("Bloqueada por {ids}");
  });
});

describe("Button", () => {
  it("defaults to type=button and maps variants to classes", () => {
    const out = html(<Button variant="primary">Go</Button>);
    expect(out).toContain('type="button"');
    expect(out).toContain("k-btn k-btn--primary");
  });

  it("busy disables the button and announces loading", () => {
    const out = html(<Button busy>Go</Button>);
    expect(out).toContain("disabled");
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(t("action.loading"));
  });
});

describe("StateBadge", () => {
  it.each(taskStates)("renders a Spanish label for %s", (state) => {
    const out = html(<StateBadge kind={state} />);
    expect(out).toContain(`k-badge--${state}`);
    expect(out).toMatch(/>[A-ZÁÉÍÓÚa-záéíóú ]+<\/span>$/);
  });
});

describe("TaskCard", () => {
  it("is labelled by its title and offers a selection checkbox when ready", () => {
    const out = html(
      <TaskCard id="DMN-02" state="todo" title="Ops endpoint" onSelectedChange={() => {}} />,
    );
    expect(out).toContain('aria-labelledby="task-DMN-02-title"');
    expect(out).toContain('id="task-DMN-02-title"');
    expect(out).toContain(`aria-label="${t("card.select", { id: "DMN-02" })}"`);
    expect(out).not.toMatch(/type="checkbox"[^>]*disabled/);
    expect(out).toContain(t("state.ready"));
  });

  it("blocked tasks show their blockers and cannot be selected", () => {
    const out = html(
      <TaskCard
        id="CORE-02"
        state="todo"
        title="Validation"
        blockedBy={["CORE-01"]}
        onSelectedChange={() => {}}
      />,
    );
    expect(out).toContain("k-card--blocked");
    expect(out).toContain("Bloqueada por CORE-01");
    expect(out).toMatch(/type="checkbox"[^>]*disabled/);
  });

  it("marks review and proposed cards", () => {
    expect(html(<TaskCard id="A-02" state="review" title="x" />)).toContain("k-card--review");
    expect(html(<TaskCard id="A-03" state="proposed" title="x" proposedBy="claude" />)).toContain(
      "Propuesta por claude",
    );
  });
});

describe("Field", () => {
  it("links label, hint and error to the control", () => {
    const out = html(<Field label="Título" hint="Pista" error="Error" />);
    const id = /<input[^>]* id="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`for="${id}"`);
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain(`aria-describedby="${id}-hint ${id}-error"`);
  });

  it("renders a textarea when multiline", () => {
    expect(html(<Field label="Nota" multiline />)).toContain("<textarea");
  });
});

describe("Menu", () => {
  it("closed menu button exposes its popup semantics", () => {
    const out = html(
      <Menu
        caption="Agente"
        value="b"
        onChange={() => {}}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    expect(out).toContain('aria-haspopup="menu"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("B ▾");
  });
});

describe("Tabs", () => {
  it("only the selected tab is in the tab order and its panel is labelled by it", () => {
    const out = html(
      <Tabs
        label="Secciones"
        selected="run"
        onSelect={() => {}}
        tabs={[
          { id: "detail", label: "Detalle", content: "D" },
          { id: "run", label: "Ejecución", content: "R" },
        ]}
      />,
    );
    expect(out.match(/tabindex="0"/g)?.length).toBe(2); // selected tab + panel
    expect(out).toMatch(/aria-selected="true"[^>]*>Ejecución/);
    expect(out).toContain(">R</div>");
  });
});

describe("Matrix", () => {
  it("renders one header per state and an accessible cell per lane × state", () => {
    const out = html(
      <Matrix
        label="Tablero"
        columns={taskStates.map((state) => ({ state, count: 0 }))}
        lanes={[{ id: "CORE", name: "Núcleo", cells: [] }]}
      />,
    );
    expect(out.match(/k-matrix__cell/g)?.length).toBe(taskStates.length);
    expect(out).toContain('aria-label="Núcleo · En revisión"');
  });
});
