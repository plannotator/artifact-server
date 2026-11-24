export type ReviewTheme = "dawn" | "moon";

export function readReviewTheme(): ReviewTheme {
  try {
    return window.localStorage.getItem("artifact-review-theme") === "dawn" ? "dawn" : "moon";
  } catch {
    return "moon";
  }
}
