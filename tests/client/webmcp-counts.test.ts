/**
 * The counts a WebMCP mutation echoes are derived purely from the view's
 * threads with the fresh thread substituted — they must be post-mutation
 * even when React has not yet committed the reloaded list (WMC-001).
 */

import {describe, expect, test} from "vitest";

import {echoCounts} from "../../apps/web/src/review/webmcp-counts.js";

describe("WebMCP mutation echo counts", () => {
  test("resolving the last open thread counts it resolved before the view commits", () => {
    expect.hasAssertions();
    const staleView = [
      {id: "cmt_a", state: "resolved" as const},
      {id: "cmt_b", state: "open" as const},
    ];
    expect(echoCounts(staleView, {id: "cmt_b", state: "resolved"}))
      .toEqual({open: 0, resolved: 2});
    expect(echoCounts(staleView, {id: "cmt_a", state: "open"}))
      .toEqual({open: 2, resolved: 0});
  });

  test("a thread the view has not loaded yet is counted from the fresh record", () => {
    expect.hasAssertions();
    const staleView = [{id: "cmt_a", state: "open" as const}];
    expect(echoCounts(staleView, {id: "cmt_new", state: "open"}))
      .toEqual({open: 2, resolved: 0});
    expect(echoCounts([], {id: "cmt_new", state: "resolved"}))
      .toEqual({open: 0, resolved: 1});
  });

  test("an unchanged thread leaves the counts as the view has them", () => {
    expect.hasAssertions();
    const view = [
      {id: "cmt_a", state: "open" as const},
      {id: "cmt_b", state: "resolved" as const},
    ];
    expect(echoCounts(view, {id: "cmt_a", state: "open"}))
      .toEqual({open: 1, resolved: 1});
  });
});
