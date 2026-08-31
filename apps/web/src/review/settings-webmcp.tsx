import {PageHeader} from "@/components/product";
import {WebmcpSettingsCard} from "./webmcp.tsx";

/** Configure browser-provided Review tools independently from external MCP clients. */
export function WebmcpScreen() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        description="Let an AI agent running in this browser operate Review through browser-provided tools. This is separate from connecting external coding agents through MCP."
        eyebrow="Browser tools"
        title="WebMCP"
      />

      <section className="grid max-w-3xl gap-5 border p-5 sm:p-6" aria-labelledby="webmcp-review-tools">
        <header className="grid gap-1">
          <h2 className="font-heading text-lg font-semibold text-balance" id="webmcp-review-tools">
            Review tools
          </h2>
          <p className="text-sm leading-6 text-muted-foreground text-pretty">
            This preference applies to this browser profile. It does not change MCP connections
            in Codex, Claude Code, Cursor, VS Code, or other clients.
          </p>
        </header>
        <WebmcpSettingsCard />
      </section>
    </div>
  );
}
