import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TwilioCallService } from '../services/twilio/call.service.js';
import { transcriptStore } from '../services/transcript.service.js';

export class VoiceCallMcpServer {
    private server: McpServer;
    private twilioCallService: TwilioCallService;

    constructor(twilioCallService: TwilioCallService, _twilioCallbackUrl?: string) {
        this.twilioCallService = twilioCallService;

        this.server = new McpServer({
            name: 'Voice Call MCP Server',
            version: '1.0.0',
            description: 'MCP server that provides tools for initiating phone calls via Twilio'
        });

        this.registerTools();
        this.registerResources();
        this.registerPrompts();
    }

    private registerTools(): void {
        this.server.tool(
            'trigger-call',
            'Trigger an outbound phone call via Twilio',
            {
                toNumber: z.string().describe('The phone number to call'),
                callContext: z.string().describe('Context for the call')
            },
            async ({ toNumber, callContext }) => {
                try {
                    const callbackUrl = this.twilioCallService.getCallbackUrl();
                    if (!callbackUrl) {
                        throw new Error('Voice server not ready yet. Please wait a moment and try again.');
                    }
                    const callSid = await this.twilioCallService.makeCall(callbackUrl, toNumber, callContext);

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                message: 'Call triggered successfully',
                                callSid: callSid
                            })
                        }]
                    };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'error',
                                message: `Failed to trigger call: ${errorMessage}`
                            })
                        }],
                        isError: true
                    };
                }
            }
        );

        this.server.tool(
            'get-transcript',
            'Get the transcript of a call by call SID, or get the latest call transcript if no SID provided',
            {
                callSid: z.string().optional().describe('The call SID to get transcript for (optional, defaults to latest)')
            },
            async ({ callSid }) => {
                try {
                    const transcript = callSid
                        ? transcriptStore.getTranscript(callSid)
                        : transcriptStore.getLatestTranscript();

                    if (!transcript) {
                        return {
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    status: 'not_found',
                                    message: callSid ? `No transcript found for call ${callSid}` : 'No calls recorded yet'
                                })
                            }]
                        };
                    }

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                callSid: transcript.callSid,
                                fromNumber: transcript.fromNumber,
                                toNumber: transcript.toNumber,
                                callContext: transcript.callContext,
                                callStatus: transcript.status,
                                startTime: transcript.startTime,
                                endTime: transcript.endTime,
                                messages: transcript.messages
                            }, null, 2)
                        }]
                    };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'error',
                                message: `Failed to get transcript: ${errorMessage}`
                            })
                        }],
                        isError: true
                    };
                }
            }
        );

        this.server.tool(
            'list-calls',
            'List recent calls with their transcripts',
            {
                limit: z.number().optional().describe('Maximum number of calls to return (default 10)')
            },
            async ({ limit }) => {
                try {
                    const transcripts = transcriptStore.getRecentTranscripts(limit || 10);

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                count: transcripts.length,
                                calls: transcripts.map(t => ({
                                    callSid: t.callSid,
                                    toNumber: t.toNumber,
                                    callStatus: t.status,
                                    startTime: t.startTime,
                                    endTime: t.endTime,
                                    messageCount: t.messages.length
                                }))
                            }, null, 2)
                        }]
                    };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'error',
                                message: `Failed to list calls: ${errorMessage}`
                            })
                        }],
                        isError: true
                    };
                }
            }
        );
    }

    private registerResources(): void {
        this.server.resource(
            'get-latest-call',
            new ResourceTemplate('call://transcriptions', { list: undefined }),
            async () => {
                const transcript = transcriptStore.getLatestTranscript();

                if (!transcript) {
                    return {
                        contents: [{
                            text: JSON.stringify({
                                status: 'no_calls',
                                message: 'No calls recorded yet'
                            }),
                            uri: 'call://transcriptions/latest',
                            mimeType: 'application/json'
                        }]
                    };
                }

                return {
                    contents: [{
                        text: JSON.stringify({
                            callSid: transcript.callSid,
                            fromNumber: transcript.fromNumber,
                            toNumber: transcript.toNumber,
                            callContext: transcript.callContext,
                            status: transcript.status,
                            startTime: transcript.startTime,
                            endTime: transcript.endTime,
                            messages: transcript.messages
                        }, null, 2),
                        uri: `call://transcriptions/${transcript.callSid}`,
                        mimeType: 'application/json'
                    }]
                };
            }
        );
    }

    private registerPrompts(): void {
        this.server.prompt(
            'make-restaurant-reservation',
            'Create a prompt for making a restaurant reservation by phone',
            {
                restaurantNumber: z.string().describe('The phone number of the restaurant'),
                peopleNumber: z.string().describe('The number of people in the party'),
                date: z.string().describe('Date of the reservation'),
                time: z.string().describe('Preferred time for the reservation')
            },
            ({ restaurantNumber, peopleNumber, date, time }) => {
                return {
                    messages: [{
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `You are calling a restaurant to book a table for ${peopleNumber} people on ${date} at ${time}. Call the restaurant at ${restaurantNumber} from ${process.env.TWILIO_NUMBER}.`
                        }
                    }]
                };
            }
        );
    }

    public async start(): Promise<void> {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
    }
}
