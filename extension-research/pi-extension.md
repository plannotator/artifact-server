This was a discussion from an engineering consultant who knows how Pi and OpenCode extensions work.We're discussing how to communicate in words to agents, where basically you can gain a bidirectional experience. This doesn't always really exist with agents, but there's methods, especially for agents that support extensions.

Yes. If your third-party backend runs locally on the user’s machine, it can be the sidecar. “Sidecar” just means the local companion process beside the agent; it does not have to be a separate product or daemon.

```text
Your web UI
    ↕
Your existing local backend = sidecar responsibilities
    ↕
Pi extension / OpenCode plugin
    ↕
Native agent session
```

Your backend would own:

- Browser API and live event stream
- Session registry
- Normalized transcript/event journal
- Command routing
- Authentication between adapters and backend
- Delivery status
- Adapter discovery

If your backend is hosted remotely, it is not itself the sidecar. You would need a small local connector:

```text
Web UI ↔ Hosted backend ↔ Local sidecar ↔ Adapter ↔ Agent
```

But for the local-only prototype, your existing local backend should simply absorb the sidecar functionality. There is no reason to run two backend processes.

## Pi sequence

```mermaid
sequenceDiagram
    actor NativeUser as User in Pi
    actor WebUser as User in Web UI
    participant UI as Third-party Web UI
    participant Backend as Third-party Local Backend (Sidecar)
    participant Extension as Pi Extension
    participant Pi as Native Pi Session

    Note over Pi,Extension: One-time extension installation

    NativeUser->>Pi: Launch Pi normally
    Pi->>Extension: Load installed extension
    Extension->>Backend: Connect with local credential
    Pi->>Extension: session_start
    Extension->>Pi: Read session ID, cwd, history
    Extension->>Backend: Register session and capabilities
    Backend->>UI: Session appears

    NativeUser->>Pi: Send message natively
    Pi-->>Extension: message and turn events
    Extension-->>Backend: Normalized live events
    Backend-->>UI: Update transcript and status

    WebUser->>UI: Send message
    UI->>Backend: POST session command
    Backend->>Extension: message(text, mode)

    alt Pi is idle
        Extension->>Pi: sendUserMessage(text, followUp)
    else Pi is working
        Extension->>Pi: sendUserMessage(text, steer)
    end

    Extension-->>Backend: Delivery accepted
    Backend-->>UI: Show delivered

    Pi-->>Extension: Assistant and tool events
    Extension-->>Backend: Normalized streaming events
    Backend-->>UI: Render activity and reply

    Note over Extension,Pi: If Backend disappears, Pi continues normally
```

The Pi extension is directly inside the active Pi harness. MCP is not involved.

The important native operation is:

```ts
pi.sendUserMessage(text, {
  deliverAs: mode === "steer" ? "steer" : "followUp",
});
```

## OpenCode sequence

```mermaid
sequenceDiagram
    actor NativeUser as User in OpenCode
    actor WebUser as User in Web UI
    participant UI as Third-party Web UI
    participant Backend as Third-party Local Backend (Sidecar)
    participant Plugin as OpenCode Global Plugin
    participant OC as Native OpenCode Session

    Note over OC,Plugin: One-time global plugin installation

    NativeUser->>OC: Launch OpenCode normally
    OC->>Plugin: Load global plugin
    Plugin->>Backend: Connect with local credential
    Plugin->>OC: List active sessions and history
    Plugin->>Backend: Register sessions and capabilities
    Backend->>UI: Sessions appear

    NativeUser->>OC: Send message natively
    OC-->>Plugin: Structured session/message events
    Plugin-->>Backend: Normalized events
    Backend-->>UI: Update transcript and status

    WebUser->>UI: Send message
    UI->>Backend: POST session command
    Backend->>Plugin: message(text, follow_up)
    Plugin->>OC: session.promptAsync(text)
    Plugin-->>Backend: Delivery accepted
    Backend-->>UI: Show delivered

    OC-->>Plugin: Message deltas and session status
    Plugin-->>Backend: Normalized live events
    Backend-->>UI: Render activity and response

    opt Web user interrupts
        WebUser->>UI: Interrupt
        UI->>Backend: Interrupt command
        Backend->>Plugin: interrupt(session)
        Plugin->>OC: session.abort()
        OC-->>Plugin: Session idle/interrupted
        Plugin-->>Backend: Status update
        Backend-->>UI: Show interrupted
    end

    Note over Plugin,OC: Backend failure never blocks OpenCode
```

Again, no MCP is involved. The plugin directly calls OpenCode’s session API and receives its structured event hook.

One subtle difference: Pi currently has an explicit native distinction between `steer` and `followUp`. The OpenCode prototype uses `promptAsync` for message submission and `abort` for interruption; we should not represent it as confirmed Pi-style mid-turn steering until that behavior is proven.

So the practical architecture is:

```text
                          ┌─ Pi extension ────── Pi
Web UI ↔ Your backend ↔───┤
                          └─ OpenCode plugin ─── OpenCode
```

Both adapters speak the same bridge protocol to your backend. Only the last few feet—from adapter to native harness—are different.