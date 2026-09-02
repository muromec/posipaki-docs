# Actor processes for JavaScript

> A tiny, typed runtime for building concurrent systems out of long-lived processes — no callbacks, no event soup. Everything typed.

## Why posipaki

- **Processes, not callbacks.** Every actor is a self-contained process with its own state and mailbox.
- **Fork children.** Spawn sub-actors that report back up, with lifecycle hooks and clean shutdown.
- **Pause, resume, exit.** Your actor lives and dies on its own terms.
- **Portable.** The core runs anywhere JavaScript does — browser, service workers, Node, Bun. Subprocess-only features sit behind a separate import.
- **Distributed.** Spawn children in a different process, a worker, or another runtime over WebSocket.
- **One function.** The whole API is `defineActor`.

## Install

```sh
npm install posipaki
```

## Start building

Read the [quick start](/guide/) and spin up your first actor in under a minute.
