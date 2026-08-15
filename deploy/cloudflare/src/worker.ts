interface WorkerEnvironment {
  readonly ARTIFACT_SERVER_ORIGIN: string;
}

const unavailableResponse = () =>
  new Response(
    JSON.stringify({
      error: "artifact_server_runtime_not_installed",
      message:
        "This checkpoint provisions infrastructure only. It does not run the Artifact Server product.",
    }),
    {
      status: 503,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );

export default {
  fetch(
    _request: Request,
    _environment: WorkerEnvironment,
    _context: ExecutionContext,
  ): Response {
    return unavailableResponse();
  },
};
