# Actor processes for JavaScript

> A tiny, typed runtime for building concurrent systems out of long-lived processes — no callbacks, no event soup. Everything typed.

## Why posipaki

- **Processes as a building block.** Every actor is a self-contained process with its own state and mailbox.
- **One function.** The whole API is `defineActor`. Describe received and emitted messages contract and public state with typescript.
- **Hierarchy.** Spawn sub-actors that report back up, with lifecycle hooks and clean shutdown.
- **Pause, resume, exit.** Actors have lifecycle of their own, can be suspended or stopped. Exits become events for their parent.
- **Portable.** The core runs anywhere JavaScript does — browser, service workers, Node, Bun.
- **Distributed.** Spawn children in a different process on node, a worker in a browser, or bridge both with WebSocket. See companion packages to auto-propagate over ssh and into podman containers, bwrap or different sudo context.
- **Objects, bytes and streams.** Send typed objects, process referecnes, typed arrays, blobs or byte streams over to remote process.

## Install

```sh
npm install posipaki
```

## Start building

Read the [quick start](/guide/) and spin up your first actor in under a minute.
