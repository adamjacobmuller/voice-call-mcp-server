import dotenv from 'dotenv';
import { execSync, spawn } from 'child_process';
import { isPortInUse } from './utils/execution-utils.js';
import { VoiceCallMcpServer } from './servers/mcp.server.js';
import { TwilioCallService } from './services/twilio/call.service.js';
import { VoiceServer } from './servers/voice.server.js';
import twilio from 'twilio';
import { CallSessionManager } from './handlers/openai.handler.js';

// Load environment variables
dotenv.config();

// Define required environment variables
const REQUIRED_ENV_VARS = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'TWILIO_NUMBER'
] as const;

/**
 * Validates that all required environment variables are present
 * @returns true if all variables are present, exits process otherwise
 */
function validateEnvironmentVariables(): boolean {
    for (const envVar of REQUIRED_ENV_VARS) {
        if (!process.env[envVar]) {
            console.error(`Error: ${envVar} environment variable is required`);
            process.exit(1);
        }
    }
    return true;
}

/**
 * Sets up the port for the application
 */
function setupPort(): number {
    const PORT = process.env.PORT || '3004';
    process.env.PORT = PORT;
    return parseInt(PORT);
}

/**
 * Gets the Tailscale Funnel URL for external access
 * @param portNumber - The port number to forward
 * @returns The public URL provided by Tailscale Funnel
 */
async function setupTailscaleFunnel(portNumber: number): Promise<string> {
    try {
        // Get the Tailscale status to find the DNS name
        const statusOutput = execSync('tailscale status --json', { encoding: 'utf-8' });
        const status = JSON.parse(statusOutput);
        const dnsName = status.Self?.DNSName?.replace(/\.$/, ''); // Remove trailing dot

        if (!dnsName) {
            throw new Error('Could not determine Tailscale DNS name');
        }

        // Start Tailscale Funnel in the background
        const funnel = spawn('tailscale', ['funnel', '--bg', String(portNumber)], {
            detached: true,
            stdio: 'ignore'
        });
        funnel.unref();

        // Give it a moment to start
        await new Promise(resolve => setTimeout(resolve, 1000));

        const twilioCallbackUrl = `https://${dnsName}`;
        // Use stderr since stdout is used for MCP protocol
        console.error(`Tailscale Funnel URL: ${twilioCallbackUrl}`);

        return twilioCallbackUrl;
    } catch (error) {
        throw new Error(`Failed to setup Tailscale Funnel: ${error}`);
    }
}

/**
 * Sets up graceful shutdown handlers
 */
function setupShutdownHandlers(portNumber: number): void {
    process.on('SIGINT', async () => {
        try {
            execSync(`tailscale funnel --bg=false ${portNumber} off`, { stdio: 'ignore' });
        } catch (err) {
            // Funnel may already be stopped
        }
        process.exit(0);
    });
}

/**
 * Retries starting the server when the port is in use
 * @param portNumber - The port number to check
 */
function scheduleServerRetry(portNumber: number): void {
    console.error(`Port ${portNumber} is already in use. Server may already be running.`);
    console.error('Will retry in 15 seconds...');

    const RETRY_INTERVAL_MS = 15000;

    const retryInterval = setInterval(async () => {
        const stillInUse = await isPortInUse(portNumber);

        if (!stillInUse) {
            clearInterval(retryInterval);
            main();
        } else {
            console.error(`Port ${portNumber} is still in use. Will retry in 15 seconds...`);
        }
    }, RETRY_INTERVAL_MS);
}


async function main(): Promise<void> {
    try {
        validateEnvironmentVariables();
        const portNumber = setupPort();

        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

        const sessionManager = new CallSessionManager(twilioClient);
        const twilioCallService = new TwilioCallService(twilioClient);

        // Start Tailscale Funnel and voice server in background (don't block MCP startup)
        const startBackgroundServices = async () => {
            // Wait for port to be available
            let attempts = 0;
            while (await isPortInUse(portNumber) && attempts < 10) {
                console.error(`Port ${portNumber} in use, waiting...`);
                await new Promise(r => setTimeout(r, 2000));
                attempts++;
            }

            const twilioCallbackUrl = await setupTailscaleFunnel(portNumber);
            const server = new VoiceServer(twilioCallbackUrl, sessionManager);
            server.start();
            twilioCallService.setCallbackUrl(twilioCallbackUrl);
            setupShutdownHandlers(portNumber);
            console.error('Voice server ready');
        };

        // Start background services without blocking
        startBackgroundServices().catch(err => {
            console.error('Error starting background services:', err);
        });

        // Start MCP server immediately
        const mcpServer = new VoiceCallMcpServer(twilioCallService);
        await mcpServer.start();
    } catch (error) {
        console.error('Error starting services:', error);
        process.exit(1);
    }
}

// Start the main function
main();
