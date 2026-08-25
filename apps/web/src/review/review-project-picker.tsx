import {
  Add01Icon,
  ArrowDown01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {type FormEvent, useMemo, useState} from "react";

import {type Project} from "@/api/client";
import {Alert, AlertDescription} from "@/components/ui/alert";
import {Button} from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {Separator} from "@/components/ui/separator";

interface ReviewProjectPickerProps {
  readonly canCreate: boolean;
  readonly onCreate: (name: string) => Promise<Project>;
  readonly onSelect: (projectId: string) => void;
  readonly projects: readonly Project[];
  readonly selectedProjectId: string;
}

/** Switch project context and provide the review application's project-creation entry point. */
export function ReviewProjectPicker({
  canCreate,
  onCreate,
  onSelect,
  projects,
  selectedProjectId,
}: ReviewProjectPickerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerScreen, setPickerScreen] = useState<"create" | "projects">("projects");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
    ?? null;
  const orderedProjects = useMemo(
    () => [...projects].toSorted((left, right) => {
      if (left.archivedAt === null && right.archivedAt !== null) return -1;
      if (left.archivedAt !== null && right.archivedAt === null) return 1;
      return left.name.localeCompare(right.name);
    }),
    [projects],
  );

  const chooseProject = (projectId: string): void => {
    setPickerOpen(false);
    onSelect(projectId);
  };
  const showCreateForm = (): void => {
    setError(null);
    setPickerScreen("create");
  };
  const changePickerOpen = (open: boolean): void => {
    if (!open && !creating) {
      setName("");
      setError(null);
      setPickerScreen("projects");
    }
    setPickerOpen(open);
  };
  const createProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName === "" || creating) return;
    setCreating(true);
    setError(null);
    try {
      const project = await onCreate(trimmedName);
      setPickerOpen(false);
      setPickerScreen("projects");
      setName("");
      onSelect(project.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project creation failed."));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Popover onOpenChange={changePickerOpen} open={pickerOpen}>
      <PopoverTrigger
        aria-label={`Current project: ${selectedProject?.name ?? "none"}`}
        className="as-project-trigger"
      >
        <span>{selectedProject?.name ?? "Select project"}</span>
        <HugeiconsIcon aria-hidden="true" icon={ArrowDown01Icon} strokeWidth={2} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="as-project-popover"
        data-screen={pickerScreen}
        sideOffset={7}
      >
        {pickerScreen === "projects"
          ? (
            <>
              <PopoverTitle className="sr-only">Projects</PopoverTitle>
              <div aria-label="Projects" className="as-project-list" role="listbox">
                {orderedProjects.map((project) => {
                  const selected = project.id === selectedProjectId;
                  return (
                    <button
                      aria-selected={selected}
                      className="as-project-option"
                      key={project.id}
                      onClick={() => chooseProject(project.id)}
                      role="option"
                      type="button"
                    >
                      <span className="as-project-option__identity">
                        <span>{project.name}</span>
                        {project.archivedAt === null
                          ? null
                          : <span className="as-project-option__status">Archived</span>}
                      </span>
                      {selected
                        ? <HugeiconsIcon aria-hidden="true" icon={Tick02Icon} strokeWidth={2} />
                        : null}
                    </button>
                  );
                })}
              </div>
              {canCreate
                ? (
                  <>
                    <Separator />
                    <Button onClick={showCreateForm} size="sm" type="button" variant="ghost">
                      <HugeiconsIcon data-icon="inline-start" icon={Add01Icon} strokeWidth={2} />
                      New project
                    </Button>
                  </>
                )
                : null}
            </>
          )
          : (
            <form className="flex flex-col gap-4" onSubmit={(event) => void createProject(event)}>
              <PopoverTitle className="as-visually-hidden">Create project</PopoverTitle>
              {error === null
                ? null
                : (
                  <Alert variant="destructive">
                    <AlertDescription>{error.message}</AlertDescription>
                  </Alert>
                )}
              <FieldGroup>
                <Field data-invalid={error !== null}>
                  <FieldLabel
                    className="as-visually-hidden"
                    htmlFor="review-new-project-name"
                  >
                    Project name
                  </FieldLabel>
                  <Input
                    aria-invalid={error !== null}
                    autoFocus
                    autoComplete="off"
                    id="review-new-project-name"
                    maxLength={120}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="Project name"
                    value={name}
                  />
                  <FieldError>
                    {name.length > 120 ? "Use 120 characters or fewer." : null}
                  </FieldError>
                </Field>
              </FieldGroup>
              <div className="flex justify-end gap-2">
                <Button
                  disabled={creating}
                  onClick={() => {
                    setError(null);
                    setName("");
                    setPickerScreen("projects");
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Back
                </Button>
                <Button disabled={creating || name.trim() === ""} size="sm" type="submit">
                  {creating ? "Creating…" : "Create project"}
                </Button>
              </div>
            </form>
          )}
      </PopoverContent>
    </Popover>
  );
}
