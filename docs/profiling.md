# Production CPU and heap profiling

Cloudflare's [on-demand profiling release](https://blog.cloudflare.com/workers-on-demand-profiling/)
captures running Worker isolates without deploying instrumentation. Follow the
[current production guide](https://developers.cloudflare.com/workers/observability/profiling-in-production/).

## What is configured

- `upload_source_maps: true` for readable source locations after the next deployment
- Existing structured logs at 100% sampling
- Workers traces at 5% sampling (`observability.traces`)
- No profiling library or additional production dependency

The existing compatibility date is deliberately retained. Profiling does not require
advancing it; changing runtime semantics is a separate migration.

## Capture safely

Use an account and deployed version you have explicitly confirmed. The `cf` CLI has
separate authentication from Wrangler. An older installation such as `cf` 0.15.0 does
not expose the new profiling command. The commands below pin the verified
`cf` release `1.0.0-beta.14`, without upgrading a global installation.

```bash
npm exec --yes --package=cf@1.0.0-beta.14 -- cf auth login
npm exec --yes --package=cf@1.0.0-beta.14 -- cf auth whoami
npm exec -- wrangler deployments list
```

Automation can use `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Profiling needs
Workers Scripts Read / Content Read-Only Workers permissions. Never put token values
in command arguments, reports, or git.

Choose the UUID of a version **actively serving traffic** from the current deployment.
`latest` selects the newest *created* version, which may not be deployed. For a gradual
rollout, identify the version and percentage you intend to measure.

```bash
export WORKER_ID='repo-pulse'
export VERSION_ID='<confirmed running version UUID>'

npm exec --yes --package=cf@1.0.0-beta.14 -- cf workers versions profile "$VERSION_ID" \
  --worker-id "$WORKER_ID" --duration-ms 5000 --profile-type cpu > worker-cpu.pprof

npm exec --yes --package=cf@1.0.0-beta.14 -- cf workers versions profile "$VERSION_ID" \
  --worker-id "$WORKER_ID" --duration-ms 5000 --profile-type heap > worker-heap.pprof
```

These are binary files. Do not redirect an `npm run` wrapper's logging into the file.
The CLI must exit successfully before you analyze the capture. Profiles are ignored
by git because they can contain operational source locations and labels.

Traffic must precede and continue during the capture: the profiler does not invoke
the Worker. Prefer existing traffic or an isolated staging Worker with disposable D1
and a fake/test notification destination. Never replay production webhooks merely to
fill a profile. Do not run admin mutations, migrations, or deployments as part of capture.

Duration is 1–50 seconds. CPU samples are approximately 1 ms apart; the heap profile
samples **allocations**, not retained heap, and excludes allocations before capture.
A regular Worker capture selects a running isolate, not every region or every request.
On `429`, honor `Retry-After`. An idle or unsupported isolate can yield no useful profile;
report that rather than inferring a hotspot from an empty capture.

## Analyze and compare

Open **Observability → Flamegraph** in the Cloudflare dashboard, or use Go's pprof reader:

```bash
go tool pprof -top worker-cpu.pprof
go tool pprof -top -cum worker-cpu.pprof
go tool pprof -top -alloc_space worker-heap.pprof
go tool pprof -http=127.0.0.1:8080 worker-cpu.pprof
```

Use Self vs Total to distinguish direct cost from callers. Missing source mappings
mean you cannot safely attribute generated frames to original TypeScript. Capture the
same workload, duration, version identity, and region conditions repeatedly before
claiming an improvement; record median and range, not a single favorable sample.

For this Worker, investigate signature verification, JSON parsing, per-request routing
setup, embed formatting, and delivery draining **only when the profile supports it**.
D1/network waiting is not explained by CPU flamegraph width; use traces and database
query evidence for those stages.

When optimizing routing setup, reuse route definitions rather than caching services
or configuration derived from bindings. [Binding-only deployments can reuse isolates](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings),
so binding-dependent clients must read the current request's environment.

## Local benchmarks

`npm run benchmark:ledger` measures a disposable local SQLite ledger. These timings
are separate from production profiles and must not be presented as Workers CPU,
memory, or end-to-end latency measurements.
