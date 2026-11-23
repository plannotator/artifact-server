import {PageHeader} from "@/components/product";
import {settingsText} from "@/i18n/messages/settings";
import {WebmcpSettingsCard} from "./webmcp.tsx";

/** Configure browser-provided Review tools independently from external MCP clients. */
export function WebmcpScreen() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        description={settingsText.webmcp.description}
        eyebrow={settingsText.webmcp.eyebrow}
        title="WebMCP"
      />

      <section className="grid max-w-3xl gap-5 border p-5 sm:p-6" aria-labelledby="webmcp-review-tools">
        <header className="grid gap-1">
          <h2 className="font-heading text-lg font-semibold text-balance" id="webmcp-review-tools">
            {settingsText.webmcp.toolsHeading}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground text-pretty">
            {settingsText.webmcp.toolsDescription}
          </p>
        </header>
        <WebmcpSettingsCard />
      </section>
    </div>
  );
}
