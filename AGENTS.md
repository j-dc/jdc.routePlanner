# Project Guidelines

## Purpose

This repository is for a PowerShell-based package delivery route planner. A planning run accepts approximately 400 delivery addresses and a driver list of around 10 people. Its input specifies either the requested number of routes or the number of available drivers to use. Every selected driver must receive at least one delivery, and the primary optimization goal is to minimize total driving distance across all routes. Use Valhalla for road-network routing and distance costs. Run every effective workflow step in a container, including the planner's PowerShell entrypoint. Small PowerShell scripts in `./scripts/` may run on the host only as thin launchers that invoke `docker compose up` for the relevant container; the actual entrypoint and work run in that container. Leave service-specific behavior in the containers that own it.

The repository is currently an initial scaffold. Do not assume service names, Compose file names, address formats, driver attributes, route-to-driver cardinality rules, additional route constraints, external APIs, or deployment environments that have not been established in the code or documentation. Minimize total driving distance and ensure every selected driver has work; do not add workload-balancing, travel-time, or delivery-priority objectives unless requirements change.

## Route-Planning Workflow

- Separate routing-data preparation from each delivery-planning run. Document which steps are one-time setup, which run periodically to refresh data, and which run for every plan.
- For routing-data preparation, choose an OpenStreetMap (OSM) extract that covers the service area, its source, an update policy, and any required attribution. Download and retain the source data and generated Valhalla tiles in managed storage; do not commit large map datasets or generated tiles to the repository. Build or refresh tiles when the source data or Valhalla configuration changes, not blindly for every planning run.
- Treat address resolution as distinct from road routing. Use the local Photon geocoder with a Belgium-only database imported from the official Photon Europe dump using country filter `BE`. Do not send GDPR-sensitive delivery addresses to a public geocoder. Do not assume that downloading OSM routing data alone geocodes street addresses. Preserve each input's ID and report addresses that are invalid, ambiguous, or unresolved.
- Update the Photon database through the `UpdateGeocodeDatabase` container entrypoint. Download and retain source dump and generated index outside the repository. Verify the source checksum, import into a staging database, and switch the active database only after a successful import; retain the previous index for rollback.
- For each planning run, validate the address and driver inputs, resolve locations, confirm that the active Valhalla tiles cover them, and start the required Compose stacks. Wait for services to become healthy before making requests.
- The planning input is a semicolon-delimited CSV with the header `rit;naam;straat;nr.;postcode;gemeente;aantal;bellen;Opmerking;opmerking;klas`. Preserve the defined column names and order, including the distinct `Opmerking` and `opmerking` fields; validate rows and report malformed records instead of silently dropping them.
- Use Valhalla to obtain road-network costs and route data. Verify the selected Valhalla version, costing profile, API capabilities, and request limits. Batch large matrix requests when needed, and handle unreachable locations and routing errors explicitly.
- Respect the requested route count or selected driver count from the planning input. Assign at least one delivery to every selected driver, and minimize total road distance across all routes using Valhalla costs. Validate route-to-driver rules and count feasibility; report conflicts instead of silently changing the requested counts or leaving a driver without work. Do not assume a Valhalla route or matrix request by itself solves the full multi-driver delivery optimization problem; add a separate optimization component only when requirements justify it.
- Build a human-plan baseline by grouping input rows by the `rit` column and using their CSV row order as the stop order unless an explicit stop-order field is introduced. Use Valhalla to calculate road distance and route geometry for each existing route.
- Request final route geometry, costs, and any supported turn-by-turn details from Valhalla for the selected plans. Validate that the returned routes match the assignments and are usable before reporting success.
- For every selected driver, produce a map showing that driver's assigned route on an OpenStreetMap basemap and an address list in the exact stop order. Include required OpenStreetMap attribution, and validate that the map, ordered list, and route assignments agree.
- Produce a comparison report with an OSM map of all existing routes and a separate OSM map of all generated routes. Show distance per route and the total distance for each plan; report the distance difference so the generated plan can be compared with the human baseline. Calculate both plans with the same Valhalla version, tiles, costing profile, and start/end-point rules. Include OSM attribution and validate that the maps and reported distances match the route data.
- Return a clear plan that preserves the relationship between each input delivery and its output assignment. Every accepted delivery must appear exactly once or be reported with a clear reason it could not be planned; do not silently drop records or present a partial plan as complete.
- Stop only the services started for the selected workflow, following the documented stack lifecycle. Preserve reusable OSM source data and Valhalla tiles unless an explicit data-refresh or removal operation is requested.
- Do not invent driver availability, vehicle capacity, shift duration, service times, time windows, or delivery priorities. Add these constraints only when they are part of the defined input and planning rules.
- Keep route-planning logic testable independently of Docker and Valhalla. Unit tests should cover assignment and sequencing decisions with mocked routing data; integration tests should verify the configured Valhalla service and representative end-to-end inputs.

## PowerShell

- Target and document a specific PowerShell edition and minimum version. Prefer PowerShell 7+ unless compatibility requirements say otherwise.
- Use approved verbs and descriptive PascalCase function names. Use descriptive variable names rather than cryptic abbreviations.
- Put script inputs in a `param` block. Use types and validation attributes where they make invalid input harder to express.
- Keep functions focused and avoid hidden dependencies on the current working directory or mutable global state.
- Resolve files relative to `$PSScriptRoot`, not the caller's current directory. Do not leave the caller in a changed location; use `Push-Location`/`Pop-Location` in a `try`/`finally` block when changing directories is unavoidable.
- Fail clearly when required tools, files, configuration, or services are unavailable. Preserve useful error context and return nonzero exit codes on failure.
- Use `Write-Verbose` for diagnostic details and `Write-Information` or ordinary output for user-facing status. Keep standard output usable by callers and avoid `Write-Host` in reusable functions.
- Support `-WhatIf` and `-Confirm` for operations that start, stop, remove, or otherwise change Docker resources, using `SupportsShouldProcess` where appropriate.

## Docker Compose Orchestration

- Prefer Alpine-based container images when the required runtime and dependencies support them. Use a non-Alpine base when a required runtime or native dependency is unsupported or unverified on Alpine, and document the reason. Pin an explicit image version/tag.
- Run every application and data-preparation step in a container, including each task's effective PowerShell entrypoint. Do not run workflow or data-processing logic directly on the host.
- Reuse the repository's shared PowerShell base image for compatible PowerShell containers. Keep a different base only when a required runtime or native dependency is unsupported or unverified on that base, and document the reason.
- Keep host-side scripts in `./scripts/` small and limited to launching the appropriate Compose service with `docker compose up`. For example, `./scripts/fetchOsm.ps1` may start the OSM preparation container, but downloading or processing OSM data belongs in that container's entrypoint.
- Document each operation's host-side launcher or Compose command, container entrypoint, purpose, and lifecycle in `README.md`. Keep the operation-to-stack mapping in one maintainable place, and avoid adding a separate launcher when a step belongs inside an existing container workflow.
- The planner container must have an explicit, documented way to start and manage the other required containers. Do not assume Docker-in-Docker or implicit access to the host daemon. Treat a mounted Docker socket or remote Docker endpoint as privileged access; document and secure it, and grant only the access required by the workflow.
- Treat each Compose file as an explicit stack definition. Keep the mapping from a planner operation to its Compose files and services in one documented, maintainable place.
- Invoke Compose as `docker compose` and pass each Compose file explicitly with `-f`. Do not depend on implicit discovery of `compose.yaml` or on a particular launch directory.
- Give independently managed stacks deliberate, stable Compose project names so their containers, networks, and volumes do not collide.
- Validate the selected Compose configuration before starting services. Prefer health checks and readiness checks over fixed sleep delays.
- Check the Docker CLI and daemon before orchestration. Capture and check native command exit codes (`$LASTEXITCODE`); a native command's failure must not be reported as success.
- Pass arguments as separate values rather than constructing executable command strings or using `Invoke-Expression`.
- Stop or remove only resources belonging to the selected stack. Never remove volumes, prune Docker resources, or affect unrelated projects without an explicit user request and confirmation.
- Keep container-specific configuration and lifecycle logic with the relevant Compose stack where practical; keep the PowerShell layer focused on workflow and coordination.

## Configuration and Security

- Keep `ritten.csv` and all GDPR-sensitive input and derived output outside the repository and VS Code workspace. Do not copy real addresses into fixtures, logs, prompts, or committed files. Mount input read-only into only the containers that need it, and keep generated maps and address reports in external managed storage.
- Do not commit credentials, tokens, private keys, or machine-specific settings. Read secrets from an approved environment-specific source and document the required variable names without their values.
- Provide safe example configuration with placeholder values when examples are needed. Do not print secret values in logs or errors.
- Validate external input before using it in paths, Compose project/service selection, URLs, or process arguments.
- Use least privilege for container users, mounts, capabilities, and network exposure. Avoid privileged containers and broad host mounts unless the requirement is documented.

## Testing and Validation

- Add Pester tests for PowerShell decisions and orchestration behavior. Mock Docker calls in unit tests so the normal test suite does not require a running daemon or network access.
- Keep integration tests separate and clearly identify any Docker daemon, image, network, or external-service prerequisites.
- Validate changed Compose files with `docker compose -f <file> config --quiet` and verify the PowerShell script parses before relying on an integration run.
- Cover failure cases, including missing Docker, invalid configuration, Compose failures, and unhealthy or unavailable services.
- Never make tests depend on deleting a developer's existing containers, networks, or volumes.

## Documentation and Changes

- Keep `README.md` current with the project's purpose, prerequisites, supported PowerShell version, configuration, available operations, and safe run/test commands.
- Update the Mermaid workflow diagram in `README.md` whenever workflow stages, dependencies, inputs or outputs, or service lifecycle change. Keep it consistent with the implementation and documented assumptions.
- Document each Compose stack's responsibility, how stacks interact, and any required startup or shutdown ordering.
- Prefer small, focused changes. Do not add a dependency or a new Compose stack without explaining why it is needed.
- Use portable paths and avoid machine-specific absolute paths.
- Before completing a change, run the focused tests and validation relevant to the files changed, and report any checks that could not be run.