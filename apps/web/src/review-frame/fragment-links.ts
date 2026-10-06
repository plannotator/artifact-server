/**
 * Run inside the artifact's srcdoc sandbox. Its injected content-domain base
 * is needed for resources, but fragment-only links belong to this document.
 * Listen after element/document handlers so authored and annotation gestures
 * that cancel a click keep ownership of it.
 *
 * This function is serialized into an inline script and must be self-contained.
 */
export function installFragmentLinks(): void {
  window.addEventListener("click", (event: MouseEvent): void => {
    if (
      event.defaultPrevented || event.button !== 0 || event.altKey
      || event.ctrlKey || event.metaKey || event.shiftKey
    ) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    const link = element.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return;
    const target = link.getAttribute("target")
      ?? document.querySelector("base[target]")?.getAttribute("target")
      ?? "";
    if (target !== "" && target.toLowerCase() !== "_self") return;
    const href = link.getAttribute("href")?.trim();
    if (href === undefined || !href.startsWith("#")) return;

    // Missing and malformed targets must not navigate to the base URL either.
    event.preventDefault();
    let fragment = href.slice(1);
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      // An authored literal ID can contain an invalid percent escape.
    }
    if (fragment === "") {
      window.scrollTo(0, 0);
      return;
    }
    const destination = document.getElementById(fragment)
      ?? Array.from(document.getElementsByName(fragment)).find(
        (candidate) => candidate instanceof HTMLAnchorElement,
      );
    if (destination !== undefined && destination !== null) {
      destination.scrollIntoView();
      if (destination instanceof HTMLElement) destination.focus({preventScroll: true});
    } else if (fragment.toLowerCase() === "top") {
      window.scrollTo(0, 0);
    }
  });
}
