import twilio from 'twilio';
import { CallInstance } from 'twilio/lib/rest/api/v2010/account/call.js';
import { DYNAMIC_API_SECRET, RECORD_CALLS } from '../../config/constants.js';

/**
 * Service for handling Twilio call operations
 */
export class TwilioCallService {
    private readonly twilioClient: twilio.Twilio;
    private callbackUrl: string = '';
    private readonly fromNumber: string;

    /**
     * Create a new Twilio call service
     * @param twilioClient The Twilio client
     * @param fromNumber The Twilio phone number to call from
     */
    constructor(twilioClient: twilio.Twilio, fromNumber: string) {
        this.twilioClient = twilioClient;
        this.fromNumber = fromNumber;
    }

    /**
     * Set the callback URL for Twilio webhooks
     * @param url The callback URL
     */
    public setCallbackUrl(url: string): void {
        this.callbackUrl = url;
    }

    /**
     * Get the current callback URL
     */
    public getCallbackUrl(): string {
        return this.callbackUrl;
    }

    /**
     * Get the from number
     */
    public getFromNumber(): string {
        return this.fromNumber;
    }

    /**
     * Start recording a call
     * @param callSid The SID of the call to record
     */
    public async startRecording(callSid: string): Promise<void> {
        if (!RECORD_CALLS || !callSid) {
            return;
        }

        try {
            await this.twilioClient.calls(callSid)
                .recordings
                .create();
        } catch (error) {
            console.error(`Failed to start recording for call ${callSid}:`, error);
        }
    }

    /**
     * End a call
     * @param callSid The SID of the call to end
     */
    public async endCall(callSid: string): Promise<void> {
        if (!callSid) {
            return;
        }

        try {
            await this.twilioClient.calls(callSid)
                .update({ status: 'completed' });
        } catch (error) {
            console.error(`Failed to end call ${callSid}:`, error);
        }
    }

    /**
     * Make an outbound call
     * @param toNumber The number to call
     * @param callContext Context for the call
     * @returns The Twilio call instance
     */
    public async makeCall(toNumber: string, callContext = ''): Promise<CallInstance> {
        if (!this.callbackUrl) {
            throw new Error('Callback URL not set');
        }

        try {
            const callContextEncoded = encodeURIComponent(callContext);

            const call = await this.twilioClient.calls.create({
                to: toNumber,
                from: this.fromNumber,
                url: `${this.callbackUrl}/call/outgoing?apiSecret=${DYNAMIC_API_SECRET}&callType=outgoing&callContext=${callContextEncoded}`,
            });

            return call;
        } catch (error) {
            console.error(`Error making call: ${error}`);
            throw error;
        }
    }
}
