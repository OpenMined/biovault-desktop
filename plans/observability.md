# BioVault Observability Plan

## Overview

This document outlines the integration of **SigNoz** for distributed tracing, logging, and metrics across the BioVault ecosystem. The goal is to enable end-to-end visibility when debugging network-based issues across:

- **SyftBox Server** (Rust) - File sync, auth, WebSocket
- **BioVault CLI** (Rust) - Message sync, crypto, daemon
- **SyftBox-SDK** (Rust) - RPC, storage, identity
- **BioVault Beaver** (Python) - Sessions, data exchange
- **BioVault Desktop** (Tauri/Rust + JS) - UI, WebSocket bridge

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DISTRIBUTED SYSTEM                                 │
│                                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │  Desktop 1   │     │  Desktop 2   │     │   SyftBox    │                │
│  │  (Tauri)     │     │  (Tauri)     │     │   Server     │                │
│  │  + biovault  │     │  + biovault  │     │              │                │
│  │  + beaver    │     │  + beaver    │     │              │                │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘                │
│         │ OTLP               │ OTLP               │ OTLP                    │
│         └────────────────────┼────────────────────┘                         │
│                              ▼                                               │
│                     ┌────────────────┐                                       │
│                     │    SigNoz      │                                       │
│                     │  ┌──────────┐  │                                       │
│                     │  │ClickHouse│  │  ← Logs, Traces, Metrics             │
│                     │  └──────────┘  │                                       │
│                     │  Port: 3301    │  ← UI                                │
│                     │  Port: 4317    │  ← OTLP gRPC                         │
│                     │  Port: 4318    │  ← OTLP HTTP                         │
│                     └────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Recent Desktop Findings (2026-01-08)

Local runs (pipelines-collab) show the biggest time sinks are still in dependency
checks and onboarding. The run below was performed on the main desktop display.

Run summary (pipelines-collab):

- Command: `DISPLAY=:1 XAUTHORITY=/home/linux/.Xauthority ./test-scenario-obs.sh --pipelines-collab --interactive`
- Total time: ~203.62s (Playwright ~195.90s)
- Milestones: onboarding ~17.57s, key exchange ~2.48s, dataset sync ~2.01s

Top command timings (sample):

- refresh_messages_batched: ~2.0s total (746 calls, ~2.7ms avg)
- check_dependencies: ~1.55s total (2 calls)
- update_saved_dependency_states: ~1.40s total (2 calls)
- complete_onboarding: ~1.40s total (2 calls)
- get_syftbox_state: ~0.14s total (8 calls)
- get_syftbox_diagnostics: ~0.18s total (4 calls)

Findings:

- Message refresh polling can cause DOM churn; batching sync+list reduced round
  trips and render hashing avoided unnecessary DOM rebuilds.
- Dependency checks remain the slowest per-call operations; caching and reducing
  re-checks helps but must not hide missing deps.
- No nested spans inside the slow commands; deeper instrumentation is still the
  highest priority for root-cause analysis.

Confirmed gaps:

- Beaver (Python) has no telemetry. Instrument these files first:
  - `biovault-beaver/python/src/beaver/runtime.py`
  - `biovault-beaver/python/src/beaver/computation.py`
  - `biovault-beaver/python/src/beaver/twin.py`
  - `biovault-beaver/python/src/beaver/session.py`
  - `biovault-beaver/python/src/beaver/remote_vars.py`

Next actions:

- Add child spans inside `get_syftbox_state`, `get_syftbox_diagnostics`,
  `get_saved_dependency_states` to expose sub-steps.
- Instrument the sync trigger HTTP handler to explain 404 failures.
- Add OpenTelemetry initialization and spans to Beaver Python for Jupyter runs.

## Quick Start Options

### Option A: Jaeger (Fastest, No Docker)

Single binary, in-memory storage, instant startup. **Best for fast iteration.**

```bash
# Download Jaeger all-in-one (one-time)
./scripts/setup-jaeger.sh

# Start Jaeger (instant, ~50MB memory)
./scripts/start-jaeger.sh

# Run tests with tracing
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 ./test-scenario.sh messaging

# View traces at http://localhost:16686
```

| Port  | Purpose     |
| ----- | ----------- |
| 16686 | Jaeger UI   |
| 4317  | OTLP gRPC   |
| 4318  | OTLP HTTP   |
| 14268 | Jaeger HTTP |

**Pros:** No Docker, instant start, ~50MB RAM, simple UI
**Cons:** In-memory only (traces lost on restart), no metrics/logs

---

### Option B: SigNoz (Full Featured, Docker)

Full observability stack with persistence. **Best for debugging complex issues.**

```bash
# From workspace root
cd docker
docker compose -f docker-compose.signoz.yml up -d

# Verify running
curl http://localhost:3301/api/v1/health
```

| Port | Purpose   |
| ---- | --------- |
| 3301 | SigNoz UI |
| 4317 | OTLP gRPC |
| 4318 | OTLP HTTP |

**Pros:** Persistent storage, logs + traces + metrics, powerful queries
**Cons:** Requires Docker, ~2GB RAM for ClickHouse

---

### Option C: File Export (Simplest, Debug Only)

Export traces to JSON files for manual inspection. No server needed.

```bash
# Enable file export instead of OTLP
export OTEL_TRACES_EXPORTER=file
export OTEL_EXPORTER_FILE_PATH=./logs/traces.jsonl

./test-scenario.sh messaging

# View traces
cat logs/traces.jsonl | jq .
```

---

### Enable Tracing in Tests

```bash
# With Jaeger (fastest)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 ./test-scenario.sh messaging

# With SigNoz
ENABLE_TRACING=1 ./test-scenario.sh messaging
```

---

## Enable/Disable Mechanism

### Design Principle: "Off Means Off"

When tracing is disabled, there are **zero network calls, zero overhead**:

```rust
// Rust pattern - compile-time feature flag + runtime env check
pub fn init_tracing() -> Option<TracerProvider> {
    // Only initialize if explicitly enabled
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok()?;
    if endpoint.is_empty() {
        return None;
    }
    // ... initialize OpenTelemetry
}
```

```python
# Python pattern - lazy initialization
_tracer = None

def get_tracer():
    global _tracer
    if _tracer is None:
        endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        if not endpoint:
            return NoopTracer()  # Zero-cost stub
        _tracer = init_otel_tracer(endpoint)
    return _tracer
```

### Environment Variables

| Variable                      | Purpose                           | Example                                              |
| ----------------------------- | --------------------------------- | ---------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | SigNoz endpoint (enables tracing) | `http://localhost:4318`                              |
| `OTEL_SERVICE_NAME`           | Service identifier in traces      | `biovault-desktop-1`                                 |
| `OTEL_RESOURCE_ATTRIBUTES`    | Additional context                | `deployment.environment=staging`                     |
| `OTEL_TRACES_SAMPLER`         | Sampling strategy                 | `always_on`, `traceidratio`, `parentbased_always_on` |
| `OTEL_TRACES_SAMPLER_ARG`     | Sampler config                    | `0.1` (10% sampling)                                 |

### Per-Component Toggle

```bash
# Desktop 1 - tracing enabled
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=biovault-desktop-1 \
./bv-desktop

# Desktop 2 - tracing enabled
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=biovault-desktop-2 \
./bv-desktop

# Server - tracing enabled
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=syftbox-server \
./syftbox daemon
```

---

## Docker Setup

### docker/docker-compose.signoz.yml

```yaml
version: '3.8'

services:
  signoz:
    image: signoz/signoz:latest
    container_name: signoz
    ports:
      - '3301:3301' # UI
      - '4317:4317' # OTLP gRPC
      - '4318:4318' # OTLP HTTP
    volumes:
      - signoz-data:/var/lib/signoz
    environment:
      - SIGNOZ_STORAGE=clickhouse
    restart: unless-stopped

  clickhouse:
    image: clickhouse/clickhouse-server:24.1
    container_name: signoz-clickhouse
    ports:
      - '9000:9000' # Native protocol
      - '8123:8123' # HTTP interface
    volumes:
      - clickhouse-data:/var/lib/clickhouse
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    restart: unless-stopped

  otel-collector:
    image: signoz/signoz-otel-collector:latest
    container_name: signoz-otel-collector
    command: ['--config=/etc/otel-collector-config.yaml']
    ports:
      - '4317:4317' # OTLP gRPC receiver
      - '4318:4318' # OTLP HTTP receiver
    volumes:
      - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro
    depends_on:
      - clickhouse
    restart: unless-stopped

volumes:
  signoz-data:
  clickhouse-data:
```

### docker/otel-collector-config.yaml

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024

exporters:
  clickhousetraces:
    datasource: tcp://clickhouse:9000
    database: signoz_traces
  clickhouselogs:
    datasource: tcp://clickhouse:9000
    database: signoz_logs
  clickhousemetricsv4:
    datasource: tcp://clickhouse:9000
    database: signoz_metrics

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhousetraces]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhouselogs]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhousemetricsv4]
```

---

## Staging/Production Deployment

For `dev.syftbox.net`, SigNoz can run on the same server:

```bash
# On dev.syftbox.net
docker compose -f docker-compose.signoz.yml up -d

# Firewall: Allow 4318 from trusted IPs only
ufw allow from <office-ip> to any port 4318
```

Clients connect via:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://dev.syftbox.net:4318
```

---

## Component Instrumentation

### 1. SyftBox Server (Rust)

**Location**: `syftbox/rust/src/`

#### Dependencies (Cargo.toml)

```toml
[dependencies]
opentelemetry = "0.27"
opentelemetry_sdk = { version = "0.27", features = ["rt-tokio"] }
opentelemetry-otlp = { version = "0.27", features = ["http-proto", "reqwest-client"] }
tracing = "0.1"
tracing-opentelemetry = "0.28"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

#### Instrumentation Points

| File          | Function                   | Span Name            | Attributes           |
| ------------- | -------------------------- | -------------------- | -------------------- |
| `main.rs`     | `run_daemon()`             | `daemon.run`         | version, config      |
| `http.rs`     | `send_authed()`            | `http.request`       | method, url, status  |
| `auth.rs`     | `refresh_auth_tokens()`    | `auth.refresh`       | success, duration    |
| `sync.rs`     | `sync_once_with_control()` | `sync.run`           | files_up, files_down |
| `uploader.rs` | `upload_blob_smart()`      | `blob.upload`        | size, multipart      |
| `client.rs`   | `run_ws_listener()`        | `ws.listen`          | connected, messages  |
| `control.rs`  | HTTP handlers              | `control.{endpoint}` | status, duration     |

#### Implementation Example

```rust
// src/telemetry.rs (new file)
use opentelemetry::global;
use opentelemetry_otlp::WithExportConfig;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

pub fn init_tracing() -> Option<opentelemetry_sdk::trace::TracerProvider> {
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok()?;
    if endpoint.is_empty() {
        return None;
    }

    let service_name = std::env::var("OTEL_SERVICE_NAME")
        .unwrap_or_else(|_| "syftbox-server".to_string());

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(&endpoint)
        .build()
        .ok()?;

    let provider = opentelemetry_sdk::trace::TracerProvider::builder()
        .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
        .with_resource(opentelemetry_sdk::Resource::new(vec![
            opentelemetry::KeyValue::new("service.name", service_name),
        ]))
        .build();

    global::set_tracer_provider(provider.clone());

    let telemetry = tracing_opentelemetry::layer()
        .with_tracer(provider.tracer("syftbox"));

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .with(telemetry)
        .with(tracing_subscriber::fmt::layer())
        .init();

    Some(provider)
}

pub fn shutdown_tracing() {
    global::shutdown_tracer_provider();
}
```

```rust
// src/http.rs - Example instrumentation
use tracing::{instrument, info_span, Instrument};

impl ApiClient {
    #[instrument(skip(self), fields(method = %method, url = %url))]
    pub async fn send_authed(&self, method: Method, url: &str) -> Result<Response> {
        let span = info_span!("http.request",
            otel.kind = "client",
            http.method = %method,
            http.url = %url,
        );

        async {
            let response = self.client.request(method, url)
                .send()
                .await?;

            tracing::Span::current()
                .record("http.status_code", response.status().as_u16());

            Ok(response)
        }
        .instrument(span)
        .await
    }
}
```

---

### 2. BioVault CLI (Rust)

**Location**: `biovault/cli/src/`

**Note**: Already uses `tracing` crate - needs OTLP exporter addition.

#### Dependencies (Cargo.toml additions)

```toml
[dependencies]
opentelemetry = "0.27"
opentelemetry_sdk = { version = "0.27", features = ["rt-tokio"] }
opentelemetry-otlp = { version = "0.27", features = ["http-proto", "reqwest-client"] }
tracing-opentelemetry = "0.28"
```

#### Instrumentation Points

| File                               | Function                   | Span Name        | Attributes            |
| ---------------------------------- | -------------------------- | ---------------- | --------------------- |
| `main.rs`                          | `async_main()`             | `cli.run`        | command, args         |
| `messages/sync.rs`                 | `send_via_send_handler()`  | `message.send`   | recipient, size       |
| `messages/sync.rs`                 | `check_for_new_messages()` | `message.sync`   | count, failures       |
| `messages/db.rs`                   | DB operations              | `db.{operation}` | table, rows           |
| `cli/commands/daemon.rs`           | `run()`                    | `daemon.loop`    | iteration, duration   |
| `cli/commands/files.rs`            | `hash()`                   | `file.hash`      | path, size, algorithm |
| `cli/download_cache/downloader.rs` | `download_with_cache()`    | `download`       | url, size, cached     |

#### Implementation Example

```rust
// messages/sync.rs
#[instrument(skip(client, envelope), fields(
    recipient = %recipient,
    message_size = envelope.len()
))]
pub fn send_via_send_handler(
    client: &Client,
    recipient: &str,
    envelope: &[u8],
) -> Result<()> {
    let span = tracing::Span::current();

    let response = client
        .post(&format!("{}/api/v1/send/msg", server_url))
        .body(envelope.to_vec())
        .send()?;

    span.record("http.status", response.status().as_u16());

    if !response.status().is_success() {
        span.record("error", true);
        return Err(anyhow!("Send failed: {}", response.status()));
    }

    Ok(())
}
```

---

### 3. SyftBox-SDK (Rust)

**Location**: `syftbox-sdk/src/syftbox/`

#### Dependencies (Cargo.toml additions)

```toml
[dependencies]
tracing = "0.1"
# OTLP export handled by parent crate (biovault/desktop)
```

#### Instrumentation Points

| File          | Function                     | Span Name            | Attributes                    |
| ------------- | ---------------------------- | -------------------- | ----------------------------- |
| `rpc.rs`      | `send_request()`             | `rpc.send`           | request_id, recipient, method |
| `endpoint.rs` | `check_requests()`           | `rpc.check`          | endpoint, count               |
| `endpoint.rs` | `send_response()`            | `rpc.respond`        | request_id, status            |
| `storage.rs`  | `write_encrypted_file()`     | `storage.write`      | path, size, encrypted         |
| `storage.rs`  | `read_with_shadow()`         | `storage.read`       | path, cache_hit               |
| `auth.rs`     | `verify_otp()`               | `auth.verify`        | email, success                |
| `syc.rs`      | `provision_local_identity()` | `identity.provision` | identity                      |

#### Implementation Example

```rust
// rpc.rs
use tracing::instrument;

#[instrument(skip(app, req), fields(
    request_id = %req.id,
    recipient = %recipient,
    method = %req.method
))]
pub fn send_request(
    app: &SyftBoxApp,
    recipient: &str,
    req: &RpcRequest,
) -> Result<PathBuf> {
    let path = app.outbox_path(recipient).join(format!("{}.request", req.id));

    // Encrypt and write
    storage::write_json_with_shadow(&path, req, &[recipient])?;

    tracing::info!("RPC request sent");
    Ok(path)
}
```

---

### 4. BioVault Beaver (Python)

**Location**: `biovault-beaver/python/src/beaver/`

#### Dependencies (pyproject.toml additions)

```toml
[project.optional-dependencies]
telemetry = [
    "opentelemetry-api>=1.20.0",
    "opentelemetry-sdk>=1.20.0",
    "opentelemetry-exporter-otlp>=1.20.0",
    "opentelemetry-instrumentation>=0.41b0",
]
```

#### Instrumentation Points

| File                 | Function              | Span Name        | Attributes             |
| -------------------- | --------------------- | ---------------- | ---------------------- |
| `runtime.py`         | `connect()`           | `beaver.connect` | email, mode            |
| `runtime.py`         | `pack()`              | `beaver.pack`    | type, size, recipients |
| `runtime.py`         | `unpack()`            | `beaver.unpack`  | type, policy_valid     |
| `session.py`         | `send()`              | `session.send`   | peer, object_type      |
| `session.py`         | `load()`              | `session.load`   | session_id             |
| `twin.py`            | `request_private()`   | `twin.request`   | twin_id                |
| `syftbox_backend.py` | `write_with_shadow()` | `storage.write`  | path, encrypted        |

#### Implementation Example

```python
# runtime.py
import os
from contextlib import contextmanager

# Lazy import to avoid dependency when disabled
_tracer = None

def _get_tracer():
    global _tracer
    if _tracer is not None:
        return _tracer

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        # Return no-op tracer
        from opentelemetry.trace import NoOpTracer
        _tracer = NoOpTracer()
        return _tracer

    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource

    resource = Resource.create({
        "service.name": os.environ.get("OTEL_SERVICE_NAME", "beaver"),
    })

    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    _tracer = trace.get_tracer("beaver")
    return _tracer


@contextmanager
def trace_span(name: str, **attributes):
    """Context manager for creating spans."""
    tracer = _get_tracer()
    with tracer.start_as_current_span(name) as span:
        for key, value in attributes.items():
            span.set_attribute(key, value)
        yield span


# Usage in pack()
def pack(obj, recipients=None):
    with trace_span("beaver.pack",
                    object_type=type(obj).__name__,
                    recipients=len(recipients or [])) as span:
        envelope = _do_pack(obj, recipients)
        span.set_attribute("envelope_size", len(envelope))
        return envelope
```

---

### 5. BioVault Desktop (Tauri + JS)

**Location**: `src-tauri/src/` and `src/`

#### Rust Backend (src-tauri)

Add to existing `logging.rs`:

```rust
// src-tauri/src/telemetry.rs (new file)
use opentelemetry::global;
use std::env;

static INIT: std::sync::Once = std::sync::Once::new();

pub fn init() {
    INIT.call_once(|| {
        if let Ok(endpoint) = env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
            if !endpoint.is_empty() {
                // Initialize OTLP exporter
                // ... (similar to syftbox implementation)
            }
        }
    });
}

#[macro_export]
macro_rules! trace_span {
    ($name:expr, $($key:ident = $value:expr),* $(,)?) => {{
        tracing::info_span!($name, $($key = $value),*)
    }};
}
```

#### JavaScript Frontend (src/)

```javascript
// src/telemetry.js (new file)
const OTEL_ENDPOINT = window.__OTEL_ENDPOINT__ || null

class Telemetry {
	constructor() {
		this.enabled = !!OTEL_ENDPOINT
		this.spans = new Map()
	}

	startSpan(name, attributes = {}) {
		if (!this.enabled) return { end: () => {} }

		const spanId = crypto.randomUUID()
		const span = {
			name,
			startTime: performance.now(),
			attributes,
			end: () => this.endSpan(spanId),
		}
		this.spans.set(spanId, span)
		return span
	}

	endSpan(spanId) {
		const span = this.spans.get(spanId)
		if (!span) return

		span.duration = performance.now() - span.startTime
		this.spans.delete(spanId)

		// Send to backend for OTLP export
		if (window.__TAURI__?.core?.invoke) {
			window.__TAURI__.core
				.invoke('log_trace_span', {
					name: span.name,
					duration: span.duration,
					attributes: span.attributes,
				})
				.catch(() => {})
		}
	}
}

export const telemetry = new Telemetry()

// Usage:
// const span = telemetry.startSpan('ui.button_click', { button: 'send' });
// await doSomething();
// span.end();
```

---

## Test Infrastructure Integration

### test-scenario.sh Modifications

```bash
# Add near top of test-scenario.sh
start_signoz() {
    if [[ "${ENABLE_TRACING:-0}" == "1" ]]; then
        echo "🔭 Starting SigNoz..."
        docker compose -f docker/docker-compose.signoz.yml up -d

        # Wait for SigNoz to be ready
        for i in {1..30}; do
            if curl -s http://localhost:3301/api/v1/health > /dev/null; then
                echo "✅ SigNoz ready"
                export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
                return 0
            fi
            sleep 1
        done
        echo "⚠️ SigNoz not ready, continuing without tracing"
    fi
}

stop_signoz() {
    if [[ "${ENABLE_TRACING:-0}" == "1" ]] && [[ "${KEEP_SIGNOZ:-0}" != "1" ]]; then
        echo "🔭 Stopping SigNoz..."
        docker compose -f docker/docker-compose.signoz.yml down
    fi
}

# In cleanup() function, add:
stop_signoz

# Before launching Tauri instances, add:
start_signoz

# In launch_instance() function, add to environment:
if [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]]; then
    export OTEL_EXPORTER_OTLP_ENDPOINT
    export OTEL_SERVICE_NAME="biovault-desktop-${instance_num}"
fi
```

### Usage

```bash
# Run tests with tracing
ENABLE_TRACING=1 ./test-scenario.sh messaging

# Keep SigNoz running after tests for inspection
ENABLE_TRACING=1 KEEP_SIGNOZ=1 ./test-scenario.sh messaging

# View traces at http://localhost:3301
```

---

## Trace Correlation Strategy

### Request ID Propagation

All components use a shared correlation ID pattern:

```
┌─────────────┐    trace_id: abc123    ┌─────────────┐
│  Desktop 1  │ ───────────────────────▶│   Server    │
│  span: send │    x-trace-id header    │  span: recv │
└─────────────┘                         └──────┬──────┘
                                               │
                                               ▼ trace_id: abc123
                                        ┌─────────────┐
                                        │  Desktop 2  │
                                        │  span: recv │
                                        └─────────────┘
```

### Implementation

```rust
// Inject trace context into HTTP headers
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry_sdk::propagation::TraceContextPropagator;

fn inject_trace_context(headers: &mut HeaderMap) {
    let propagator = TraceContextPropagator::new();
    let cx = opentelemetry::Context::current();

    propagator.inject_context(&cx, &mut HeaderCarrier(headers));
}

// Extract trace context from incoming request
fn extract_trace_context(headers: &HeaderMap) -> opentelemetry::Context {
    let propagator = TraceContextPropagator::new();
    propagator.extract(&HeaderCarrier(headers))
}
```

---

## Key Metrics to Track

### Latency Histograms

| Metric                              | Description           | Labels                   |
| ----------------------------------- | --------------------- | ------------------------ |
| `http_request_duration_seconds`     | HTTP request latency  | method, endpoint, status |
| `message_send_duration_seconds`     | Message send latency  | recipient                |
| `message_sync_duration_seconds`     | Message sync cycle    | client                   |
| `file_upload_duration_seconds`      | File upload latency   | size_bucket              |
| `crypto_operation_duration_seconds` | Encryption/decryption | operation                |

### Counters

| Metric                    | Description           | Labels                    |
| ------------------------- | --------------------- | ------------------------- |
| `messages_sent_total`     | Messages sent         | status                    |
| `messages_received_total` | Messages received     | status, decryption_result |
| `sync_cycles_total`       | Sync cycles completed | status                    |
| `auth_refreshes_total`    | Token refreshes       | success                   |
| `rpc_requests_total`      | RPC requests          | method, status            |

### Gauges

| Metric                 | Description               | Labels |
| ---------------------- | ------------------------- | ------ |
| `active_sessions`      | Active Beaver sessions    | -      |
| `pending_uploads`      | Files queued for upload   | -      |
| `ws_connection_status` | WebSocket connected (1/0) | client |

---

## Debugging Workflows

### 1. Message Delivery Failure

```sql
-- In SigNoz, query for failed message sends
SELECT * FROM signoz_traces.distributed_traces
WHERE service_name = 'biovault-desktop-1'
  AND span_name = 'message.send'
  AND status_code = 'ERROR'
ORDER BY timestamp DESC
LIMIT 10
```

### 2. Latency Investigation

```sql
-- Find slow sync operations
SELECT
    service_name,
    span_name,
    duration_nano / 1e6 as duration_ms,
    attributes
FROM signoz_traces.distributed_traces
WHERE span_name LIKE 'sync.%'
  AND duration_nano > 5000000000  -- > 5 seconds
ORDER BY duration_nano DESC
```

### 3. End-to-End Trace

1. Open SigNoz UI → Traces
2. Filter by `trace_id` or `service_name`
3. View waterfall diagram showing:
   - Desktop 1 → Server → Desktop 2 flow
   - Individual operation timings
   - Error locations

---

## Rollout Plan

### Phase 1: Infrastructure (Week 1)

- [ ] Add `docker/docker-compose.signoz.yml`
- [ ] Add `docker/otel-collector-config.yaml`
- [ ] Test SigNoz locally
- [ ] Document startup/shutdown

### Phase 2: SyftBox Server (Week 2)

- [ ] Add OTel dependencies to `syftbox/rust/Cargo.toml`
- [ ] Create `src/telemetry.rs`
- [ ] Instrument HTTP layer (`http.rs`)
- [ ] Instrument sync engine (`sync.rs`)
- [ ] Instrument auth (`auth.rs`)

### Phase 3: BioVault CLI (Week 3)

- [ ] Add OTel exporter to existing tracing
- [ ] Instrument message send/receive
- [ ] Instrument daemon loop
- [ ] Instrument file operations

### Phase 4: SDK + Beaver (Week 4)

- [ ] Add tracing to syftbox-sdk
- [ ] Add Python OTel to beaver
- [ ] Instrument RPC layer
- [ ] Instrument session operations

### Phase 5: Desktop + Tests (Week 5)

- [ ] Add tracing to src-tauri
- [ ] Add frontend telemetry.js
- [ ] Integrate with test-scenario.sh
- [ ] Document debugging workflows

---

## Security Considerations

1. **No PII in traces** - Never log email addresses, file contents, or encryption keys
2. **Sampling in production** - Use 10% sampling to reduce data volume
3. **Network isolation** - SigNoz should only accept connections from trusted sources
4. **Data retention** - Configure ClickHouse retention policy (default: 7 days for dev)

---

## Implementation Status

### ✅ Completed Instrumentation

The following components have been instrumented with OpenTelemetry tracing:

#### 1. BioVault Desktop (`src-tauri/`)

**Files Modified:**

- `src-tauri/Cargo.toml` - Added OTel dependencies
- `src-tauri/src/telemetry.rs` - New telemetry module
- `src-tauri/src/lib.rs` - Added telemetry initialization
- `src-tauri/src/ws_bridge.rs` - Added command execution tracing

**Instrumented Spans:**
| Span | Location | Attributes |
|------|----------|------------|
| `command` | ws_bridge.rs | cmd, request_id |

#### 2. SyftBox-SDK (`syftbox-sdk/src/syftbox/`)

**Files Modified:**

- `rpc.rs` - Added tracing to all RPC functions
- `endpoint.rs` - Added tracing to endpoint operations
- `storage.rs` - Added tracing to storage operations

**Instrumented Spans:**
| Span | Location | Attributes |
|------|----------|------------|
| `check_all_requests` | rpc.rs | app_email |
| `check_requests` | rpc.rs | endpoint |
| `send_response` | rpc.rs | endpoint, request_id, status |
| `send_request` | rpc.rs | endpoint, request_id, method, recipient |
| `check_responses` | rpc.rs | endpoint |
| `process_request` | rpc.rs | endpoint, request_id, method |
| `Endpoint::new` | endpoint.rs | endpoint |
| `check_requests` | endpoint.rs | endpoint |
| `check_requests_with_failures` | endpoint.rs | endpoint |
| `send_response` | endpoint.rs | endpoint, request_id, status |
| `create_request` | endpoint.rs | endpoint, request_id, method, recipient |
| `check_responses` | endpoint.rs | endpoint |
| `cleanup_response` | endpoint.rs | endpoint |
| `write_encrypted_with_shadow` | storage.rs | size, encrypted |
| `read_with_shadow` | storage.rs | - |
| `read_with_shadow_metadata` | storage.rs | - |
| `write_with_shadow` | storage.rs | size |

#### 3. BioVault CLI (`biovault/cli/src/`)

**Files Modified:**

- `Cargo.toml` - Added OTel dependencies
- `lib.rs` - Added telemetry module declaration
- `telemetry.rs` - New telemetry module (mirrors desktop pattern)
- `messages/sync.rs` - Added tracing to message sync operations
- `cli/commands/daemon.rs` - Added tracing to daemon operations
- `cli/commands/pipeline.rs` - Added tracing to pipeline operations

**Instrumented Spans:**
| Span | Location | Attributes |
|------|----------|------------|
| `send_message` | sync.rs | message_id |
| `check_incoming` | sync.rs | - |
| `check_acks` | sync.rs | - |
| `sync` | sync.rs | - |
| `sync_messages` | daemon.rs | - |
| `start_syftbox` | daemon.rs | - |
| `ensure_syftbox_running` | daemon.rs | - |
| `run` | daemon.rs | - |
| `create` | pipeline.rs | pipeline_name |
| `run_pipeline` | pipeline.rs | pipeline, dry_run, resume |
| `validate` | pipeline.rs | pipeline |

---

### Enabling Tracing

To enable tracing in any component, set the following environment variables:

```bash
# Required - enables tracing
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"

# Optional - sets service name in traces
export OTEL_SERVICE_NAME="my-service-name"
```

Example with Jaeger:

```bash
# Start Jaeger
./scripts/start-jaeger.sh

# Run desktop app with tracing
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=biovault-desktop-1 \
npm run tauri dev

# View traces at http://localhost:16686
```

Example with test-scenario-obs.sh:

```bash
# Run tests with Jaeger tracing
./test-scenario-obs.sh messaging
```

---

### Trace Flow Example

A typical message send operation produces the following trace:

```
[biovault-desktop-1]
└── command (ws_bridge.rs)
    └── send_message (sync.rs)
        └── create_request (rpc.rs)
            └── create_request (endpoint.rs)
                └── write_encrypted_with_shadow (storage.rs)
```

A message receive operation:

```
[biovault-desktop-2]
└── sync (sync.rs)
    └── check_incoming (sync.rs)
        └── check_requests (rpc.rs)
            └── check_requests (endpoint.rs)
                └── read_with_shadow_metadata (storage.rs)
```

---

## References

- [SigNoz Documentation](https://signoz.io/docs/)
- [OpenTelemetry Rust SDK](https://github.com/open-telemetry/opentelemetry-rust)
- [OpenTelemetry Python SDK](https://opentelemetry-python.readthedocs.io/)
- [Tracing Crate](https://docs.rs/tracing/latest/tracing/)
