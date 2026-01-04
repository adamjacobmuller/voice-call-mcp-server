import dotenv from 'dotenv';
import { execSync } from 'child_process';
import twilio from 'twilio';
import { isPortInUse } from './utils/execution-utils.js';
import { TwilioCallService } from './services/twilio/call.service.js';
import { VoiceServer } from './servers/voice.server.js';
import { CallSessionManager } from './handlers/openai.handler.js';
import { CallPersistenceService } from './services/call-persistence.service.js';
import { connectDatabase, disconnectDatabase, cleanupExpiredData } from './services/db.service.js';
import { startWebServer } from './servers/web.server.js';

// Load environment variables
dotenv.config();

// Define required environment variables
const REQUIRED_ENV_VARS = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'TWILIO_NUMBER',
    'DATABASE_URL'
] as const;

// Optional environment variables with defaults
const PORT = parseInt(process.env.PORT || '3000', 10);
const VOICE_PORT = parseInt(process.env.VOICE_PORT || '3004', 10);
const BASE_URL = process.env.BASE_URL || '';
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Validates that all required environment variables are present
 */
function validateEnvironmentVariables(): void {
    const missing: string[] = [];
    for (const envVar of REQUIRED_ENV_VARS) {
        if (!process.env[envVar]) {
            missing.push(envVar);
        }
    }
    if (missing.length > 0) {
        console.error(`Error: Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
}

/**
 * Gets the Twilio callback URL for voice server
 * Uses BASE_URL/call since Tailscale Funnel routes /call to voice server
 */
function getTwilioCallbackUrl(): string {
    if (BASE_URL) {
        // Use /call path since that's where voice server is exposed via Tailscale
        return `${BASE_URL}/call`;
    }

    // Try to get Tailscale DNS name
    try {
        const statusOutput = execSync('tailscale status --json', { encoding: 'utf-8' });
        const status = JSON.parse(statusOutput);
        const dnsName = status.Self?.DNSName?.replace(/\.$/, '');
        if (dnsName) {
            return `https://${dnsName}/call`;
        }
    } catch {
        // Tailscale not available
    }

    return `http://localhost:${VOICE_PORT}`;
}

/**
 * Gets the base URL for the web server
 */
async function getBaseUrl(): Promise<string> {
    // If BASE_URL is set, use it
    if (BASE_URL) {
        return BASE_URL;
    }

    // Try to get Tailscale DNS name
    try {
        const statusOutput = execSync('tailscale status --json', { encoding: 'utf-8' });
        const status = JSON.parse(statusOutput);
        const dnsName = status.Self?.DNSName?.replace(/\.$/, '');
        if (dnsName) {
            return `https://${dnsName}`;
        }
    } catch {
        // Tailscale not available
    }

    // Fallback to localhost
    return `http://localhost:${PORT}`;
}

/**
 * Sets up graceful shutdown handlers
 */
function setupShutdownHandlers(): void {
    const shutdown = async () => {
        console.error('Shutting down...');

        // Disconnect database
        await disconnectDatabase();

        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
    try {
        console.error('Starting Voice Call MCP Server...');

        // Validate environment
        validateEnvironmentVariables();

        // Connect to database
        console.error('Connecting to database...');
        await connectDatabase();

        // Get base URL
        const baseUrl = await getBaseUrl();
        console.error(`Base URL: ${baseUrl}`);

        // Initialize services
        const twilioClient = twilio(
            process.env.TWILIO_ACCOUNT_SID!,
            process.env.TWILIO_AUTH_TOKEN!
        );

        const twilioCallService = new TwilioCallService(
            twilioClient,
            process.env.TWILIO_NUMBER!
        );
        const callPersistenceService = new CallPersistenceService();
        const sessionManager = new CallSessionManager(twilioClient);

        // Start voice server for Twilio webhooks (if not already running)
        const startVoiceServer = async () => {
            let attempts = 0;
            while (await isPortInUse(VOICE_PORT) && attempts < 10) {
                console.error(`Voice port ${VOICE_PORT} in use, waiting...`);
                await new Promise(r => setTimeout(r, 2000));
                attempts++;
            }

            if (attempts >= 10) {
                console.error(`Voice port ${VOICE_PORT} still in use after retries`);
                return;
            }

            // Get Twilio callback URL (Tailscale Funnel managed externally)
            const twilioCallbackUrl = getTwilioCallbackUrl();
            twilioCallService.setCallbackUrl(twilioCallbackUrl);
            console.error(`Twilio callback URL: ${twilioCallbackUrl}`);

            // Start voice server
            const voiceServer = new VoiceServer(twilioCallbackUrl, sessionManager);
            voiceServer.start();
            console.error(`Voice server ready on port ${VOICE_PORT}`);
        };

        // Start voice server in background
        startVoiceServer().catch(err => {
            console.error('Error starting voice server:', err);
        });

        // Start web server with OAuth and MCP
        console.error(`Starting web server on port ${PORT}...`);
        await startWebServer(PORT, baseUrl, twilioCallService, callPersistenceService);

        // Setup periodic cleanup
        setInterval(() => {
            cleanupExpiredData().catch(err => {
                console.error('Cleanup error:', err);
            });
        }, CLEANUP_INTERVAL_MS);

        // Setup shutdown handlers
        setupShutdownHandlers();

        console.error('Voice Call MCP Server started successfully');
        console.error(`Web server: ${baseUrl}`);
        console.error(`MCP endpoint: ${baseUrl}/mcp`);
        console.error(`Login page: ${baseUrl}/login`);

    } catch (error) {
        console.error('Error starting services:', error);
        process.exit(1);
    }
}

// Start the application
main();
