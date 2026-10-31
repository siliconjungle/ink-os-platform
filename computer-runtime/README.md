# Optional browser service

This service runs Chromium sessions for the platform's computer API. Ordinary desktop, app, command and workflow operation does not require it. It is separate from the web client's reader app and from model execution workers.

Build from the platform repository root:

```sh
docker build -f computer-runtime/Dockerfile -t ink-os-computer .
docker run --rm --env INK_OS_COMPUTER_TOKEN --publish 127.0.0.1:8081:8080 ink-os-computer
```

Set `INK_OS_COMPUTER_TOKEN` to a generated private token before running the service. Configure the platform host with that same token and `INK_OS_COMPUTER_URL`, using the service's reachable origin. For a host running directly on the same machine, the example's URL is `http://127.0.0.1:8081`; a containerized host needs a shared private container network and the service's network name instead. Keep these values in deployment secrets rather than app sources. A remote service needs private networking or authenticated HTTPS transport.

The platform authorizes the requesting account and supplies a bounded, signed account session. The service authenticates platform requests with the shared token, separates sessions by actor and limits top-level navigation to the supplied OS/app origins. It supports four concurrent sessions, screenshots, accessibility observations and pointer/keyboard actions. Sessions expire after thirty minutes without a request and are ephemeral across service restarts. `GET /health` is unauthenticated; other routes require the service token.

Use the platform's `/api/v1/computer` routes or SDK rather than distributing the service token to apps. Chromium and Playwright versions are pinned together by the Dockerfile and lockfile. The container uses Playwright's `--no-sandbox` launch mode, so deploy it as an isolated service for a trusted OS instance.
