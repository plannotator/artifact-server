import {describe, expect, test} from "vitest";

import {
  attachmentContentDisposition,
  portableDownloadFilename,
} from "../../src/http/content-disposition.js";

describe("download filenames", () => {
  test("unsafe header characters cannot escape the attachment filename", () => {
    const disposition = attachmentContentDisposition(
      "Quarterly\r\nreport: café?.zip ",
    );

    expect(disposition).toBe(
      "attachment; filename=\"Quarterly--report- caf--.zip\"; "
        + "filename*=UTF-8''Quarterly--report-%20caf%C3%A9-.zip",
    );
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
  });

  test("an unusable filename gets a stable portable fallback", () => {
    expect(portableDownloadFilename("  ...  ")).toBe("artifact");
  });
});
