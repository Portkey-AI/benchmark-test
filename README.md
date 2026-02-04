<p align="center">
  <h1 align="center">⚡ Portkey vs Bedrock Latency Benchmark</h1>
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

## What This Does

This benchmark tool provides **accurate, production-grade latency comparisons** between:

| Direct Bedrock | vs | Through Portkey |
|:---:|:---:|:---:|
| Your App → AWS Bedrock | | Your App → Portkey → AWS Bedrock |

**Key Metrics Measured:**
- Round-trip latency (avg, median, P95, P99)
- Success rates
- Request throughput
- Network vs inference time breakdown

---

## 🚀 Quick Start (2 minutes)

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

Edit `config.json` with your API keys:

```json
{
  "bedrockBearerToken": "YOUR_AWS_BEARER_TOKEN",
  "portkeyApiKey": "YOUR_PORTKEY_API_KEY",
  "portkeyProviderSlug": "@your-virtual-key"
}
```

### Step 3: Run

```bash
npm start
```

That's it! Results will display in your terminal and save to `results/`.

---

## ⚙️ Configuration Reference

<details>
<summary><strong>📋 Full Configuration Options</strong> (click to expand)</summary>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| **`mode`** | string | `"comparison"` | `"comparison"` (Bedrock vs Portkey) or `"loadtest"` (Portkey only) |
| **`prompt`** | string | — | The prompt to send to the model |
| **`maxTokens`** | number | `100` | Maximum tokens in response |
| **`temperature`** | number | `0.7` | Model temperature |
| **`concurrency`** | number | `2` | Number of parallel request workers |
| **`maxRequests`** | number | `30` | Total requests before stopping |
| **`testDuration`** | number | `60` | Maximum test duration (seconds) |
| **`iterations`** | number | `10` | Number of test runs to average |

</details>

<details>
<summary><strong>🔐 Required Credentials</strong> (click to expand)</summary>

| Credential | Required For | Description |
|------------|--------------|-------------|
| **`bedrockBearerToken`** | `comparison` mode | AWS Bearer token with Bedrock invoke permissions |
| **`portkeyApiKey`** | Both modes | Your Portkey API key |
| **`amazonRegion`** | Both modes | AWS region (e.g., `us-east-1`) |
| **`bedrockModelId`** | Both modes | Model ID (e.g., `us.anthropic.claude-3-5-sonnet-20241022-v2:0`) |
| **`portkeyProviderSlug`** | Optional | Virtual key slug (e.g., `@bedrock-prod`) for routing |
| **`portkeyBaseURL`** | Optional | Defaults to `https://api.portkey.ai/v1` |

</details>

---

## 🔑 Getting Your API Keys

<details>
<summary><strong>Portkey API Key</strong></summary>

1. Log in to the [Portkey Dashboard](https://app.portkey.ai/)
2. Navigate to **Settings** → **API Keys** (bottom-left sidebar)
3. Copy your API key

</details>

<details>
<summary><strong>AWS Bedrock Bearer Token</strong></summary>

This tool uses raw HTTP requests with Bearer token authentication.

**Option A: AWS SSO**
- Obtain from your organization's AWS SSO portal

**Option B: AWS CLI Session Token**
```bash
aws sts get-session-token --duration-seconds 3600
```

> ⚠️ Ensure your token has `bedrock:InvokeModel` permission for the model you're testing.

</details>

<details>
<summary><strong>Portkey Virtual Keys (Provider Slug)</strong></summary>

Virtual keys let you store provider credentials in Portkey securely.

1. Go to [Portkey Dashboard](https://app.portkey.ai/) → **Virtual Keys**
2. Create a new key for AWS Bedrock
3. Copy the slug (e.g., `@bedrock-prod`)
4. Add to config: `"portkeyProviderSlug": "@bedrock-prod"`

This routes requests through your stored Bedrock credentials.

</details>

---

## 📊 Understanding the Output

### Real-Time Progress

```
📡 Worker 1 - Request 5 starting...
📊 Worker 1 - Request 5 completed in 450ms | Bedrock: ✅ 420ms | Portkey: ✅ 440ms
```

### Final Summary Report

```
📈 AGGREGATED PERFORMANCE COMPARISON:
┌─────────────────────┬──────────────┬──────────────┬─────────────┐
│ Metric              │ Bedrock      │ Portkey      │ Difference  │
├─────────────────────┼──────────────┼──────────────┼─────────────┤
│ Avg Total Time      │ 420.50ms     │ 435.20ms     │ +14.70ms    │
│ Median Time         │ 415.00ms     │ 428.00ms     │ +13.00ms    │
│ P95 Time            │ 520.00ms     │ 535.00ms     │ +15.00ms    │
│ P99 Time            │ 680.00ms     │ 695.00ms     │ +15.00ms    │
│ Success Rate        │ 100.0%       │ 100.0%       │ +0.0%       │
└─────────────────────┴──────────────┴──────────────┴─────────────┘

🎯 KEY INSIGHTS:
• Portkey adds an average of 14.70ms latency (3.5% overhead)
• Median overhead: 13.00ms
• 100% success rate for both providers
```

### JSON Artifacts

Detailed results are automatically saved to `results/`:
```
results/benchmark_results_2024-02-04T12-00-00.json
```

---

## 🧠 How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        BENCHMARK FLOW                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. PREFLIGHT    Validate credentials, test connectivity       │
│         ↓                                                       │
│  2. WARMUP       5 requests per provider (establish connections)│
│         ↓                                                       │
│  3. BENCHMARK    Concurrent workers fire parallel requests      │
│         ↓        - Randomized order eliminates bias             │
│         ↓        - Measures total round-trip time               │
│         ↓        - Extracts server processing time if available │
│         ↓                                                       │
│  4. AGGREGATE    Calculate avg, median, P95, P99 across all     │
│         ↓        iterations                                     │
│         ↓                                                       │
│  5. REPORT       Console summary + JSON artifact                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Why Parallel Requests?**
- Eliminates "first request" bias from connection pooling
- Mirrors real production traffic patterns
- Provides fair comparison between providers

---

## 🧪 Test Modes

| Mode | What It Tests | Use Case |
|------|---------------|----------|
| `comparison` | Bedrock vs Portkey side-by-side | Measure Portkey overhead |
| `loadtest` | Portkey only | Stress test your Portkey setup |

Switch modes in `config.json`:
```json
{
  "mode": "loadtest"
}
```

---

## 📁 Project Structure

```
benchmark-test/
├── benchmark.js         # Main benchmark script
├── config.example.json  # Template configuration
├── config.json          # Your configuration (gitignored)
├── package.json         # Project metadata
├── results/             # Output directory (gitignored)
│   └── .gitkeep
├── .gitignore
├── LICENSE
└── README.md
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.