import fs from 'fs';
import crypto from 'crypto';
// Using direct HTTP requests (fetch) for all providers

// AWS Signature V4 signing helpers
function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function sha256(data, encoding = 'hex') {
  return crypto.createHash('sha256').update(data).digest(encoding);
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

// URL encode path segment according to AWS SigV4 rules
// Unreserved characters (A-Z, a-z, 0-9, hyphen, underscore, period, tilde) are not encoded
// Everything else including colon must be percent-encoded
function uriEncodePathSegment(segment) {
  let encoded = '';
  for (const char of segment) {
    if (
      (char >= 'A' && char <= 'Z') ||
      (char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '-' ||
      char === '_' ||
      char === '.' ||
      char === '~'
    ) {
      encoded += char;
    } else {
      // Percent-encode the character
      const bytes = Buffer.from(char, 'utf8');
      for (const byte of bytes) {
        encoded += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return encoded;
}

// Encode entire path (preserving /)
function uriEncodePath(path) {
  return path.split('/').map(uriEncodePathSegment).join('/');
}

function createAwsSigV4Headers(method, url, body, credentials, region, service) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;

  // URL encode the path for canonical request - important for model IDs with colons
  const canonicalPath = uriEncodePath(parsedUrl.pathname);


  const now = new Date();
  // Format: 20260204T163400Z (removes dashes, colons, and milliseconds)
  const isoDate = now.toISOString();
  const amzDate = isoDate.replace(/-/g, '').replace(/:/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.substring(0, 8);

  // Create canonical request
  const payloadHash = sha256(body);

  // Headers must be in alphabetical order
  let signedHeaders = 'content-type;host;x-amz-date';
  let canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;

  if (sessionToken) {
    signedHeaders = 'content-type;host;x-amz-date;x-amz-security-token';
    canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-security-token:${sessionToken}\n`;
  }

  const canonicalRequest = [
    method,
    canonicalPath,
    '', // query string (empty for POST)
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');

  // Calculate signature
  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign, 'hex');

  // Create authorization header
  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    'Content-Type': 'application/json',
    'Host': host,
    'X-Amz-Date': amzDate,
    'Authorization': authorization
  };

  if (sessionToken) {
    headers['X-Amz-Security-Token'] = sessionToken;
  }

  return headers;
}


class PortkeyBenchmark {
  constructor(config) {
    this.config = config;
    this.results = {
      bedrock: [],
      portkey: []
    };

    // Determine which providers to enable based on mode
    this.determineProvidersFromMode();

    // Bedrock configuration
    if (this.shouldTestBedrock) {
      this.bedrockEndpoint = `https://bedrock-runtime.${config.amazonRegion}.amazonaws.com/model/${config.bedrockModelId}/invoke`;
    }

    // Portkey configuration (using fetch, no SDK)
    if (this.shouldTestPortkey) {
      this.portkeyBaseURL = config.portkeyBaseURL || 'https://api.portkey.ai/v1';
      this.portkeyHeaders = {
        'Content-Type': 'application/json',
        'x-portkey-api-key': config.portkeyApiKey
      };

      // Add provider header if specified
      if (config.portkeyProviderSlug) {
        this.portkeyHeaders['x-portkey-provider'] = config.portkeyProviderSlug;
      }
    }
  }

  determineProvidersFromMode() {
    const mode = this.config.mode || 'comparison';

    switch (mode) {
      case 'comparison':
        this.shouldTestBedrock = true;
        this.shouldTestPortkey = true;
        break;
      case 'loadtest':
        this.shouldTestBedrock = false;
        this.shouldTestPortkey = true;
        break;
      default:
        throw new Error(`Invalid mode: ${mode}. Supported modes: comparison, loadtest`);
    }
  }

  async makeBedrockRequest(prompt, provider) {
    const startTime = Date.now();

    try {
      // Use exact same format as working bedrock-test.js
      let content;
      if (typeof prompt === 'string') {
        content = prompt;
      } else {
        // Extract content from last message for multi-message prompts
        content = prompt[prompt.length - 1].content;
      }

      const requestBody = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: this.config.maxTokens || 100,
        messages: [{
          role: "user",
          content: [{ type: "text", text: content }]
        }],
        temperature: this.config.temperature || 0.7
      };

      const endpoint = `https://bedrock-runtime.${this.config.amazonRegion}.amazonaws.com/model/${this.config.bedrockModelId}/invoke`;
      const bodyString = JSON.stringify(requestBody);

      // Determine authentication method: Access Key (SigV4) vs Bearer Token
      let headers;
      if (this.config.awsAccessKeyId && this.config.awsSecretAccessKey) {
        // Use AWS Signature V4 signing
        headers = createAwsSigV4Headers(
          'POST',
          endpoint,
          bodyString,
          {
            accessKeyId: this.config.awsAccessKeyId,
            secretAccessKey: this.config.awsSecretAccessKey,
            sessionToken: this.config.awsSessionToken // Optional
          },
          this.config.amazonRegion,
          'bedrock'
        );
      } else if (this.config.bedrockBearerToken) {
        // Use Bearer token authentication
        headers = {
          'Authorization': `Bearer ${this.config.bedrockBearerToken}`,
          'Content-Type': 'application/json'
        };
      } else {
        throw new Error('No Bedrock authentication configured. Provide either awsAccessKeyId + awsSecretAccessKey, or bedrockBearerToken.');
      }

      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: bodyString
        });
      } catch (fetchError) {
        // Network-level error (DNS, connection refused, TLS, etc.)
        throw new Error(`Network error connecting to Bedrock: ${fetchError.message}. Endpoint: ${endpoint}`);
      }

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      return {
        provider,
        totalTime,
        openaiProcessingTime: null,
        networkLatency: null,
        timestamp: new Date().toISOString(),
        success: true,
        tokensUsed: result.usage?.total_tokens || 0,
        promptTokens: result.usage?.input_tokens || 0,
        completionTokens: result.usage?.output_tokens || 0
      };
    } catch (error) {
      const endTime = Date.now();
      const totalTime = endTime - startTime;

      return {
        provider,
        totalTime,
        openaiProcessingTime: null,
        networkLatency: null,
        timestamp: new Date().toISOString(),
        success: false,
        error: error.message,
        errorType: 'bedrock_error',
        tokensUsed: 0,
        promptTokens: 0,
        completionTokens: 0
      };
    }
  }

  async makePortkeyRequest(prompt, provider) {
    const startTime = Date.now();

    try {
      // Handle both string prompts and message objects
      let messages;
      if (typeof prompt === 'string') {
        messages = [{ role: 'user', content: prompt }];
      } else if (Array.isArray(prompt)) {
        messages = prompt;
      } else {
        // Extract content from last message for multi-message prompts
        messages = [{ role: 'user', content: prompt[prompt.length - 1].content }];
      }

      const requestBody = {
        model: this.config.model || this.config.bedrockModelId || 'claude-3-sonnet-20240229',
        messages,
        max_tokens: this.config.maxTokens || 100,
        temperature: this.config.temperature || 0.7
      };

      const endpoint = `${this.portkeyBaseURL}/chat/completions`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.portkeyHeaders,
        body: JSON.stringify(requestBody)
      });

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      // Extract OpenAI processing time from headers if available
      const openaiProcessingTime = this.extractOpenAIProcessingTime(response);

      return {
        provider,
        totalTime,
        openaiProcessingTime,
        networkLatency: openaiProcessingTime ? totalTime - openaiProcessingTime : null,
        timestamp: new Date().toISOString(),
        success: true,
        tokensUsed: result.usage?.total_tokens || 0,
        promptTokens: result.usage?.prompt_tokens || 0,
        completionTokens: result.usage?.completion_tokens || 0
      };
    } catch (error) {
      const endTime = Date.now();
      const totalTime = endTime - startTime;

      // Log specific error types for debugging
      let errorType = 'unknown';
      if (error.message.includes('rate limit') || error.message.includes('429')) {
        errorType = 'rate_limit';
      } else if (error.message.includes('timeout') || error.message.includes('ECONNRESET')) {
        errorType = 'timeout';
      } else if (error.message.includes('ECONNREFUSED')) {
        errorType = 'connection_refused';
      }

      return {
        provider,
        totalTime,
        openaiProcessingTime: null,
        networkLatency: null,
        timestamp: new Date().toISOString(),
        success: false,
        error: error.message,
        errorType,
        tokensUsed: 0,
        promptTokens: 0,
        completionTokens: 0
      };
    }
  }

  extractOpenAIProcessingTime(response) {
    // The response passed in is the raw HTTP response object
    // OpenAI returns processing time in various header formats
    const headers = response?.headers;

    if (!headers) {
      return null;
    }

    // Common header names for processing time (in order of preference)
    const processingTimeHeaders = [
      'openai-processing-ms',
      'x-openai-processing-ms',
      'openai-processing-time-ms',
      'x-processing-time-ms',
      'processing-time-ms',
      'x-request-time-ms',
      'x-processing-time',
      'x-request-time',
      'request-time',
      'processing-time'
    ];

    // Try each header name
    for (const header of processingTimeHeaders) {
      const value = headers.get ? headers.get(header) : headers[header];
      if (value !== undefined && value !== null) {
        const timeMs = parseFloat(value);
        if (!isNaN(timeMs) && timeMs > 0) {
          return timeMs;
        }
      }
    }

    // Try case-insensitive search as backup
    if (headers.entries) {
      for (const [key, value] of headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('processing') && (lowerKey.includes('ms') || lowerKey.includes('time'))) {
          const timeMs = parseFloat(value);
          if (!isNaN(timeMs) && timeMs > 0) {
            return timeMs;
          }
        }
      }
    }

    return null;
  }

  async runWarmup() {
    console.log('🔥 Running warmup phase...');
    const warmupRequests = 5;

    for (let i = 0; i < warmupRequests; i++) {
      console.log(`  Warmup ${i + 1}/${warmupRequests}...`);

      // Randomize order for warmup too
      const testBedrockFirst = Math.random() < 0.5;

      if (testBedrockFirst) {
        if (this.shouldTestBedrock) {
          await this.makeBedrockRequest(this.config.prompt, 'bedrock');
        }
        if (this.shouldTestPortkey) {
          await this.makePortkeyRequest(this.config.prompt, 'portkey');
        }
      } else {
        if (this.shouldTestPortkey) {
          await this.makePortkeyRequest(this.config.prompt, 'portkey');
        }
        if (this.shouldTestBedrock) {
          await this.makeBedrockRequest(this.config.prompt, 'bedrock');
        }
      }

      // Small delay between warmup requests
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('✅ Warmup complete\n');
  }

  async runPreflightTest() {
    console.log('🧪 Running preflight test...');
    console.log(`Mode: ${this.config.mode || 'comparison'}`);

    const testPrompt = typeof this.config.prompt === 'string'
      ? this.config.prompt.substring(0, 100) + (this.config.prompt.length > 100 ? '...' : '')
      : this.config.prompt;

    const testResults = {
      bedrock: null,
      portkey: null
    };

    // Test OpenAI (only if enabled for this mode)
    // if (this.shouldTestOpenAI) {
    //   console.log('📡 Testing OpenAI connection...');
    //   try {
    //     const openaiResult = await this.makeRequest(this.openaiClient, testPrompt, 'openai');
    //     if (openaiResult.success) {
    //       console.log(`✅ OpenAI test successful (${openaiResult.totalTime}ms)`);

    //       // Check if we can extract OpenAI processing time
    //       if (openaiResult.openaiProcessingTime !== null) {
    //         console.log(`✅ OpenAI processing time extracted: ${openaiResult.openaiProcessingTime}ms`);
    //       } else {
    //         console.log(`⚠️  OpenAI processing time not available in response headers`);
    //         console.log(`   Network latency calculation will be limited`);
    //       }

    //       testResults.openai = openaiResult;
    //     } else {
    //       console.log(`❌ OpenAI test failed: ${openaiResult.error}`);
    //       testResults.openai = openaiResult;
    //     }
    //   } catch (error) {
    //     console.log(`❌ OpenAI test failed with exception:`);
    //     console.log(`Error: ${error.message}`);
    //     if (error.response) {
    //       console.log(`Status: ${error.response.status}`);
    //       console.log(`Response: ${JSON.stringify(error.response.data, null, 2)}`);
    //     }
    //     console.log(`Stack: ${error.stack}`);
    //     testResults.openai = { success: false, error: error.message, fullError: error };
    //   }
    // } else {
    //   console.log('⏭️  Skipping OpenAI test (not enabled for this mode)');
    // }

    if (this.shouldTestBedrock) {
      console.log('📡 Testing Bedrock connection...');
      try {
        const startTime = Date.now();
        const endpoint = `https://bedrock-runtime.${this.config.amazonRegion}.amazonaws.com/model/${this.config.bedrockModelId}/invoke`;

        // Use exact same format as working bedrock-test.js
        const content = typeof testPrompt === 'string' ? testPrompt : testPrompt[testPrompt.length - 1].content;

        const requestBody = {
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 100,
          messages: [{
            role: "user",
            content: [{ type: "text", text: content }]
          }],
          temperature: 0.7
        };
        const bodyString = JSON.stringify(requestBody);

        // Determine authentication method: Access Key (SigV4) vs Bearer Token
        let headers;
        if (this.config.awsAccessKeyId && this.config.awsSecretAccessKey) {
          // Use AWS Signature V4 signing
          headers = createAwsSigV4Headers(
            'POST',
            endpoint,
            bodyString,
            {
              accessKeyId: this.config.awsAccessKeyId,
              secretAccessKey: this.config.awsSecretAccessKey,
              sessionToken: this.config.awsSessionToken // Optional
            },
            this.config.amazonRegion,
            'bedrock'
          );
          console.log('   Using AWS Access Key authentication (SigV4)');
          console.log(`   Access Key ID: ${this.config.awsAccessKeyId.substring(0, 8)}...`);
          console.log(`   Region: ${this.config.amazonRegion}`);
          console.log(`   Endpoint: ${endpoint}`);
        } else if (this.config.bedrockBearerToken) {
          // Use Bearer token authentication
          headers = {
            'Authorization': `Bearer ${this.config.bedrockBearerToken}`,
            'Content-Type': 'application/json'
          };
          console.log('   Using Bearer token authentication');
        } else {
          throw new Error('No Bedrock authentication configured. Provide either awsAccessKeyId + awsSecretAccessKey, or bedrockBearerToken.');
        }

        let response;
        try {
          console.log('   Sending request...');
          response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: bodyString
          });
          console.log(`   Response received: HTTP ${response.status}`);
        } catch (fetchError) {
          console.log(`   ❌ Fetch failed with error type: ${fetchError.constructor.name}`);
          console.log(`   Error code: ${fetchError.code || 'N/A'}`);
          console.log(`   Error cause: ${fetchError.cause ? JSON.stringify(fetchError.cause) : 'N/A'}`);
          throw new Error(`Network error: ${fetchError.message}. Endpoint: ${endpoint}`);
        }

        const totalTime = Date.now() - startTime;

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json();

        testResults.bedrock = {
          success: true,
          totalTime,
          openaiProcessingTime: null,
          networkLatency: null,
          timestamp: new Date().toISOString(),
          tokensUsed: result.usage?.total_tokens || 0,
          promptTokens: result.usage?.input_tokens || 0,
          completionTokens: result.usage?.output_tokens || 0
        };

        console.log(`✅ Bedrock test successful (${totalTime}ms)`);
      } catch (error) {
        console.log(`❌ Bedrock test failed: ${error.message}`);
        testResults.bedrock = { success: false, error: error.message };
      }
    } else {
      console.log('⏭️  Skipping Bedrock test (not enabled for this mode)');
    }

    // Test Portkey (only if enabled for this mode)
    if (this.shouldTestPortkey) {
      console.log('📡 Testing Portkey connection...');
      try {
        const portkeyResult = await this.makePortkeyRequest(testPrompt, 'portkey');
        if (portkeyResult.success) {
          console.log(`✅ Portkey test successful (${portkeyResult.totalTime}ms)`);

          testResults.portkey = portkeyResult;
        } else {
          console.log(`❌ Portkey test failed: ${portkeyResult.error}`);
          testResults.portkey = portkeyResult;
        }
      } catch (error) {
        console.log(`❌ Portkey test failed with exception:`);
        console.log(`Error: ${error.message}`);
        if (error.response) {
          console.log(`Status: ${error.response.status}`);
          console.log(`Response: ${JSON.stringify(error.response.data, null, 2)}`);
        }
        console.log(`Stack: ${error.stack}`);
        testResults.portkey = { success: false, error: error.message, fullError: error };
      }
    } else {
      console.log('⏭️  Skipping Portkey test (not enabled for this mode)');
    }

    // Evaluate results based on mode
    const bedrockSuccess = testResults.bedrock && testResults.bedrock.success;
    const portkeySuccess = testResults.portkey && testResults.portkey.success;

    // Check if any enabled provider failed
    const enabledProviders = [];
    const failedProviders = [];

    if (this.shouldTestBedrock) {
      enabledProviders.push('Bedrock');
      if (!bedrockSuccess) failedProviders.push('Bedrock');
    }

    if (this.shouldTestPortkey) {
      enabledProviders.push('Portkey');
      if (!portkeySuccess) failedProviders.push('Portkey');
    }

    if (failedProviders.length === enabledProviders.length) {
      throw new Error(`All enabled providers failed (${failedProviders.join(', ')}). Please check your configuration and API keys.`);
    }

    if (failedProviders.length > 0) {
      throw new Error(`Some providers failed: ${failedProviders.join(', ')}. Aborting test...`);
    }



    console.log('✅ Preflight test completed successfully!\n');

    return {
      bedrockEnabled: this.shouldTestBedrock && bedrockSuccess,
      portkeyEnabled: this.shouldTestPortkey && portkeySuccess,
      testResults
    };
  }

  async runSingleIteration(iterationNumber, totalIterations) {
    const mode = this.config.mode || 'comparison';
    const modeDisplayNames = {
      'comparison': 'Portkey Latency Comparison',
      'loadtest': 'Portkey Load Test'
    };

    if (totalIterations > 1) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔄 ITERATION ${iterationNumber}/${totalIterations}`);
      console.log(`${'='.repeat(60)}`);
    }

    console.log(`🚀 Starting ${modeDisplayNames[mode] || 'Benchmark'}`);
    console.log(`Configuration:
    - Mode: ${mode}
    - Model: ${this.config.bedrockModelId || this.config.model || 'claude-3-sonnet'}
    - Concurrency: ${this.config.concurrency}
    - Max Requests: ${this.config.maxRequests}
    - Test Duration: ${this.config.testDuration}s
    - Prompt: ${typeof this.config.prompt === 'string' ? `"${this.config.prompt.substring(0, 50)}..."` : `${this.config.prompt.length} message(s)`}
    - Providers: ${[this.shouldTestBedrock && 'Bedrock', this.shouldTestPortkey && 'Portkey'].filter(Boolean).join(', ')}
    `);

    const promises = [];
    const startTime = Date.now();

    // Shared state for coordinating between workers
    this.sharedState = {
      requestCount: 0,
      shouldStop: false,
      maxRequestsReached: false,
      timeLimit: false
    };

    console.log('⏳ Starting concurrent request workers...');

    // Create a pool of concurrent requests
    for (let i = 0; i < this.config.concurrency; i++) {
      promises.push(this.runConcurrentRequests(startTime, i));
    }

    await Promise.all(promises);

    // Show completion summary
    const finalTime = (Date.now() - startTime) / 1000;
    const totalRequests = Math.max(this.results.bedrock.length, this.results.portkey.length);

    console.log('\n' + '='.repeat(50));
    console.log('✅ Benchmark completed!');
    console.log(`📊 Final Stats:`);
    console.log(`   • Total requests started: ${this.sharedState.requestCount}`);
    console.log(`   • Total requests completed: ${totalRequests}`);
    console.log(`   • Duration: ${finalTime.toFixed(2)}s`);
    console.log(`   • Average rate: ${(totalRequests / finalTime).toFixed(2)} requests/sec`);

    if (this.sharedState.maxRequestsReached) {
      console.log(`🎯 Stopped: Max requests limit reached (${this.config.maxRequests})`);
    } else if (this.sharedState.timeLimit) {
      console.log(`⏰ Stopped: Time limit reached (${this.config.testDuration}s)`);
    } else {
      console.log(`🏁 Stopped: All workers completed naturally`);
    }
    console.log('='.repeat(50));

    // Return results for this iteration instead of generating report immediately
    return {
      bedrockResults: [...this.results.bedrock],
      portkeyResults: [...this.results.portkey],
      duration: finalTime,
      totalRequests
    };
  }

  async runBenchmark() {
    const iterations = this.config.iterations || 1;
    const allIterationResults = [];

    for (let i = 1; i <= iterations; i++) {
      // Reset results for each iteration
      this.results = {
        bedrock: [],
        portkey: []
      };

      // Run preflight test only on first iteration
      if (i === 1) {
        const preflightResults = await this.runPreflightTest();
        this.bedrockEnabled = preflightResults.bedrockEnabled;
        this.portkeyEnabled = preflightResults.portkeyEnabled;

        // Run warmup phase only on first iteration
        await this.runWarmup();
      } else {
        console.log('⏭️  Skipping preflight and warmup for iteration', i);
      }

      // Run single iteration
      const iterationResult = await this.runSingleIteration(i, iterations);
      allIterationResults.push(iterationResult);

      // Small delay between iterations
      if (i < iterations) {
        console.log('\n⏸️  Waiting 2 seconds before next iteration...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Generate combined report
    this.generateIterationsReport(allIterationResults);
  }

  async runConcurrentRequests(startTime, workerId) {
    console.log(`🔄 Worker ${workerId + 1} started`);

    while (true) {
      // Check shared stopping conditions first
      if (this.sharedState.shouldStop) {
        console.log(`🛑 Worker ${workerId + 1} stopping: Stop signal received`);
        break;
      }

      const currentTime = Date.now();
      const elapsedTime = (currentTime - startTime) / 1000;

      // Check if we've exceeded time limit
      if (this.config.testDuration && elapsedTime >= this.config.testDuration) {
        console.log(`⏰ Worker ${workerId + 1} stopping: Time limit reached`);
        this.sharedState.shouldStop = true;
        this.sharedState.timeLimit = true;
        break;
      }

      // Atomic check and increment for max requests
      if (this.config.maxRequests && this.sharedState.requestCount >= this.config.maxRequests) {
        console.log(`🎯 Worker ${workerId + 1} stopping: Max requests reached`);
        this.sharedState.shouldStop = true;
        this.sharedState.maxRequestsReached = true;
        break;
      }

      // Increment request count atomically
      this.sharedState.requestCount++;
      const currentRequestNumber = this.sharedState.requestCount;

      // Double-check if we exceeded max requests after incrementing (race condition protection)
      if (this.config.maxRequests && currentRequestNumber > this.config.maxRequests) {
        console.log(`🎯 Worker ${workerId + 1} stopping: Exceeded max requests (${currentRequestNumber}/${this.config.maxRequests})`);
        this.sharedState.shouldStop = true;
        this.sharedState.maxRequestsReached = true;
        break;
      }

      console.log(`📡 Worker ${workerId + 1} - Request ${currentRequestNumber} starting...`);

      // Make requests in parallel to eliminate order bias and connection reuse issues
      const requestStartTime = Date.now();
      const requests = [];

      if (this.bedrockEnabled) {
        requests.push(this.makeBedrockRequest(this.config.prompt, 'bedrock'));
      }

      if (this.portkeyEnabled) {
        requests.push(this.makePortkeyRequest(this.config.prompt, 'portkey'));
      }

      const results = await Promise.all(requests);

      // Assign results based on which providers are enabled
      let bedrockResult = null;
      let portkeyResult = null;

      if (this.bedrockEnabled && this.portkeyEnabled) {
        [bedrockResult, portkeyResult] = results;
      } else if (this.bedrockEnabled) {
        [bedrockResult] = results;
      } else if (this.portkeyEnabled) {
        [portkeyResult] = results;
      }

      const requestEndTime = Date.now();
      const requestDuration = requestEndTime - requestStartTime;

      // Log results
      let logMessage = `📊 Worker ${workerId + 1} - Request ${currentRequestNumber} completed in ${requestDuration}ms`;

      if (bedrockResult) {
        const bedrockStatus = bedrockResult.success ? '✅' : '❌';
        logMessage += ` | Bedrock: ${bedrockStatus} ${bedrockResult.totalTime}ms`;
        this.results.bedrock.push(bedrockResult);
      }

      if (portkeyResult) {
        const portkeyStatus = portkeyResult.success ? '✅' : '❌';
        logMessage += ` | Portkey: ${portkeyStatus} ${portkeyResult.totalTime}ms`;
        this.results.portkey.push(portkeyResult);
      }

      console.log(logMessage);

      // Progress summary every 10 requests (only from worker 1 to avoid spam)
      if (currentRequestNumber % 10 === 0 && workerId === 0) {
        const totalRequests = Math.max(this.results.bedrock.length, this.results.portkey.length);
        let progressMessage = `📈 Progress: ${this.sharedState.requestCount} requests started, ${totalRequests} completed`;

        if (this.config.maxRequests) {
          progressMessage += ` (${Math.min(this.sharedState.requestCount, this.config.maxRequests)}/${this.config.maxRequests})`;
        }

        if (this.bedrockEnabled) {
          const successfulBedrock = this.results.bedrock.filter(r => r.success).length;
          progressMessage += ` | Bedrock: ${successfulBedrock}/${this.results.bedrock.length} success`;
        }

        if (this.portkeyEnabled) {
          const successfulPortkey = this.results.portkey.filter(r => r.success).length;
          const failedPortkey = this.results.portkey.filter(r => !r.success).length;
          progressMessage += ` | Portkey: ${successfulPortkey}/${this.results.portkey.length} success`;
          if (failedPortkey > 0) {
            progressMessage += ` (${failedPortkey} failed)`;
          }
        }

        console.log(progressMessage);
      }

      // Add delay to prevent overwhelming the APIs with jitter to avoid thundering herd
      const baseDelay = this.config.concurrency > 10 ? 500 : 300;
      const jitter = Math.random() * 100; // Add 0-100ms random jitter
      const delay = baseDelay + jitter;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    console.log(`🏁 Worker ${workerId + 1} finished`);
  }

  calculateStats(results) {
    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    if (successfulResults.length === 0) {
      return {
        count: 0,
        successRate: 0,
        failureRate: 100,
        avgTotalTime: 0,
        avgOpenAITime: 0,
        avgNetworkLatency: 0,
        medianTotalTime: 0,
        p95TotalTime: 0,
        p99TotalTime: 0,
        minTotalTime: 0,
        maxTotalTime: 0,
        totalTokens: 0,
        avgTokensPerRequest: 0
      };
    }

    const totalTimes = successfulResults.map(r => r.totalTime).sort((a, b) => a - b);
    const openaiTimes = successfulResults.map(r => r.openaiProcessingTime).filter(t => t !== null);
    const networkLatencies = successfulResults.map(r => r.networkLatency).filter(l => l !== null);

    const totalTokens = successfulResults.reduce((sum, r) => sum + r.tokensUsed, 0);

    // Helper function for proper percentile calculation with interpolation
    const calculatePercentile = (sortedArray, percentile) => {
      if (sortedArray.length === 0) return 0;
      if (sortedArray.length === 1) return sortedArray[0];

      const index = (percentile / 100) * (sortedArray.length - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);

      if (lower === upper) {
        return sortedArray[lower];
      }

      // Linear interpolation
      const weight = index - lower;
      return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
    };

    return {
      count: results.length,
      successfulCount: successfulResults.length,
      failedCount: failedResults.length,
      successRate: (successfulResults.length / results.length) * 100,
      failureRate: (failedResults.length / results.length) * 100,
      avgTotalTime: totalTimes.reduce((sum, t) => sum + t, 0) / totalTimes.length,
      avgOpenAITime: openaiTimes.length > 0 ? openaiTimes.reduce((sum, t) => sum + t, 0) / openaiTimes.length : 0,
      avgNetworkLatency: networkLatencies.length > 0 ? networkLatencies.reduce((sum, l) => sum + l, 0) / networkLatencies.length : 0,
      medianTotalTime: calculatePercentile(totalTimes, 50),
      p95TotalTime: calculatePercentile(totalTimes, 95),
      p99TotalTime: calculatePercentile(totalTimes, 99),
      minTotalTime: totalTimes[0] || 0,
      maxTotalTime: totalTimes[totalTimes.length - 1] || 0,
      totalTokens,
      avgTokensPerRequest: totalTokens / successfulResults.length
    };
  }

  // Helper functions for consistent table formatting
  // Column width is 12 to match the 14-dash border (12 content + 2 for │ borders)
  formatMs(value, width = 12) {
    return `${value.toFixed(2)}ms`.padStart(width);
  }

  formatPct(value, width = 12) {
    return `${value.toFixed(1)}%`.padStart(width);
  }

  formatDiffMs(value, width = 12) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}ms`.padStart(width);
  }

  formatDiffPct(value, width = 12) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(1)}%`.padStart(width);
  }

  generateIterationsReport(allIterationResults) {
    const iterations = this.config.iterations || 1;

    if (iterations === 1) {
      // Single iteration - use old report format
      this.results = {
        bedrock: allIterationResults[0].bedrockResults,
        portkey: allIterationResults[0].portkeyResults
      };
      this.generateReport();
      return;
    }

    // Multiple iterations - aggregate results
    console.log('\n' + '='.repeat(60));
    console.log('📊 AGGREGATED RESULTS ACROSS ALL ITERATIONS');
    console.log('='.repeat(60));

    // Combine all results
    const allBedrockResults = allIterationResults.flatMap(r => r.bedrockResults);
    const allPortkeyResults = allIterationResults.flatMap(r => r.portkeyResults);

    // Calculate stats per iteration
    const iterationStats = allIterationResults.map((iteration, idx) => {
      const bedrockStats = this.calculateStats(iteration.bedrockResults);
      const portkeyStats = this.calculateStats(iteration.portkeyResults);

      return {
        iteration: idx + 1,
        bedrockStats,
        portkeyStats,
        overhead: portkeyStats.avgTotalTime - bedrockStats.avgTotalTime,
        medianOverhead: portkeyStats.medianTotalTime - bedrockStats.medianTotalTime
      };
    });

    // Calculate overall aggregated stats
    const aggregatedBedrockStats = this.calculateStats(allBedrockResults);
    const aggregatedPortkeyStats = this.calculateStats(allPortkeyResults);

    // Print per-iteration summary
    console.log('\n📈 PER-ITERATION SUMMARY:');
    console.log('┌───────────┬──────────────┬──────────────┬──────────────┬──────────────┐');
    console.log('│ Iteration │ Bedrock Avg  │ Portkey Avg  │ Avg Overhead │ Med Overhead │');
    console.log('├───────────┼──────────────┼──────────────┼──────────────┼──────────────┤');

    iterationStats.forEach(stat => {
      const iter = String(stat.iteration).padStart(4).padEnd(7);
      console.log(`│ ${iter}   │ ${this.formatMs(stat.bedrockStats.avgTotalTime)} │ ${this.formatMs(stat.portkeyStats.avgTotalTime)} │ ${this.formatDiffMs(stat.overhead)} │ ${this.formatDiffMs(stat.medianOverhead)} │`);
    });
    console.log('└───────────┴──────────────┴──────────────┴──────────────┴──────────────┘');

    // Calculate consistency metrics
    const overheads = iterationStats.map(s => s.overhead);
    const avgOverhead = overheads.reduce((a, b) => a + b, 0) / overheads.length;
    const minOverhead = Math.min(...overheads);
    const maxOverhead = Math.max(...overheads);
    const stdDev = Math.sqrt(overheads.map(x => Math.pow(x - avgOverhead, 2)).reduce((a, b) => a + b) / overheads.length);

    console.log('\n📊 CONSISTENCY METRICS:');
    console.log(`• Average overhead across iterations: ${avgOverhead.toFixed(2)}ms`);
    console.log(`• Min overhead: ${minOverhead.toFixed(2)}ms`);
    console.log(`• Max overhead: ${maxOverhead.toFixed(2)}ms`);
    console.log(`• Standard deviation: ${stdDev.toFixed(2)}ms`);
    console.log(`• Coefficient of variation: ${((stdDev / Math.abs(avgOverhead)) * 100).toFixed(2)}%`);

    // Print aggregated comparison
    const mode = this.config.mode || 'comparison';
    if (mode === 'comparison') {
      console.log('\n📈 AGGREGATED PERFORMANCE COMPARISON:');
      console.log('┌─────────────────────┬──────────────┬──────────────┬──────────────┐');
      console.log('│ Metric              │ Bedrock      │ Portkey      │ Difference   │');
      console.log('├─────────────────────┼──────────────┼──────────────┼──────────────┤');
      console.log(`│ Avg Total Time      │ ${this.formatMs(aggregatedBedrockStats.avgTotalTime)} │ ${this.formatMs(aggregatedPortkeyStats.avgTotalTime)} │ ${this.formatDiffMs(aggregatedPortkeyStats.avgTotalTime - aggregatedBedrockStats.avgTotalTime)} │`);
      console.log(`│ Median Time         │ ${this.formatMs(aggregatedBedrockStats.medianTotalTime)} │ ${this.formatMs(aggregatedPortkeyStats.medianTotalTime)} │ ${this.formatDiffMs(aggregatedPortkeyStats.medianTotalTime - aggregatedBedrockStats.medianTotalTime)} │`);
      console.log(`│ P95 Time            │ ${this.formatMs(aggregatedBedrockStats.p95TotalTime)} │ ${this.formatMs(aggregatedPortkeyStats.p95TotalTime)} │ ${this.formatDiffMs(aggregatedPortkeyStats.p95TotalTime - aggregatedBedrockStats.p95TotalTime)} │`);
      console.log(`│ P99 Time            │ ${this.formatMs(aggregatedBedrockStats.p99TotalTime)} │ ${this.formatMs(aggregatedPortkeyStats.p99TotalTime)} │ ${this.formatDiffMs(aggregatedPortkeyStats.p99TotalTime - aggregatedBedrockStats.p99TotalTime)} │`);
      console.log(`│ Success Rate        │ ${this.formatPct(aggregatedBedrockStats.successRate)} │ ${this.formatPct(aggregatedPortkeyStats.successRate)} │ ${this.formatDiffPct(aggregatedPortkeyStats.successRate - aggregatedBedrockStats.successRate)} │`);
      console.log('└─────────────────────┴──────────────┴──────────────┴──────────────┘');

      const aggregatedOverhead = aggregatedPortkeyStats.avgTotalTime - aggregatedBedrockStats.avgTotalTime;
      const aggregatedOverheadPct = (aggregatedOverhead / aggregatedBedrockStats.avgTotalTime) * 100;

      console.log('\n🎯 KEY INSIGHTS:');
      console.log(`• Total requests across all iterations: ${allBedrockResults.length}`);
      console.log(`• Aggregated average overhead: ${aggregatedOverhead.toFixed(2)}ms (${aggregatedOverheadPct.toFixed(2)}%)`);
      console.log(`• Aggregated median overhead: ${(aggregatedPortkeyStats.medianTotalTime - aggregatedBedrockStats.medianTotalTime).toFixed(2)}ms`);
      console.log(`• Overhead consistency (std dev): ${stdDev.toFixed(2)}ms`);
      console.log('');
      console.log('📍 WHAT THIS MEANS:');
      console.log('   The overhead represents round-trip network latency:');
      console.log('   Client → Portkey → Bedrock → Portkey → Client');
      console.log('   This includes 2 extra network hops compared to direct Bedrock calls.');
    }

    // Save detailed report
    const report = {
      timestamp: new Date().toISOString(),
      config: this.config,
      iterations: {
        count: iterations,
        perIterationStats: iterationStats,
        consistencyMetrics: {
          avgOverhead,
          minOverhead,
          maxOverhead,
          stdDev,
          coefficientOfVariation: (stdDev / Math.abs(avgOverhead)) * 100
        }
      },
      aggregated: {
        totalRequests: allBedrockResults.length,
        bedrockStats: aggregatedBedrockStats,
        portkeyStats: aggregatedPortkeyStats,
        comparison: mode === 'comparison' ? {
          latencyOverhead: aggregatedPortkeyStats.avgTotalTime - aggregatedBedrockStats.avgTotalTime,
          latencyOverheadPercentage: ((aggregatedPortkeyStats.avgTotalTime - aggregatedBedrockStats.avgTotalTime) / aggregatedBedrockStats.avgTotalTime) * 100,
          medianOverhead: aggregatedPortkeyStats.medianTotalTime - aggregatedBedrockStats.medianTotalTime,
          networkLatencyDiff: aggregatedPortkeyStats.avgNetworkLatency - aggregatedBedrockStats.avgNetworkLatency,
          successRateDiff: aggregatedPortkeyStats.successRate - aggregatedBedrockStats.successRate
        } : null
      },
      rawResults: {
        allIterations: allIterationResults.map((iteration, idx) => ({
          iteration: idx + 1,
          bedrock: iteration.bedrockResults,
          portkey: iteration.portkeyResults
        }))
      }
    };

    this.saveReport(report);
    console.log('\n💾 Detailed results with all iterations saved.');
  }

  generateReport() {
    const bedrockStats = this.calculateStats(this.results.bedrock);
    const portkeyStats = this.calculateStats(this.results.portkey);

    const summary = {
      totalRequests: Math.max(this.results.bedrock.length, this.results.portkey.length),
      bedrockStats,
      portkeyStats
    };

    // Only add comparison if both providers were tested
    const mode = this.config.mode || 'comparison';
    if (mode === 'comparison' && this.results.bedrock.length > 0 && this.results.portkey.length > 0) {
      summary.comparison = {
        latencyOverhead: portkeyStats.avgTotalTime - bedrockStats.avgTotalTime,
        latencyOverheadPercentage: ((portkeyStats.avgTotalTime - bedrockStats.avgTotalTime) / bedrockStats.avgTotalTime) * 100,
        networkLatencyDiff: portkeyStats.avgNetworkLatency - bedrockStats.avgNetworkLatency,
        successRateDiff: portkeyStats.successRate - bedrockStats.successRate
      };
    }

    const report = {
      timestamp: new Date().toISOString(),
      config: this.config,
      summary,
      rawResults: {
        bedrock: this.results.bedrock,
        portkey: this.results.portkey
      }
    };

    this.printReport(report);
    this.saveReport(report);
  }

  printReport(report) {
    const { bedrockStats, portkeyStats, comparison } = report.summary;
    const mode = this.config.mode || 'comparison';

    console.log('\n' + '='.repeat(60));

    if (mode === 'comparison') {
      console.log('📊 PORTKEY LATENCY BENCHMARK REPORT');
    } else if (mode === 'loadtest') {
      console.log('📊 PORTKEY LOAD TEST REPORT');
    }

    console.log('='.repeat(60));

    console.log('\n🔍 TEST SUMMARY:');
    console.log(`Mode: ${mode}`);
    console.log(`Total Requests: ${report.summary.totalRequests}`);
    console.log(`Test Duration: ${new Date(report.timestamp).toLocaleString()}`);

    if (mode === 'comparison') {
      // Comparison mode - show side-by-side comparison
      console.log('\n📈 PERFORMANCE COMPARISON:');
      console.log('┌─────────────────────┬──────────────┬──────────────┬──────────────┐');
      console.log('│ Metric              │ Bedrock      │ Portkey      │ Difference   │');
      console.log('├─────────────────────┼──────────────┼──────────────┼──────────────┤');
      console.log(`│ Avg Total Time      │ ${this.formatMs(bedrockStats.avgTotalTime)} │ ${this.formatMs(portkeyStats.avgTotalTime)} │ ${this.formatDiffMs(comparison.latencyOverhead)} │`);
      console.log(`│ Median Time         │ ${this.formatMs(bedrockStats.medianTotalTime)} │ ${this.formatMs(portkeyStats.medianTotalTime)} │ ${this.formatDiffMs(portkeyStats.medianTotalTime - bedrockStats.medianTotalTime)} │`);
      console.log(`│ P95 Time            │ ${this.formatMs(bedrockStats.p95TotalTime)} │ ${this.formatMs(portkeyStats.p95TotalTime)} │ ${this.formatDiffMs(portkeyStats.p95TotalTime - bedrockStats.p95TotalTime)} │`);
      console.log(`│ P99 Time            │ ${this.formatMs(bedrockStats.p99TotalTime)} │ ${this.formatMs(portkeyStats.p99TotalTime)} │ ${this.formatDiffMs(portkeyStats.p99TotalTime - bedrockStats.p99TotalTime)} │`);
      console.log(`│ Success Rate        │ ${this.formatPct(bedrockStats.successRate)} │ ${this.formatPct(portkeyStats.successRate)} │ ${this.formatDiffPct(comparison.successRateDiff)} │`);
      console.log('└─────────────────────┴──────────────┴──────────────┴──────────────┘');

      console.log('\n🎯 KEY INSIGHTS:');
      console.log(`• Portkey adds an average of ${comparison.latencyOverhead.toFixed(2)}ms latency (${comparison.latencyOverheadPercentage.toFixed(1)}% increase)`);
      console.log(`• Median overhead: ${(portkeyStats.medianTotalTime - bedrockStats.medianTotalTime).toFixed(2)}ms`);
      console.log(`• Success rate difference: ${comparison.successRateDiff.toFixed(1)}%`);
      console.log('');
      console.log('📍 WHAT THIS MEANS:');
      console.log('   The overhead represents round-trip network latency:');
      console.log('   Client → Portkey → Bedrock → Portkey → Client');
      console.log('   This includes 2 extra network hops compared to direct Bedrock calls.');
    } else {
      // Load test mode - show detailed Portkey stats
      const stats = portkeyStats;
      const providerName = 'Portkey';

      // Helper for simple values
      const formatVal = (val) => String(val).padStart(10);

      console.log(`\n📈 ${providerName.toUpperCase()} PERFORMANCE METRICS:`);
      console.log('┌─────────────────────┬──────────────┐');
      console.log('│ Metric              │ Value        │');
      console.log('├─────────────────────┼──────────────┤');
      console.log(`│ Total Requests      │ ${formatVal(stats.count)} │`);
      console.log(`│ Successful          │ ${formatVal(stats.successfulCount)} │`);
      console.log(`│ Failed              │ ${formatVal(stats.failedCount)} │`);
      console.log(`│ Success Rate        │ ${this.formatPct(stats.successRate)} │`);
      console.log(`│ Avg Total Time      │ ${this.formatMs(stats.avgTotalTime)} │`);
      console.log(`│ Median Time         │ ${this.formatMs(stats.medianTotalTime)} │`);
      console.log(`│ P95 Time            │ ${this.formatMs(stats.p95TotalTime)} │`);
      console.log(`│ P99 Time            │ ${this.formatMs(stats.p99TotalTime)} │`);
      console.log(`│ Min Time            │ ${this.formatMs(stats.minTotalTime)} │`);
      console.log(`│ Max Time            │ ${this.formatMs(stats.maxTotalTime)} │`);
      console.log(`│ Avg Tokens/Request  │ ${formatVal(stats.avgTokensPerRequest.toFixed(1))} │`);
      console.log('└─────────────────────┴──────────────┘');

      console.log('\n🎯 KEY INSIGHTS:');
      console.log(`• Average response time: ${stats.avgTotalTime.toFixed(2)}ms`);
      console.log(`• Success rate: ${stats.successRate.toFixed(1)}%`);
      console.log(`• 95% of requests completed in: ${stats.p95TotalTime.toFixed(2)}ms or less`);
      console.log(`• Average tokens per request: ${stats.avgTokensPerRequest.toFixed(1)}`);
    }

    console.log('\n💾 Detailed results saved to: benchmark_results.json');
  }

  saveReport(report) {
    try {
      const filename = `benchmark_results_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

      // Ensure results directory exists
      if (!fs.existsSync('./results')) {
        fs.mkdirSync('./results', { recursive: true });
      }

      fs.writeFileSync(`./results/${filename}`, JSON.stringify(report, null, 2));
      console.log(`📄 Report saved to: results/${filename}`);
    } catch (error) {
      console.error(`❌ Failed to save report: ${error.message}`);
      // Try saving to current directory as fallback
      try {
        const fallbackFilename = `benchmark_results_${Date.now()}.json`;
        fs.writeFileSync(fallbackFilename, JSON.stringify(report, null, 2));
        console.log(`📄 Report saved to current directory: ${fallbackFilename}`);
      } catch (fallbackError) {
        console.error(`❌ Failed to save report to current directory: ${fallbackError.message}`);
      }
    }
  }
}

// Load configuration and run benchmark
async function main() {
  try {
    console.log('Starting benchmark...');
    // Load config from file
    const configPath = process.argv[2] || 'config.json';

    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    console.log('Loading config...');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('Config loaded:', config.mode);

    // Validate required fields based on mode
    const mode = config.mode || 'comparison';

    if (!config.prompt) {
      throw new Error('Missing prompt in config');
    }

    // Mode-specific validation
    switch (mode) {
      case 'comparison':
        if (!config.portkeyApiKey) {
          throw new Error('portkeyApiKey is required for comparison mode');
        }
        if (!config.bedrockBearerToken) {
          throw new Error('bedrockBearerToken is required for comparison mode');
        }
        break;
      case 'loadtest':
        if (!config.portkeyApiKey) {
          throw new Error('portkeyApiKey is required for loadtest mode');
        }
        break;
      default:
        throw new Error(`Invalid mode: ${mode}. Supported modes: comparison, loadtest`);
    }

    // Set defaults
    config.concurrency = config.concurrency || 5;
    config.maxRequests = config.maxRequests || 100;
    config.testDuration = config.testDuration || 60;

    const benchmark = new PortkeyBenchmark(config);
    await benchmark.runBenchmark();

  } catch (error) {
    console.error('❌ Error running benchmark:', error.message);
    process.exit(1);
  }
}

// Always run main when this file is executed directly
main().catch(console.error);

export default PortkeyBenchmark;