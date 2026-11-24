/** Install the scroll-only relay inside the opaque sandbox, before author scripts. */
export function withComparisonScroll(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const bridge = parsed.createElement("script");
  bridge.textContent = `
    (() => {
      const hostOrigin = ${JSON.stringify(window.location.origin)};
      let appliedScroll = null;
      let scheduled = false;
      function range() {
        return Math.max(0, document.scrollingElement.scrollHeight - innerHeight);
      }
      addEventListener("message", (event) => {
        const {data} = event;
        if (event.source !== parent || event.origin !== hostOrigin
            || data?.type !== "as-comparison-scroll-to" || !Number.isFinite(data.progress)
            || data.progress < 0 || data.progress > 1) return;
        scrollTo({top: range() * data.progress, behavior: "instant"});
        appliedScroll = scrollY;
      });
      addEventListener("scroll", () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          if (scrollY === appliedScroll) return;
          appliedScroll = null;
          const maximum = range();
          if (maximum === 0) return;
          const progress = Math.max(0, Math.min(1, scrollY / maximum));
          parent.postMessage({type: "as-comparison-scrolled", progress}, hostOrigin);
        });
      }, {passive: true});
    })();
  `;
  parsed.head.prepend(bridge);
  const doctype = /<!doctype\b[^>]*>/iu.exec(html)?.[0] ?? "";
  return `${doctype}${parsed.documentElement.outerHTML}`;
}
