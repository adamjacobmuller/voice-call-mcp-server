import { ConversationMessage } from '../types.js';

export interface CallTranscript {
    callSid: string;
    fromNumber: string;
    toNumber: string;
    callContext: string;
    startTime: Date;
    endTime?: Date;
    messages: ConversationMessage[];
    status: 'in_progress' | 'completed';
}

class TranscriptStoreService {
    private transcripts: Map<string, CallTranscript> = new Map();
    private latestCallSid: string | null = null;

    public startCall(callSid: string, fromNumber: string, toNumber: string, callContext: string): void {
        const transcript: CallTranscript = {
            callSid,
            fromNumber,
            toNumber,
            callContext,
            startTime: new Date(),
            messages: [],
            status: 'in_progress'
        };
        this.transcripts.set(callSid, transcript);
        this.latestCallSid = callSid;
    }

    public addMessage(callSid: string, role: 'user' | 'assistant', content: string): void {
        const transcript = this.transcripts.get(callSid);
        if (transcript) {
            transcript.messages.push({ role, content });
        }
    }

    public endCall(callSid: string): void {
        const transcript = this.transcripts.get(callSid);
        if (transcript) {
            transcript.endTime = new Date();
            transcript.status = 'completed';
        }
    }

    public getTranscript(callSid: string): CallTranscript | undefined {
        return this.transcripts.get(callSid);
    }

    public getLatestTranscript(): CallTranscript | undefined {
        if (this.latestCallSid) {
            return this.transcripts.get(this.latestCallSid);
        }
        return undefined;
    }

    public getAllTranscripts(): CallTranscript[] {
        return Array.from(this.transcripts.values()).sort(
            (a, b) => b.startTime.getTime() - a.startTime.getTime()
        );
    }

    public getRecentTranscripts(limit: number = 10): CallTranscript[] {
        return this.getAllTranscripts().slice(0, limit);
    }
}

// Singleton instance
export const transcriptStore = new TranscriptStoreService();
