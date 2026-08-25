# Cloudflare coordinated recovery

The checked-in recovery command restores one quiesced Artifact Server
installation from an exact D1 database and R2 bucket into an exact empty D1
database and R2 bucket. It does not make a point-in-time or zero-downtime
recovery promise.

The command fails before export when the configured source writer Worker still
exists, either target name or ID does not resolve exactly, a helper or restored
Worker name is already used, or the restore D1/R2 targets are not empty. Keep
all other writers offline too. The command inspects the source again after the
backup and rejects any change to D1 rows or R2 bodies and metadata.

## Prepare exact targets

Create one empty restore D1 database and one empty restore R2 bucket. Record
their exact names and the D1 UUID. Stop and delete the Worker that can write to
the source pair. Do not reuse a Worker name that might still receive traffic.

Create a JSON configuration outside the repository:

```json
{
  "schemaVersion": 1,
  "cloudflareAccountId": "0123456789abcdef0123456789abcdef",
  "installationId": "installation-id-from-the-source",
  "qualification": false,
  "recoveryWorkerName": "artifact-server-recovery-helper",
  "source": {
    "databaseName": "artifact-server-source-records",
    "databaseId": "11111111-1111-4111-8111-111111111111",
    "bucketName": "artifact-server-source-objects",
    "writerWorkerName": "artifact-server-source-worker"
  },
  "restore": {
    "databaseName": "artifact-server-restore-records",
    "databaseId": "22222222-2222-4222-8222-222222222222",
    "bucketName": "artifact-server-restore-objects",
    "workerName": "artifact-server-restored-worker"
  }
}
```

Use an authenticated Wrangler session or set a Cloudflare API token in the
environment. It needs exact-account access to read, export, import, and delete
Workers; read D1; and read/write R2. The command does not print or retain the
token.

```sh
export CLOUDFLARE_API_TOKEN='<redacted>'
```

Run from the repository root:

```sh
pnpm qualify:cloudflare:recovery -- \
  --config /absolute/path/to/recovery.json \
  --confirm-account 0123456789abcdef0123456789abcdef \
  --confirm-source-database artifact-server-source-records \
  --confirm-source-bucket artifact-server-source-objects \
  --confirm-restore-database artifact-server-restore-records \
  --confirm-restore-bucket artifact-server-restore-objects \
  --confirm-source-writes-quiesced artifact-server-source-worker \
  --evidence /absolute/path/to/redacted-recovery-evidence.json
```

The command performs this sequence:

1. Resolve every D1, R2, and Worker target read-only and require empty restore
   targets plus an absent source writer.
2. Deploy a short-lived, bearer-protected recovery Worker and run the normal
   product integrity scan against the source D1/R2 pair.
3. Export D1 with Wrangler's provider-supported remote export.
4. Copy every R2 body plus HTTP and custom metadata through native R2 bindings,
   then reopen and hash both sides.
5. Import the D1 export into the empty restore database.
6. Reinspect the source to prove it remained quiesced.
7. Run the same integrity and exact-state oracle against only the restored
   targets and compare identifier, D1-row, R2-body, and metadata hashes.
8. Deploy the current Artifact Server Worker against only the restored D1/R2
   pair and require `/health` and `/ready` to return `200`.
9. Delete the recovery helper and write sanitized evidence.

Each helper deployment announces its active binding mode. The command waits for
that exact mode before it reads or copies data. This prevents a newly deployed
helper from reaching the previous revision's D1 or R2 bindings while the Worker
update is still propagating.

Provider command output is represented by hashes because D1 export output can
contain a signed download URL. Evidence never includes credentials, signed
URLs, object keys, file bodies, or raw provider output. Temporary export and
secret files use mode 0600 permissions and are removed at exit.

## Qualification-only cleanup

Automated durable-resource deletion is available only when every configured
resource and installation name starts with `artifact-server-qual-`, the config
sets `qualification` to `true`, and the operator supplies both flags:

```sh
--cleanup-qualification-resources \
--confirm-qualification-cleanup artifact-server-qual-installation-id
```

That mode deletes only the two exact Workers, empties only the two exact R2
buckets, deletes those buckets, and deletes D1 by its two exact UUIDs. It never
uses wildcards and never accesses the account-level Alchemy state Worker. A
failed recovery removes Workers it created but retains D1/R2 for diagnosis.

If any target is nonempty, corrupt, outside the expected installation prefix,
or changes during recovery, do not copy around the failed gate. Correct the
target selection or repeat with a fresh empty pair.

The live qualification result is
`../../project/evidence/cloudflare-coordinated-recovery.json`.
