import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import { McpAuth, getMcpSession } from '@mcpauth/auth/adapters/express';
import { PrismaAdapter } from '@mcpauth/auth/stores/prisma';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { prisma } from '../services/db.service.js';
import {
    authenticateUser,
    registerUser,
    createSession,
    validateSession,
    AuthUser
} from '../services/auth.service.js';
import { TwilioCallService } from '../services/twilio/call.service.js';
import { CallPersistenceService } from '../services/call-persistence.service.js';

/**
 * Create a patched storage adapter that fixes the @mcpauth/auth bug.
 *
 * Bug: storage.js registerClient() returns newClient.clientSecret (the hashed value)
 * instead of the raw clientSecret that was generated.
 *
 * Workaround: Since @mcpauth returns the hashed secret to clients, and clients send it back,
 * we compare the hashed secrets directly (string comparison) instead of using bcrypt.compare.
 */
function createPatchedAdapter() {
    // PrismaAdapter returns a storage object with getClient, registerClient, etc.
    const storage = PrismaAdapter(prisma);

    // Override getClient to handle the @mcpauth bug
    // When client sends the hashed secret back, we compare hashes directly
    storage.getClient = async (clientId: string, clientSecret?: string) => {
        console.error(`[getClient] Called with clientId=${clientId}, clientSecret=${clientSecret ? `"${clientSecret.substring(0, 8)}..."` : 'null'}`);

        // Find the client directly from Prisma
        const clientRecord = await prisma.oauthClient.findFirst({
            where: { clientId }
        });

        if (!clientRecord) {
            console.error(`[getClient] No client found for clientId=${clientId}`);
            return null;
        }

        console.error(`[getClient] Found client: id=${clientRecord.id}, tokenEndpointAuthMethod=${clientRecord.tokenEndpointAuthMethod}, hasStoredSecret=${!!clientRecord.clientSecret}`);

        // If client_secret is provided (token endpoint), verify it
        if (clientSecret) {
            if (!clientRecord.clientSecret) {
                console.error(`[getClient] Client has no stored secret but secret was provided`);
                return null;
            }

            // Due to @mcpauth bug, the client receives the hashed secret and sends it back
            // So we compare the provided secret (which is the hash) directly with stored hash
            console.error(`[getClient] Comparing secrets directly (both are hashed due to bug)`);
            console.error(`[getClient] provided="${clientSecret.substring(0, 20)}..."`);
            console.error(`[getClient] stored="${clientRecord.clientSecret.substring(0, 20)}..."`);

            if (clientSecret !== clientRecord.clientSecret) {
                console.error(`[getClient] Secret mismatch - returning null`);
                return null;
            }
            console.error(`[getClient] Secrets match!`);
        } else {
            console.error(`[getClient] No secret provided - allowing lookup without verification`);
        }

        console.error(`[getClient] Returning client successfully`);
        return {
            ...clientRecord,
            id: clientRecord.id,
            tokenEndpointAuthMethod: clientRecord.tokenEndpointAuthMethod,
            scope: clientRecord.scope || undefined
        };
    };

    return storage;
}

const SESSION_COOKIE_NAME = 'voice_call_session_id';
const SESSION_COOKIE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// Store transports per session
const transports: Record<string, StreamableHTTPServerTransport> = {};
const servers: Record<string, McpServer> = {};

// Service instances (will be set in startWebServer)
let twilioCallService: TwilioCallService;
let callPersistenceService: CallPersistenceService;

/**
 * Create the OAuth configuration for @mcpauth/auth
 */
function createMcpAuthConfig(baseUrl: string) {
    return {
        adapter: createPatchedAdapter(),
        issuerUrl: baseUrl,
        issuerPath: '/api/oauth',

        serverOptions: {
            accessTokenLifetime: 3600, // 1 hour
            refreshTokenLifetime: 1209600, // 14 days
        },

        // Custom authentication - parse session cookie and validate
        authenticateUser: async (request: Request) => {
            console.error('authenticateUser called');

            // Manually parse cookie header since @mcpauth/auth doesn't use our middleware
            let sessionId: string | null = null;
            const cookieHeader = request.headers?.cookie;
            if (cookieHeader) {
                const cookies = cookieHeader.split(';').reduce((acc: Record<string, string>, cookie: string) => {
                    const [key, value] = cookie.trim().split('=');
                    if (key && value) {
                        acc[key] = value;
                    }
                    return acc;
                }, {});
                sessionId = cookies[SESSION_COOKIE_NAME] || null;
            }

            console.error('Looking for session ID:', sessionId);

            if (sessionId) {
                const user = await validateSession(sessionId);
                if (user) {
                    console.error('Authenticating user:', user.email, 'ID:', user.id);
                    return {
                        id: user.id,
                        email: user.email,
                        name: user.name || user.email
                    };
                }
            }

            console.error('authenticateUser returning null - no valid session');
            return null;
        },

        signInUrl: (_request: Request, callbackUrl: string) => {
            return `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
        },
    };
}

/**
 * Generate the login page HTML
 */
function generateLoginPageHtml(callbackUrl: string, showRegister: boolean = false): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Voice Call MCP - ${showRegister ? 'Register' : 'Login'}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 400px;
            margin: 100px auto;
            padding: 20px;
            background: #f0f0f0;
        }
        h1 { color: #333; text-align: center; }
        .container { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        input {
            width: 100%;
            padding: 12px;
            margin: 10px 0;
            border: 1px solid #ddd;
            border-radius: 6px;
            box-sizing: border-box;
            font-size: 16px;
        }
        button {
            width: 100%;
            padding: 14px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            margin-top: 10px;
        }
        button:hover { background: #0056b3; }
        .error { color: #dc3545; margin-top: 10px; text-align: center; }
        .success { color: #28a745; margin-top: 10px; text-align: center; }
        .toggle { text-align: center; margin-top: 20px; }
        .toggle a { color: #007bff; cursor: pointer; text-decoration: none; }
        .toggle a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Voice Call MCP</h1>
        <p style="text-align: center; color: #666;">${showRegister ? 'Create a new account' : 'Login to continue'}</p>
        <form id="authForm">
            ${showRegister ? '<input type="text" id="name" name="name" placeholder="Name (optional)" />' : ''}
            <input type="email" id="email" name="email" placeholder="Email" required />
            <input type="password" id="password" name="password" placeholder="Password" required />
            <button type="submit">${showRegister ? 'Register' : 'Login'}</button>
            <div id="error" class="error"></div>
            <div id="success" class="success"></div>
        </form>
        <div class="toggle">
            ${showRegister
            ? `Already have an account? <a href="/login?callbackUrl=${encodeURIComponent(callbackUrl)}">Login</a>`
            : `Don't have an account? <a href="/register?callbackUrl=${encodeURIComponent(callbackUrl)}">Register</a>`
        }
        </div>
    </div>

    <script>
        const isRegister = ${showRegister};
        document.getElementById('authForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const nameEl = document.getElementById('name');
            const name = nameEl ? nameEl.value : null;
            const errorDiv = document.getElementById('error');
            const successDiv = document.getElementById('success');

            errorDiv.textContent = '';
            successDiv.textContent = '';

            try {
                const endpoint = isRegister ? '/api/register' : '/api/login';
                const body = isRegister
                    ? { email, password, name, callbackUrl: '${callbackUrl}' }
                    : { email, password, callbackUrl: '${callbackUrl}' };

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                const data = await response.json();

                if (data.error) {
                    errorDiv.textContent = data.error;
                } else if (data.redirect) {
                    if (isRegister) {
                        successDiv.textContent = 'Account created! Redirecting...';
                        setTimeout(() => { window.location.href = data.redirect; }, 1000);
                    } else {
                        window.location.href = data.redirect;
                    }
                }
            } catch (err) {
                errorDiv.textContent = 'Connection error: ' + err.message;
            }
        });
    </script>
</body>
</html>
`;
}

/**
 * Create MCP server with voice call tools for a specific user
 */
function createMcpServerForUser(user: AuthUser): McpServer {
    const server = new McpServer({
        name: 'voice-call-mcp-server',
        version: '1.0.0'
    });

    // Register trigger-call tool
    server.tool(
        'trigger-call',
        'Trigger an outbound phone call via Twilio',
        {
            toNumber: z.string().describe('The phone number to call'),
            callContext: z.string().describe('Context for the call')
        },
        async ({ toNumber, callContext }) => {
            console.error(`trigger-call tool called by user ${user.id}: ${toNumber}`);

            if (!twilioCallService) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Voice server not ready yet' }) }],
                    isError: true
                };
            }

            try {
                // Start call and persist to database
                const call = await twilioCallService.makeCall(toNumber, callContext);
                await callPersistenceService.startCall(
                    user.id,
                    call.sid,
                    twilioCallService.getFromNumber(),
                    toNumber,
                    callContext
                );

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            callSid: call.sid,
                            to: toNumber,
                            status: call.status
                        }, null, 2)
                    }]
                };
            } catch (error: any) {
                console.error('Error making call:', error);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
                    isError: true
                };
            }
        }
    );

    // Register get-transcript tool
    server.tool(
        'get-transcript',
        'Get the transcript of a call by call SID, or get the latest call transcript if no SID provided',
        {
            callSid: z.string().optional().describe('The call SID to get transcript for (optional, defaults to latest)')
        },
        async ({ callSid }) => {
            console.error(`get-transcript tool called by user ${user.id}: ${callSid || 'latest'}`);

            try {
                const transcript = callSid
                    ? await callPersistenceService.getTranscript(callSid, user.id)
                    : await callPersistenceService.getLatestTranscript(user.id);

                if (!transcript) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ error: 'No transcript found' }) }],
                        isError: true
                    };
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(transcript, null, 2)
                    }]
                };
            } catch (error: any) {
                console.error('Error getting transcript:', error);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
                    isError: true
                };
            }
        }
    );

    // Register list-calls tool
    server.tool(
        'list-calls',
        'List recent calls with their transcripts',
        {
            limit: z.number().optional().describe('Maximum number of calls to return (default 10)')
        },
        async ({ limit }) => {
            console.error(`list-calls tool called by user ${user.id}: limit=${limit || 10}`);

            try {
                const calls = await callPersistenceService.getRecentCalls(user.id, limit || 10);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            count: calls.length,
                            calls
                        }, null, 2)
                    }]
                };
            } catch (error: any) {
                console.error('Error listing calls:', error);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
                    isError: true
                };
            }
        }
    );

    return server;
}

/**
 * Start the web server with OAuth, login, and MCP endpoints
 */
export async function startWebServer(
    port: number,
    baseUrl: string,
    callService: TwilioCallService,
    persistenceService: CallPersistenceService
): Promise<Express> {
    twilioCallService = callService;
    callPersistenceService = persistenceService;

    const app = express();

    // Trust proxy for HTTPS detection
    app.set('trust proxy', 1);

    // Middleware
    app.use(cors({
        origin: true,
        credentials: true
    }));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());

    // Request logging
    app.use((req: Request, _res: Response, next: NextFunction) => {
        console.error(`${new Date().toISOString()} ${req.method} ${req.url}`);
        next();
    });

    // Configure and mount OAuth endpoints
    const mcpAuthConfig = createMcpAuthConfig(baseUrl);
    const mcpAuth = McpAuth(mcpAuthConfig);
    app.use('/api/oauth', mcpAuth);
    app.use('/.well-known', mcpAuth);

    // Error handler for OAuth
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        console.error('Error in request:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    });

    // Home page - redirect to login or show status
    app.get('/', (_req: Request, res: Response) => {
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Voice Call MCP Server</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 600px;
            margin: 100px auto;
            padding: 20px;
            text-align: center;
        }
        h1 { color: #333; }
        .status { color: #28a745; font-size: 1.2em; margin: 20px 0; }
        a { color: #007bff; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .info { background: #f5f5f5; padding: 20px; border-radius: 8px; margin-top: 30px; text-align: left; }
        code { background: #e9ecef; padding: 2px 6px; border-radius: 4px; }
    </style>
</head>
<body>
    <h1>Voice Call MCP Server</h1>
    <div class="status">✓ Server is running</div>
    <p><a href="/login">Login</a> | <a href="/register">Register</a></p>
    <div class="info">
        <p><strong>MCP Endpoint:</strong> <code>/mcp</code></p>
        <p><strong>OAuth Discovery:</strong> <code>/.well-known/oauth-authorization-server</code></p>
        <p>Add this server to Claude using the MCP endpoint URL.</p>
    </div>
</body>
</html>
        `);
    });

    // Login page
    app.get('/login', (req: Request, res: Response) => {
        const callbackUrl = (req.query.callbackUrl as string) || '/';
        res.send(generateLoginPageHtml(callbackUrl, false));
    });

    // Register page
    app.get('/register', (req: Request, res: Response) => {
        const callbackUrl = (req.query.callbackUrl as string) || '/';
        res.send(generateLoginPageHtml(callbackUrl, true));
    });

    // Login API endpoint
    app.post('/api/login', async (req: Request, res: Response) => {
        const { email, password, callbackUrl } = req.body;

        console.error(`Login attempt for user: ${email}`);

        try {
            const user = await authenticateUser(email, password);

            if (!user) {
                res.status(401).json({ error: 'Invalid email or password' });
                return;
            }

            // Create session
            const session = await createSession(user.id);

            // Set session cookie
            res.cookie(SESSION_COOKIE_NAME, session.id, {
                httpOnly: true,
                secure: true,
                sameSite: 'lax',
                maxAge: SESSION_COOKIE_MAX_AGE
            });

            console.error(`Login successful for user: ${email}, session: ${session.id}`);

            // Redirect back to OAuth flow
            res.json({ redirect: callbackUrl || '/' });
        } catch (error: any) {
            console.error('Login error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Register API endpoint
    app.post('/api/register', async (req: Request, res: Response) => {
        const { email, password, name, callbackUrl } = req.body;

        console.error(`Registration attempt for: ${email}`);

        try {
            // Validate password
            if (!password || password.length < 8) {
                res.status(400).json({ error: 'Password must be at least 8 characters' });
                return;
            }

            // Register user
            const user = await registerUser(email, password, name);

            // Create session
            const session = await createSession(user.id);

            // Set session cookie
            res.cookie(SESSION_COOKIE_NAME, session.id, {
                httpOnly: true,
                secure: true,
                sameSite: 'lax',
                maxAge: SESSION_COOKIE_MAX_AGE
            });

            console.error(`Registration successful for user: ${email}, session: ${session.id}`);

            // Redirect back to OAuth flow
            res.json({ redirect: callbackUrl || '/' });
        } catch (error: any) {
            console.error('Registration error:', error);
            res.status(400).json({ error: error.message });
        }
    });

    // MCP endpoint (POST - StreamableHTTPServerTransport)
    app.post('/mcp', async (req: Request, res: Response) => {
        const session = await getMcpSession(mcpAuthConfig)(req);

        if (!session) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;
        let server: McpServer;

        if (sessionId && transports[sessionId]) {
            // Reuse existing transport and server
            transport = transports[sessionId];
            server = servers[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // Get user info from OAuth session
            console.error(`[MCP] OAuth session:`, JSON.stringify(session, null, 2));

            // The OAuth session has user info nested under session.user
            const sessionUser = (session as any).user;
            const userId = sessionUser?.id || (session as any).id || (session as any).sub || '';

            // Look up the user from the database to get their email
            let user: AuthUser;
            if (userId) {
                const dbUser = await prisma.user.findUnique({ where: { id: userId } });
                if (dbUser) {
                    user = {
                        id: dbUser.id,
                        email: dbUser.email,
                        name: dbUser.name
                    };
                } else {
                    console.error(`[MCP] User not found in database for ID: ${userId}`);
                    user = { id: userId, email: '', name: null };
                }
            } else {
                console.error(`[MCP] No user ID found in session`);
                user = {
                    id: '',
                    email: '',
                    name: null
                };
            }

            console.error(`MCP session initializing for user: ${user.email} (ID: ${user.id})`);

            // Create MCP server for this user
            server = createMcpServerForUser(user);

            // Create StreamableHTTPServerTransport
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid: string) => {
                    transports[sid] = transport;
                    servers[sid] = server;
                    console.error('MCP session initialized:', sid);
                }
            });

            transport.onclose = () => {
                if (transport.sessionId) {
                    console.error('MCP session closed:', transport.sessionId);
                    delete transports[transport.sessionId];
                    delete servers[transport.sessionId];
                }
            };

            await server.connect(transport);
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null,
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    });

    // Health check
    app.get('/health', (_req: Request, res: Response) => {
        res.json({
            status: 'healthy',
            server: 'voice-call-mcp-server',
            version: '1.0.0'
        });
    });

    // Start server
    app.listen(port, () => {
        console.error(`Web server listening on port ${port}`);
        console.error(`MCP endpoint: ${baseUrl}/mcp`);
        console.error(`Login page: ${baseUrl}/login`);
    });

    return app;
}
