# Command-line interface

Agents normally publish through the [Artifact Server Skill](../skills/artifact-server/SKILL.md) or [MCP](./mcp.md). Use the CLI when you want to publish directly or run operator commands from a terminal.

The release archive includes `artifactserver/bin/artifactserver`. Keep the extracted `artifactserver` directory in a stable location, then link the launcher into a directory on your `PATH`:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/artifactserver/bin/artifactserver" "$HOME/.local/bin/artifactserver"
export PATH="$HOME/.local/bin:$PATH"
```

Add the `PATH` line to your shell profile if needed. From a source checkout, replace `artifactserver` with `pnpm artifactserver`.

## Publish an artifact

Publish one finished file or a complete directory:

```sh
artifactserver publish ./report.pdf
artifactserver publish ./dist --public --name "Product prototype" --tag prototype
```

Publication returns JSON with three browser links:

| Link | Purpose |
| --- | --- |
| `links.review` | Opens the exact version full screen with comments. Share this link first. |
| `links.artifact` | Opens the stable link that follows the current version. |
| `links.version` | Opens the immutable raw version without the Artifact Server interface. |

## Use a remote server

Sign in once, save a named profile, and use it when publishing:

```sh
artifactserver auth login https://artifacts.example.com --name team
artifactserver publish ./dist --profile team
```

## Publish another version

Provide the artifact ID and expected current version:

```sh
artifactserver publish ./dist \
  --artifact art_example \
  --expected-version ver_example
```

The expected version prevents an old client from replacing a newer current pointer.

Run `artifactserver --help` or `artifactserver <command> --help` for the complete command reference.
