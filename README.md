<p align="center">
  <h1 align="center">Portkey vs Bedrock Latency Benchmark</h1>
  <p align="center">
    <strong>Measure the real-world latency overhead of routing requests through Portkey</strong>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="Node Version">
  <img src="https://img.shields.io/badge/dependencies-zero-blue" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

---

## Quick Start

### Prerequisites

- **Node.js 18+** (uses native `fetch`, zero npm dependencies)
- AWS Bedrock access (Bearer token)
- Portkey API key

### Step 1: Clone & Setup

```bash
git clone <repo-url>
cd benchmark-test
cp config.example.json config.json
```

### Step 2: Add Your Credentials

Open `config.json` and edit these fields:

```json
{
  "amazonRegion": "us-east-1",
  "bedrockBearerToken": "...",
  "portkeyApiKey": "...",
  "portkeyProviderSlug": "@your-bedrock-slug"
}
```

<details>
<summary><strong>AWS Bedrock Bearer Token</strong></summary>

This tool uses HTTP Bearer auth (not IAM access keys).

**From AWS SSO Portal:**
1. Log into your organization's AWS SSO
2. Select your Bedrock-enabled account
3. Choose "Command line or programmatic access"
4. Copy the Bearer token

**From AWS CLI:**
```bash
aws sts get-session-token --duration-seconds 3600
```

> Set `amazonRegion` to match where your Bedrock model is deployed (e.g., `us-east-1`, `us-west-2`)

</details>

<details>
<summary><strong>Portkey API Key</strong></summary>

1. Log in to [app.portkey.ai](https://app.portkey.ai/)
2. Click **API Keys** in the left sidebar
3. Copy your API key

</details>

<details>
<summary><strong>Provider Slug</strong></summary>

1. Log in to [app.portkey.ai](https://app.portkey.ai/)
2. Go to **Models** in the left sidebar
3. You'll see a list of providers — copy the slug for the one you are using (e.g., `@bedrock-prod`)

</details>

---

### Step 3: Run

```bash
npm start
```

---

## Sample Output

```
AGGREGATED PERFORMANCE COMPARISON:
┌─────────────────────┬──────────────┬──────────────┬──────────────┐
│ Metric              │ Bedrock      │ Portkey      │ Difference   │
├─────────────────────┼──────────────┼──────────────┼──────────────┤
│ Avg Total Time      │  1104.71ms   │  1197.87ms   │   +93.16ms   │
│ Median Time         │   949.00ms   │   974.00ms   │   +25.00ms   │
│ P95 Time            │  1999.95ms   │  2276.00ms   │  +276.05ms   │
│ P99 Time            │  2487.62ms   │  2624.08ms   │  +136.46ms   │
│ Success Rate        │      96.0%   │      89.0%   │     -7.0%    │
└─────────────────────┴──────────────┴──────────────┴──────────────┘

KEY INSIGHTS:
• Portkey adds an average of 93.16ms latency (8.4% overhead)
• Median overhead: 25.00ms
```

Results are saved to `results/benchmark_results_<timestamp>.json`.

---

## Default Configuration

The benchmark comes pre-configured with these defaults:

| Setting | Default Value |
|---------|---------------|
| Model | `us.anthropic.claude-3-5-sonnet-20241022-v2:0` |
| Mode | `comparison` (Bedrock vs Portkey) |
| Prompt | `"What is the capital of France?"` |
| Max Tokens | `100` |
| Temperature | `0.7` |
| Concurrency | `2` workers |
| Max Requests | `3` per iteration |
| Iterations | `2` |

### Changing Models

To use a different model, update `bedrockModelId` and `model` in `config.json`:

```json
{
  "bedrockModelId": "us.anthropic.claude-3-haiku-20240307-v1:0",
  "model": "us.anthropic.claude-3-haiku-20240307-v1:0"
}
```

---

## Configuration Reference

<details>
<summary><strong>All Options</strong></summary>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `"comparison"` | `"comparison"` (Bedrock vs Portkey) or `"loadtest"` (Portkey only) |
| `prompt` | string | — | The prompt to send to the model |
| `maxTokens` | number | `100` | Maximum tokens in response |
| `temperature` | number | `0.7` | Model temperature |
| `concurrency` | number | `2` | Number of parallel request workers |
| `maxRequests` | number | `3` | Total requests per iteration |
| `testDuration` | number | `60` | Maximum test duration (seconds) |
| `iterations` | number | `2` | Number of test runs to average |

</details>

<details>
<summary><strong>Credentials</strong></summary>

| Credential | Required For | Description |
|------------|--------------|-------------|
| `bedrockBearerToken` | `comparison` mode | AWS Bearer token with Bedrock invoke permissions |
| `portkeyApiKey` | Both modes | Your Portkey API key |
| `amazonRegion` | Both modes | AWS region (e.g., `us-east-1`) |
| `bedrockModelId` | Both modes | Model ID for Bedrock |
| `portkeyProviderSlug` | Both modes | Provider slug (e.g., `@bedrock-prod`) |

</details>

---

## How It Works

```
1. PREFLIGHT    Validate credentials, test connectivity
       ↓
2. WARMUP       5 requests per provider (establish connections)
       ↓
3. BENCHMARK    Concurrent workers fire parallel requests
       ↓         - Randomized order eliminates bias
       ↓         - Measures total round-trip time
       ↓
4. AGGREGATE    Calculate avg, median, P95, P99
       ↓
5. REPORT       Console summary + JSON artifact
```

---

## Understanding Overhead

The latency overhead represents round-trip network latency through the proxy:

```
Direct Bedrock:     Client → Bedrock → Client
                           (1 hop each direction)

Through Portkey:    Client → Portkey → Bedrock → Portkey → Client
                           (2 hops each direction)
```

**Typical overhead: ~50-150ms** depending on geographic distance and network conditions.

### When Portkey Shows Lower Latency than Direct Bedrock 

This can happen due to:
- **Network variance** — With fewer iterations, jitter can skew results. Run 10+ iterations for accuracy.
- **Connection reuse** — Portkey maintains persistent connections, reducing handshake overhead.

---

## Test Modes

| Mode | Description |
|------|-------------|
| `comparison` | Bedrock vs Portkey side-by-side |
| `loadtest` | Portkey only (stress test) |

```json
{
  "mode": "loadtest"
}
```

---

## Project Structure

```
benchmark-test/
├── benchmark.js         # Main benchmark script
├── config.example.json  # Template configuration
├── config.json          # Your configuration (gitignored)
├── results/             # Output directory (gitignored)
└── README.md
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.