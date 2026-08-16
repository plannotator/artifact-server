import { Button } from "@/components/ui/button";

const foundations = [
  ["Exact revisions", "Every batch is pinned to one immutable Git commit."],
  ["Isolated execution", "Every QA assignment receives its own disposable sandbox."],
  ["Reviewable evidence", "Findings remain connected to screenshots, traces, and logs."],
] as const;

/** Renders the initial QAMiner control-plane shell. */
export const App = () => (
  <div className="min-h-svh bg-background text-foreground">
    <header className="mx-auto flex max-w-6xl items-center justify-between border-b px-5 py-5 sm:px-8">
      <a className="font-heading text-base font-semibold tracking-tight" href="/">
        QAMiner
      </a>
      <Button disabled size="sm" type="button">
        New batch
      </Button>
    </header>

    <main className="mx-auto flex max-w-6xl flex-col gap-20 px-5 py-24 sm:px-8 sm:py-32">
      <section className="flex max-w-4xl flex-col gap-6">
        <p className="font-mono text-xs font-semibold tracking-widest text-primary uppercase">
          Distributed application QA
        </p>
        <h1 className="font-heading text-5xl leading-none font-semibold tracking-tight text-balance sm:text-7xl">
          Give every QA assignment its own capable agent.
        </h1>
        <p className="max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
          Run full-stack applications, exercise them in a real browser, and keep the evidence humans
          need to trust the result.
        </p>
      </section>

      <ul className="grid border sm:grid-cols-3" aria-label="QAMiner foundations">
        {foundations.map(([title, description]) => (
          <li
            className="flex flex-col gap-3 border-b p-6 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"
            key={title}
          >
            <h2 className="font-heading text-sm font-semibold">{title}</h2>
            <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          </li>
        ))}
      </ul>
    </main>
  </div>
);
