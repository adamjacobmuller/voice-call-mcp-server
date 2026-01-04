import { prisma } from './db.service.js';
import { Call, CallMessage } from '@prisma/client';

export interface CallWithMessages extends Call {
    messages: CallMessage[];
}

export interface CallTranscript {
    callSid: string;
    fromNumber: string;
    toNumber: string;
    callContext: string | null;
    startTime: Date;
    endTime: Date | null;
    status: string;
    messages: Array<{
        role: string;
        content: string;
        timestamp: Date;
    }>;
}

/**
 * Service for persisting call data to the database
 */
export class CallPersistenceService {
    /**
     * Start a new call and save to database
     */
    async startCall(
        userId: string,
        callSid: string,
        fromNumber: string,
        toNumber: string,
        callContext?: string
    ): Promise<Call> {
        const call = await prisma.call.create({
            data: {
                callSid,
                userId,
                fromNumber,
                toNumber,
                callContext: callContext || null,
                status: 'in_progress'
            }
        });

        console.error(`Call started: ${callSid} for user ${userId}`);
        return call;
    }

    /**
     * Add a message to a call transcript
     */
    async addMessage(
        callSid: string,
        role: 'user' | 'assistant',
        content: string
    ): Promise<CallMessage | null> {
        // Find the call
        const call = await prisma.call.findUnique({
            where: { callSid }
        });

        if (!call) {
            console.error(`Cannot add message: call ${callSid} not found`);
            return null;
        }

        const message = await prisma.callMessage.create({
            data: {
                callId: call.id,
                role,
                content
            }
        });

        console.error(`Message added to call ${callSid}: [${role}] ${content.substring(0, 50)}...`);
        return message;
    }

    /**
     * End a call
     */
    async endCall(callSid: string): Promise<Call | null> {
        const call = await prisma.call.update({
            where: { callSid },
            data: {
                status: 'completed',
                endedAt: new Date()
            }
        }).catch(() => null);

        if (call) {
            console.error(`Call ended: ${callSid}`);
        }

        return call;
    }

    /**
     * Get a call transcript by callSid (with ownership check)
     */
    async getTranscript(callSid: string, userId: string): Promise<CallTranscript | null> {
        const call = await prisma.call.findUnique({
            where: { callSid },
            include: {
                messages: {
                    orderBy: { timestamp: 'asc' }
                }
            }
        });

        if (!call) {
            return null;
        }

        // Check ownership
        if (call.userId !== userId) {
            console.error(`User ${userId} attempted to access call ${callSid} owned by ${call.userId}`);
            return null;
        }

        return this.callToTranscript(call);
    }

    /**
     * Get the latest call transcript for a user
     */
    async getLatestTranscript(userId: string): Promise<CallTranscript | null> {
        const call = await prisma.call.findFirst({
            where: { userId },
            orderBy: { startedAt: 'desc' },
            include: {
                messages: {
                    orderBy: { timestamp: 'asc' }
                }
            }
        });

        if (!call) {
            return null;
        }

        return this.callToTranscript(call);
    }

    /**
     * Get recent calls for a user
     */
    async getRecentCalls(userId: string, limit: number = 10): Promise<CallTranscript[]> {
        const calls = await prisma.call.findMany({
            where: { userId },
            orderBy: { startedAt: 'desc' },
            take: limit,
            include: {
                messages: {
                    orderBy: { timestamp: 'asc' }
                }
            }
        });

        return calls.map(call => this.callToTranscript(call));
    }

    /**
     * Find a call by callSid (internal use, no ownership check)
     */
    async findCall(callSid: string): Promise<Call | null> {
        return prisma.call.findUnique({
            where: { callSid }
        });
    }

    /**
     * Update call status
     */
    async updateCallStatus(callSid: string, status: string): Promise<Call | null> {
        return prisma.call.update({
            where: { callSid },
            data: { status }
        }).catch(() => null);
    }

    /**
     * Convert a Call with messages to a CallTranscript
     */
    private callToTranscript(call: CallWithMessages): CallTranscript {
        return {
            callSid: call.callSid,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            callContext: call.callContext,
            startTime: call.startedAt,
            endTime: call.endedAt,
            status: call.status,
            messages: call.messages.map(m => ({
                role: m.role,
                content: m.content,
                timestamp: m.timestamp
            }))
        };
    }
}

// Singleton instance for use by event handlers
export const callPersistenceService = new CallPersistenceService();
