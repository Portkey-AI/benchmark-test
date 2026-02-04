import fs from 'fs';
// Using direct HTTP requests (fetch) for all providers

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

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.bedrockBearerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

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
        model: this.config.bedrockModelId || this.config.model || 'claude-3-sonnet-20240229',
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

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.bedrockBearerToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 100,
            messages: [{
              role: "user",
              content: [{ type: "text", text: content }]
            }],
            temperature: 0.7
          })
        });

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

          // Check if we can extract OpenAI processing time from Portkey response
          if (portkeyResult.openaiProcessingTime !== null) {
            console.log(`✅ OpenAI processing time extracted via Portkey: ${portkeyResult.openaiProcessingTime}ms`);
          } else {
            console.log(`⚠️  OpenAI processing time not available in Portkey response headers`);
            console.log(`   Network latency calculation will be limited`);
          }

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

    // Check if processing times are available for enabled providers (only important for comparison mode)
    const mode = this.config.mode || 'comparison';
    if (mode === 'comparison') {
      const bedrockHasProcessingTime = bedrockSuccess && testResults.bedrock.openaiProcessingTime !== null;
      const portkeyHasProcessingTime = portkeySuccess && testResults.portkey.openaiProcessingTime !== null;

      if (this.shouldTestBedrock && this.shouldTestPortkey) {
        // Both providers are enabled, both must have processing times for accurate comparison
        if (!bedrockHasProcessingTime || !portkeyHasProcessingTime) {
          const missingProviders = [];
          if (!bedrockHasProcessingTime) missingProviders.push('Bedrock');
          if (!portkeyHasProcessingTime) missingProviders.push('Portkey');

          console.log(`⚠️  Processing time extraction failed for ${missingProviders.join(' and ')}. ` +
            'Comparison mode will be less accurate without processing time headers.');
        }
      }
    } else {
      // For load testing modes, processing time is helpful but not critical
      const enabledProvider = this.shouldTestBedrock ? 'Bedrock' : 'Portkey';
      const hasProcessingTime = this.shouldTestBedrock ?
        (bedrockSuccess && testResults.bedrock.openaiProcessingTime !== null) :
        (portkeySuccess && testResults.portkey.openaiProcessingTime !== null);

      if (!hasProcessingTime) {
        console.log(`⚠️  Processing time extraction failed for ${enabledProvider}. ` +
          'Network latency calculations will be limited.');
      }
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
      console.log(`│    ${stat.iteration}      │ ${stat.bedrockStats.avgTotalTime.toFixed(2).padEnd(10)}ms │ ${stat.portkeyStats.avgTotalTime.toFixed(2).padEnd(10)}ms │ ${stat.overhead >= 0 ? '+' : ''}${stat.overhead.toFixed(2).padEnd(10)}ms │ ${stat.medianOverhead >= 0 ? '+' : ''}${stat.medianOverhead.toFixed(2).padEnd(10)}ms │`);
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
      console.log('┌─────────────────────┬──────────────┬──────────────┬─────────────┐');
      console.log('│ Metric              │ Bedrock      │ Portkey      │ Difference  │');
      console.log('├─────────────────────┼──────────────┼──────────────┼─────────────┤');
      console.log(`│ Avg Total Time      │ ${aggregatedBedrockStats.avgTotalTime.toFixed(2).padEnd(10)}ms │ ${aggregatedPortkeyStats.avgTotalTime.toFixed(2).padEnd(10)}ms │ ${(aggregatedPortkeyStats.avgTotalTime - aggregatedBedrockStats.avgTotalTime >= 0 ? '+' : '')}${(aggregatedPortkeyStats.avgTotalTime - aggregatedBedrockStats.avgTotalTime).toFixed(2).padEnd(9)}ms │`);
      console.log(`│ Median Time         │ ${aggregatedBedrockStats.medianTotalTime.toFixed(2).padEnd(10)}ms │ ${aggregatedPortkeyStats.medianTotalTime.toFixed(2).padEnd(10)}ms │ ${(aggregatedPortkeyStats.medianTotalTime - aggregatedBedrockStats.medianTotalTime >= 0 ? '+' : '')}${(aggregatedPortkeyStats.medianTotalTime - aggregatedBedrockStats.medianTotalTime).toFixed(2).padEnd(9)}ms │`);
      console.log(`│ P95 Time            │ ${aggregatedBedrockStats.p95TotalTime.toFixed(2).padEnd(10)}ms │ ${aggregatedPortkeyStats.p95TotalTime.toFixed(2).padEnd(10)}ms │ ${(aggregatedPortkeyStats.p95TotalTime - aggregatedBedrockStats.p95TotalTime >= 0 ? '+' : '')}${(aggregatedPortkeyStats.p95TotalTime - aggregatedBedrockStats.p95TotalTime).toFixed(2).padEnd(9)}ms │`);
      console.log(`│ P99 Time            │ ${aggregatedBedrockStats.p99TotalTime.toFixed(2).padEnd(10)}ms │ ${aggregatedPortkeyStats.p99TotalTime.toFixed(2).padEnd(10)}ms │ ${(aggregatedPortkeyStats.p99TotalTime - aggregatedBedrockStats.p99TotalTime >= 0 ? '+' : '')}${(aggregatedPortkeyStats.p99TotalTime - aggregatedBedrockStats.p99TotalTime).toFixed(2).padEnd(9)}ms │`);
      console.log(`│ Success Rate        │ ${aggregatedBedrockStats.successRate.toFixed(1).padEnd(10)}%  │ ${aggregatedPortkeyStats.successRate.toFixed(1).padEnd(10)}%  │ ${(aggregatedPortkeyStats.successRate - aggregatedBedrockStats.successRate >= 0 ? '+' : '')}${(aggregatedPortkeyStats.successRate - aggregatedBedrockStats.successRate).toFixed(1).padEnd(9)}%  │`);
      console.log('└─────────────────────┴──────────────┴──────────────┴─────────────┘');

      const aggregatedOverhead = aggregatedPortkeyStats.avgTotalTime - aggregatedBedrockStats.avgTotalTime;
      const aggregatedOverheadPct = (aggregatedOverhead / aggregatedBedrockStats.avgTotalTime) * 100;

      console.log('\n🎯 KEY INSIGHTS:');
      console.log(`• Total requests across all iterations: ${allBedrockResults.length}`);
      console.log(`• Aggregated average overhead: ${aggregatedOverhead.toFixed(2)}ms (${aggregatedOverheadPct.toFixed(2)}%)`);
      console.log(`• Aggregated median overhead: ${(aggregatedPortkeyStats.medianTotalTime - aggregatedBedrockStats.medianTotalTime).toFixed(2)}ms`);
      console.log(`• Overhead consistency (std dev): ${stdDev.toFixed(2)}ms`);
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
      console.log('┌─────────────────────┬──────────────┬──────────────┬─────────────┐');
      console.log('│ Metric              │ Bedrock      │ Portkey      │ Difference  │');
      console.log('├─────────────────────┼──────────────┼──────────────┼─────────────┤');
      console.log(`│ Avg Total Time      │ ${bedrockStats.avgTotalTime.toFixed(2)}ms      │ ${portkeyStats.avgTotalTime.toFixed(2)}ms      │ +${comparison.latencyOverhead.toFixed(2)}ms     │`);
      console.log(`│ Avg Network Latency │ ${bedrockStats.avgNetworkLatency.toFixed(2)}ms      │ ${portkeyStats.avgNetworkLatency.toFixed(2)}ms      │ +${comparison.networkLatencyDiff.toFixed(2)}ms     │`);
      console.log(`│ Success Rate        │ ${bedrockStats.successRate.toFixed(1)}%       │ ${portkeyStats.successRate.toFixed(1)}%       │ ${comparison.successRateDiff.toFixed(1)}%       │`);
      console.log(`│ Median Time         │ ${bedrockStats.medianTotalTime.toFixed(2)}ms      │ ${portkeyStats.medianTotalTime.toFixed(2)}ms      │ +${(portkeyStats.medianTotalTime - bedrockStats.medianTotalTime).toFixed(2)}ms     │`);
      console.log(`│ P95 Time            │ ${bedrockStats.p95TotalTime.toFixed(2)}ms      │ ${portkeyStats.p95TotalTime.toFixed(2)}ms      │ +${(portkeyStats.p95TotalTime - bedrockStats.p95TotalTime).toFixed(2)}ms     │`);
      console.log(`│ P99 Time            │ ${bedrockStats.p99TotalTime.toFixed(2)}ms      │ ${portkeyStats.p99TotalTime.toFixed(2)}ms      │ +${(portkeyStats.p99TotalTime - bedrockStats.p99TotalTime).toFixed(2)}ms     │`);
      console.log('└─────────────────────┴──────────────┴──────────────┴─────────────┘');

      console.log('\n🎯 KEY INSIGHTS:');
      console.log(`• Portkey adds an average of ${comparison.latencyOverhead.toFixed(2)}ms latency (${comparison.latencyOverheadPercentage.toFixed(1)}% increase)`);
      console.log(`• Network latency difference: ${comparison.networkLatencyDiff.toFixed(2)}ms`);
      console.log(`• Success rate difference: ${comparison.successRateDiff.toFixed(1)}%`);

      if (comparison.latencyOverhead > 0) {
        console.log(`• Portkey proxy overhead: ${comparison.latencyOverhead.toFixed(2)}ms per request`);
      }
    } else {
      // Load test mode - show detailed Portkey stats
      const stats = portkeyStats;
      const providerName = 'Portkey';

      console.log(`\n📈 ${providerName.toUpperCase()} PERFORMANCE METRICS:`);
      console.log('┌─────────────────────┬──────────────┐');
      console.log('│ Metric              │ Value        │');
      console.log('├─────────────────────┼──────────────┤');
      console.log(`│ Total Requests      │ ${stats.count}           │`);
      console.log(`│ Successful          │ ${stats.successfulCount}           │`);
      console.log(`│ Failed              │ ${stats.failedCount}           │`);
      console.log(`│ Success Rate        │ ${stats.successRate.toFixed(1)}%       │`);
      console.log(`│ Avg Total Time      │ ${stats.avgTotalTime.toFixed(2)}ms      │`);
      console.log(`│ Avg Network Latency │ ${stats.avgNetworkLatency.toFixed(2)}ms      │`);
      console.log(`│ Median Time         │ ${stats.medianTotalTime.toFixed(2)}ms      │`);
      console.log(`│ P95 Time            │ ${stats.p95TotalTime.toFixed(2)}ms      │`);
      console.log(`│ P99 Time            │ ${stats.p99TotalTime.toFixed(2)}ms      │`);
      console.log(`│ Min Time            │ ${stats.minTotalTime.toFixed(2)}ms      │`);
      console.log(`│ Max Time            │ ${stats.maxTotalTime.toFixed(2)}ms      │`);
      console.log(`│ Avg Tokens/Request  │ ${stats.avgTokensPerRequest.toFixed(1)}        │`);
      console.log('└─────────────────────┴──────────────┘');

      console.log('\n🎯 KEY INSIGHTS:');
      console.log(`• Average response time: ${stats.avgTotalTime.toFixed(2)}ms`);
      console.log(`• Success rate: ${stats.successRate.toFixed(1)}%`);
      console.log(`• 95% of requests completed in: ${stats.p95TotalTime.toFixed(2)}ms or less`);
      console.log(`• Average tokens per request: ${stats.avgTokensPerRequest.toFixed(1)}`);

      if (stats.avgNetworkLatency > 0) {
        console.log(`• Average network latency: ${stats.avgNetworkLatency.toFixed(2)}ms`);
      }
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